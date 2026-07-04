import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, cpSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../core/logger";
// 冻结历史迁移：自带 yaml 解析（serialize codec 已收敛 json-only，不再提供 yaml 能力；同 053 模式）
import { parse as parseYaml } from "yaml";
import { stringifyWorkflowDoc } from "../core/workflow/serialize";
import { createNativeDbWorkflow } from "../core/workflow/workflows";

/**
 * file-yaml 轨退役（Step A3）：把存量用户目录工作流转成 native DB 行，
 * 为 Step B 删除 file 轨（目录扫描 + workflow.ts 动态 import）铺路。
 *
 * 两个来源（老用户目录工作流跑过 discover 后都有 source='file' 镜像行，行里存着 yaml_content）：
 *   ① DB 镜像行（source='file'）——**主路径**：直接从行内 yaml_content 转换，不依赖目录还在。
 *   ② 无镜像行的裸目录（从未被 discover 扫过的边缘情况）——目录扫描兜底。
 *
 * 处置规则（两来源一致）：
 *   - 纯 yaml（目录无 workflow.ts）：解析 → spec_json → 删旧镜像行 → 插 native 行。
 *     目录（如还在）在 afterCommit 备份至 _migrated-052/ 后删除（049 同手法）。
 *   - 含 workflow.ts：**无法自动迁移**（任意 TS 进不了 spec_json）→ 删镜像行（行只是目录的缓存投影，
 *     目录才是真相、原样保留）+ 显著告警指引 workflow create 重建。
 *   - 解析失败/畸形：删镜像行 + 告警，目录保留。
 *   - dev/ad-hoc 已被 049 转成 template（source=db），此处天然不匹配 source='file'，互不干扰。
 *
 * 顺序铁律（049 教训）：事务内只做 DB 写（读 fs 无副作用、安全）；
 * 备份+删目录等不可逆 fs 副作用放 afterCommit 闭包，事务回滚则不执行。
 * 幂等：重跑时 source='file' 行已消失、目录已搬走 → 扫描落空 → no-op。
 */

/** 函数式读 env（不用 index.ts 固化常量，便于测试用临时 AUTOPILOT_HOME）。 */
function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

interface FileRow {
  name: string;
  description: string | null;
  yaml_content: string | null;
  file_path: string | null;
}

