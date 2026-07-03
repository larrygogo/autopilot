import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, cpSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../core/logger";
import { parseWorkflowText, stringifyWorkflowDoc } from "../core/workflow/serialize";
import { createNativeDbWorkflow } from "../core/workflow/workflows";

/**
 * file-yaml 轨退役（Step A3）：把存量用户目录工作流（AUTOPILOT_HOME/workflows/<name>/）
 * 救进 DB，为 Step B 删除 file 轨（目录扫描 + workflow.ts 动态 import）铺路。
 *
 * - 纯 yaml（无 workflow.ts）：解析 workflow.yaml → spec_json → 插 native DB 行。
 *   转换后目录备份至 _migrated-052/ 并删除（与 049 同手法）。
 * - 含 workflow.ts：**无法自动迁移**（任意 TS 进不了 spec_json）→ 跳过 + 显著告警，
 *   目录原样保留（用户资产）；file 轨退役后将不可用，指引用 workflow create 重建。
 * - DB 已有同名（任意 kind，含 049 种的 dev/ad-hoc）→ 跳过（防重/防撞名）。
 *
 * 顺序铁律（049 教训）：事务内只做 DB 写入（读 fs 无副作用、安全）；
 * 备份+删目录等不可逆 fs 副作用放 afterCommit 闭包，事务回滚则不执行。
 * 幂等：重跑时目录已被搬走 → 扫描落空 → no-op。
 */

/** 函数式读 env（不用 index.ts 固化常量，便于测试用临时 AUTOPILOT_HOME）。 */
function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

export function up(db: Database): () => void {
  const home = autopilotHome();
  const wfRoot = join(home, "workflows");
  const migrated: string[] = []; // afterCommit 要备份+删除的目录名
  if (!existsSync(wfRoot)) return () => {};

  let entries: string[] = [];
  try {
    entries = readdirSync(wfRoot);
  } catch {
    return () => {};
  }

  for (const entry of entries) {
    const dir = join(wfRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }
    if (entry.startsWith("_migrated")) continue; // 049/052 的备份目录
    const yamlPath = join(dir, "workflow.yaml");
    if (!existsSync(yamlPath)) continue;

    if (existsSync(join(dir, "workflow.ts"))) {
      log.warn(
        "迁移 052：工作流 %s 含自定义 workflow.ts，无法自动迁移为声明式；" +
          "file 轨退役后将不可用，请用 `autopilot workflow create` 按声明式重建（目录已原样保留）",
        entry,
      );
      continue;
    }

    let doc: Record<string, unknown> | null = null;
    try {
      doc = parseWorkflowText(readFileSync(yamlPath, "utf-8"), "yaml") as Record<string, unknown> | null;
    } catch (e: unknown) {
      log.warn("迁移 052：%s 的 workflow.yaml 解析失败，跳过（目录保留）：%s", entry, e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!doc || !Array.isArray(doc["phases"])) {
      log.warn("迁移 052：%s 的 workflow.yaml 缺 phases，跳过（目录保留）", entry);
      continue;
    }
    const name = typeof doc["name"] === "string" && doc["name"] ? (doc["name"] as string) : entry;

    const existing = db.query<{ name: string }, [string]>("SELECT name FROM workflows WHERE name = ?").get(name);
    if (existing) {
      log.info("迁移 052：DB 已有同名工作流 %s（kind 不限），跳过目录版本（目录保留）", name);
      continue;
    }

    // 事务内：纯 DB 写入。归一化（去 func 字段 / 声明层二态化）在 createNativeDbWorkflow 内统一做。
    const description = typeof doc["description"] === "string" ? (doc["description"] as string) : "";
    try {
      createNativeDbWorkflow({ name, description, spec_json: stringifyWorkflowDoc(doc, "json") });
      migrated.push(entry);
      log.info("迁移 052：目录工作流 %s 已转 native DB 行", name);
    } catch (e: unknown) {
      log.warn("迁移 052：%s 转 native 失败，跳过（目录保留）：%s", name, e instanceof Error ? e.message : String(e));
    }
  }

  // afterCommit：备份 + 删已转换目录（不可逆 fs 副作用，commit 成功后才执行；回滚不执行）
  return () => {
    const backupRoot = join(wfRoot, "_migrated-052");
    for (const entry of migrated) {
      const dir = join(wfRoot, entry);
      if (!existsSync(dir)) continue; // 已删（重跑）→ 跳过
      try {
        mkdirSync(backupRoot, { recursive: true });
        cpSync(dir, join(backupRoot, entry), { recursive: true });
        rmSync(dir, { recursive: true, force: true });
        log.info("迁移 052：%s 原目录已备份至 workflows/_migrated-052/%s 并移除", entry, entry);
      } catch (e: unknown) {
        log.warn(
          "迁移 052：%s 目录清理失败（DB 已转 native、残留副本会被 discover 忽略）：%s",
          entry,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  };
}
