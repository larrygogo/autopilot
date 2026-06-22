import type { Database } from "bun:sqlite";
import { existsSync, cpSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../core/logger";
import { buildTemplateSpecFromExamples } from "../core/workflow/templates";
import { createTemplateDbWorkflow } from "../core/workflow/workflows";

/**
 * 把框架内置产品工作流 dev / ad-hoc 从「file 磁盘副本」就地转成「native(template) DB 行」，
 * 让用户视角彻底无 yaml —— spec_json 是真相、零 ts。examples/ 里这俩早已零 ts、纯声明式
 * （submit_pr=deliver:pr、四个 agent 阶段纯提示词 + decision:tool），转换无损。
 *
 * 背景：新装机 init 走 seedTemplateWorkflow 已直接种 native；但**老用户**家目录有 file 副本，
 * seedTemplateWorkflow 检测到磁盘副本即 skip，故一直停留 file 形态、看得到 yaml。本迁移补这一跳。
 *
 * 顺序铁律（必须「先转 DB 行、再删文件」）：
 *   ① 事务内删旧行 + 插 native(template)（source=db）——此后 deleteOrphanFileWorkflows 只删
 *      source='file' 的行、不会误删这俩；syncFileWorkflowsToDb 遇磁盘同名副本（DB 已 source=db）
 *      log.warn 忽略不抛错。双保险，删文件绝不会反噬。
 *   ② best-effort 备份家目录副本到 _migrated-049/（下划线前缀，discover 自动跳过、不成幽灵 file 行），
 *      再删原目录。失败只 warn 不阻塞启动（残留副本被 ① 的双保险忽略，功能不受影响）。
 *
 * 边界：只动 repo examples 真有的 dev / ad-hoc；用户自建 file 工作流（dev-kimi 等）完全不碰。
 * 幂等：重跑按 examples 覆盖这俩 native 行，无害。
 */
const PRODUCT_TEMPLATES = ["dev", "ad-hoc"] as const;

/** 函数式读 env（不用 index.ts 的固化常量，便于测试用临时 AUTOPILOT_HOME）。 */
function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

export function up(db: Database): void {
  const home = autopilotHome();
  const backupRoot = join(home, "workflows", "_migrated-049");

  for (const name of PRODUCT_TEMPLATES) {
    const spec = buildTemplateSpecFromExamples(name);
    if (!spec) {
      // examples 缺该模板 / 含 ts（不应发生：repo 内置）→ 跳过，不动存量
      log.warn("迁移 049：examples 无可转 native 的 %s（缺模板或含 ts），跳过", name);
      continue;
    }

    // ① 先转 DB 行（事务内、必成）：删任意旧同名行 → 插 native(template)。
    //    createTemplateDbWorkflow 内部对已存在同名抛错，故先 DELETE。归一化在其内统一做，
    //    与 init seedTemplateWorkflow 字节一致（reseed 的 revision 比对才可靠）。
    db.run("DELETE FROM workflows WHERE name = ?", [name]);
    createTemplateDbWorkflow({ name, description: spec.description, spec_json: spec.specJson });

    // ② 再 best-effort 备份 + 删家目录物理副本（铁律：DB 已 source=db，删文件不会被 discover 反噬）。
    const localDir = join(home, "workflows", name);
    if (existsSync(localDir)) {
      try {
        mkdirSync(backupRoot, { recursive: true });
        cpSync(localDir, join(backupRoot, name), { recursive: true });
        rmSync(localDir, { recursive: true, force: true });
        log.info("迁移 049：%s 已转 native，原副本备份至 ~/.autopilot/workflows/_migrated-049/%s", name, name);
      } catch (e: unknown) {
        log.warn(
          "迁移 049：%s 家目录副本清理失败（DB 已转 native、残留副本会被 discover 忽略，不影响功能）：%s",
          name,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
}