export function up(db: Database): () => void {
  const home = autopilotHome();
  const wfRoot = join(home, "workflows");
  const migratedDirs: string[] = []; // afterCommit 要备份+删除的目录（绝对路径）
  const handled = new Set<string>(); // 已处理的工作流名（目录兜底扫描防重）

  /** 单个工作流的转换（yaml 文本 → native 行）。返回是否成功。 */
  const convert = (name: string, yamlText: string, sourceLabel: string): boolean => {
    let doc: Record<string, unknown> | null = null;
    try {
      doc = parseYaml(yamlText) as Record<string, unknown> | null;
    } catch (e: unknown) {
      log.warn("迁移 052：%s 的 yaml 解析失败（%s），跳过：%s", name, sourceLabel, e instanceof Error ? e.message : String(e));
      return false;
    }
    if (!doc || !Array.isArray(doc["phases"])) {
      log.warn("迁移 052：%s 的 yaml 缺 phases（%s），跳过", name, sourceLabel);
      return false;
    }
    const description = typeof doc["description"] === "string" ? (doc["description"] as string) : "";
    try {
      createNativeDbWorkflow({ name, description, spec_json: stringifyWorkflowDoc(doc, "json") });
      log.info("迁移 052：工作流 %s 已转 native DB 行（%s）", name, sourceLabel);
      return true;
    } catch (e: unknown) {
      log.warn("迁移 052：%s 转 native 失败（%s），跳过：%s", name, sourceLabel, e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const warnHasTs = (name: string): void => {
    log.warn(
      "迁移 052：工作流 %s 含自定义 workflow.ts，无法自动迁移为声明式；" +
        "file 轨退役后将不可用，请用 `autopilot workflow create` 按声明式重建（目录已原样保留）",
      name,
    );
  };

  // ── ① 主路径：source='file' 镜像行（行内 yaml_content 是真相投影） ──────────
  let fileRows: FileRow[] = [];
  try {
    fileRows = db
      .query<FileRow, []>("SELECT name, description, yaml_content, file_path FROM workflows WHERE source = 'file'")
      .all();
  } catch { /* 旧 schema 无 source 列（不应发生）：跳过主路径 */ }

  for (const row of fileRows) {
    handled.add(row.name);
    const dir = row.file_path && existsSync(row.file_path) ? row.file_path : join(wfRoot, row.name);
    const hasTs = existsSync(join(dir, "workflow.ts"));

    // 镜像行只是目录的缓存投影：无论成败都删（file 轨退役后是死行）；目录按规则处置
    db.run("DELETE FROM workflows WHERE name = ? AND source = 'file'", [row.name]);

    if (hasTs) {
      warnHasTs(row.name);
      continue; // 目录原样保留
    }
    // 行内 yaml 优先；行内为空退回读目录
    let yamlText = row.yaml_content ?? "";
    if (!yamlText && existsSync(join(dir, "workflow.yaml"))) {
      try { yamlText = readFileSync(join(dir, "workflow.yaml"), "utf-8"); } catch { /* 落空走告警 */ }
    }
    if (!yamlText) {
      log.warn("迁移 052：%s 镜像行无 yaml_content 且目录缺 workflow.yaml，跳过（目录保留）", row.name);
      continue;
    }
    if (convert(row.name, yamlText, "自 DB 镜像行") && existsSync(dir)) {
      migratedDirs.push(dir);
    }
  }

  // ── ② 兜底：无镜像行的裸目录（从未被 discover 扫过） ───────────────────────
  if (existsSync(wfRoot)) {
    let entries: string[] = [];
    try { entries = readdirSync(wfRoot); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.startsWith("_migrated")) continue; // 049/052 的备份目录
      const dir = join(wfRoot, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      const yamlPath = join(dir, "workflow.yaml");
      if (!existsSync(yamlPath)) continue;

      let doc: Record<string, unknown> | null = null;
      let raw = "";
      try {
        raw = readFileSync(yamlPath, "utf-8");
        doc = parseYaml(raw) as Record<string, unknown> | null;
      } catch { /* 解析失败下面告警 */ }
      const name = doc && typeof doc["name"] === "string" && doc["name"] ? (doc["name"] as string) : entry;
      if (handled.has(name)) continue; // ① 已处理

      if (existsSync(join(dir, "workflow.ts"))) {
        warnHasTs(name);
        continue;
      }
      const existing = db.query<{ name: string }, [string]>("SELECT name FROM workflows WHERE name = ?").get(name);
      if (existing) {
        log.info("迁移 052：DB 已有同名工作流 %s（非 file 镜像），跳过目录版本（目录保留）", name);
        continue;
      }
      if (convert(name, raw, "自目录扫描")) {
        migratedDirs.push(dir);
      }
    }
  }

  // ── afterCommit：备份 + 删已转换目录（不可逆 fs 副作用；回滚不执行） ────────
  return () => {
    const backupRoot = join(wfRoot, "_migrated-052");
    for (const dir of migratedDirs) {
      if (!existsSync(dir)) continue; // 已删（重跑）→ 跳过
      const base = dir.split(/[\\/]/).pop() ?? "wf";
      try {
        mkdirSync(backupRoot, { recursive: true });
        cpSync(dir, join(backupRoot, base), { recursive: true });
        rmSync(dir, { recursive: true, force: true });
        log.info("迁移 052：%s 原目录已备份至 workflows/_migrated-052/%s 并移除", base, base);
      } catch (e: unknown) {
        log.warn(
          "迁移 052：%s 目录清理失败（DB 已转 native、残留副本不影响功能）：%s",
          base,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  };
}
