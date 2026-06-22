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
 * 顺序铁律 + 事务安全（关键教训）：
 *   ① **事务内只做纯 DB 转换**（删旧行 + 插 native(template)，source=db）——回滚安全、无副作用。
 *      此后 deleteOrphanFileWorkflows 只删 source='file' 不误删这俩；syncFileWorkflowsToDb 遇磁盘
 *      同名副本（DB 已 source=db）log.warn 忽略不抛错。双保险，删文件不会被 discover 反噬。
 *   ② **删文件放 afterCommit 闭包（事务外）**：up 返回它，migrate.ts 在事务 commit 成功后才执行。
 *      若事务回滚（如与 daemon 锁冲突），闭包根本不被调用 → 文件绝不会在 DB 未转时被删，杜绝
 *      「DB 还是 file 行但磁盘已删」的不一致（早期把 fs 放事务内，回滚后留下坏状态、dev 从 registry
 *      消失——本迁移就是这条教训的来源）。清理本身 best-effort（失败只 warn，残留被 ① 的双保险忽略）。
 *
 * 边界：只动 repo examples 真有的 dev / ad-hoc；用户自建 file 工作流（dev-kimi 等）完全不碰。
 * 幂等：重跑按 examples 覆盖这俩 native 行，无害。
 */
const PRODUCT_TEMPLATES = ["dev", "ad-hoc"] as const;

/** 函数式读 env（不用 index.ts 的固化常量，便于测试用临时 AUTOPILOT_HOME）。 */
function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

export function up(db: Database): () => void {
  const home = autopilotHome();
  const toClean: string[] = [];

  for (const name of PRODUCT_TEMPLATES) {
    const spec = buildTemplateSpecFromExamples(name);
    if (!spec) {
      // examples 缺该模板 / 含 ts（不应发生：repo 内置）→ 跳过，不动存量
      log.warn("迁移 049：examples 无可转 native 的 %s（缺模板或含 ts），跳过", name);
      continue;
    }

    // ① 事务内：纯 DB 转换。删任意旧同名行 → 插 native(template)。createTemplateDbWorkflow 内部对
    //    已存在同名抛错，故先 DELETE。归一化在其内统一做，与 init seedTemplateWorkflow 字节一致
    //    （reseed 的 revision 比对才可靠）。
    db.run("DELETE FROM workflows WHERE name = ?", [name]);
    createTemplateDbWorkflow({ name, description: spec.description, spec_json: spec.specJson });

    if (existsSync(join(home, "workflows", name))) toClean.push(name);
  }

  // ② 事务后副作用：备份 + 删家目录物理副本。事务 commit 成功后由 migrate.ts 调用；回滚则不执行。
  return () => {
    const backupRoot = join(home, "workflows", "_migrated-049");
    for (const name of toClean) {
      const localDir = join(home, "workflows", name);
      if (!existsSync(localDir)) continue; // 已删（重跑）→ 跳过
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
  };
}
