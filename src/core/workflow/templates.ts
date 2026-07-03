/**
 * 工作流模板管理：扫描 examples/workflows/* 目录，让用户从内置模板克隆出自己的工作流。
 *
 * - 模板源：项目仓库内 `examples/workflows/<name>/` 目录（P1 后统一 workflow.json）
 * - 克隆 = DB 种植（读 examples workflow.json → createNativeDbWorkflow）
 * - file 轨（磁盘目录拷贝）已退役（1f6d278 + P1），相关死码已清理
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getWorkflowFromDb, createTemplateDbWorkflow, createNativeDbWorkflow, createDbWorkflow, updateDbWorkflow } from "./workflows";
import { stringifyWorkflowDoc } from "./serialize";

export interface WorkflowTemplate {
  /** 模板名（目录名，如 "dev"） */
  name: string;
  /** 来自 workflow.json 的 label（显示名），未填则前端回退到 name */
  label?: string;
  /** 来自 workflow.json 的 description */
  description: string;
  /** phases 数量 */
  phase_count: number;
  /** agents 数量 */
  agent_count: number;
}

/**
 * 找仓库内的 examples/workflows 根目录。
 * 优先用 bin/autopilot.ts 所在仓库路径（CWD / process.argv[1] 推断）；
 * 失败则尝试相对当前文件位置回溯。
 */
function findExamplesRoot(): string | null {
  // 从当前模块出发：src/core/workflow/templates.ts → ../../../examples/workflows
  const candidates = [
    join(import.meta.dir, "..", "..", "..", "examples", "workflows"),
    join(process.cwd(), "examples", "workflows"),
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

/**
 * 列出所有可用模板（扫 examples/workflows/<name>/workflow.json）。
 * 没有 workflow.json 的目录被跳过（如 README.md）。
 */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  const root = findExamplesRoot();
  if (!root) return [];

  const result: WorkflowTemplate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const jsonPath = join(dir, "workflow.json");
    if (!existsSync(jsonPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      const label = typeof parsed.label === "string" && parsed.label.trim()
        ? parsed.label.trim()
        : undefined;
      const description = typeof parsed.description === "string" ? parsed.description : "";
      const phases = Array.isArray(parsed.phases) ? parsed.phases : [];
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      result.push({
        name: entry,
        label,
        description,
        phase_count: phases.length,
        agent_count: agents.length,
      });
    } catch {
      // JSON 解析失败的模板跳过；不阻塞其他模板
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** 在 root 下列出可用模板目录名（含 workflow.json 的）。给错误信息当 hint。 */
function availableTemplates(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((entry) => {
        const dir = join(root, entry);
        return statSync(dir).isDirectory() && existsSync(join(dir, "workflow.json"));
      });
  } catch { return []; }
}

/**
 * 读 examples/<name>/workflow.json 转成「native 模板 spec」（待写的 spec_json + 描述 + revision）。
 * **纯转换**：不写库、不碰家目录——供 seedTemplateWorkflow（init 种子）/ migration 049（存量 file
 * 副本转 native）/ reseedTemplateWorkflow（拉 repo fix 刷新）三处共用，杜绝各处重复 JSON 解析。
 * 归一化（去 func 字段 / 结构校验）在 createTemplateDbWorkflow 写库时统一做，这里只产原始 spec_json。
 * 返回 null：examples 根不存在 / 缺 workflow.json / 含 workflow.ts（含 ts 非声明式，不能当 native）/ phases 畸形。
 * P1 双格式兼容（json 优先、yaml 兜底）已简化：yaml 文件已删，只读 json。
 */
export function buildTemplateSpecFromExamples(
  name: string,
): { description: string; specJson: string; revision: number } | null {
  const root = findExamplesRoot();
  if (!root) return null;
  if (existsSync(join(root, name, "workflow.ts"))) return null;
  const jsonPath = join(root, name, "workflow.json");
  if (!existsSync(jsonPath)) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc["phases"])) return null;
  const description = typeof doc["description"] === "string" ? doc["description"] : "";
  const revision = typeof doc["template_revision"] === "number" ? (doc["template_revision"] as number) : 0;
  return { description, specJson: stringifyWorkflowDoc(doc, "json"), revision };
}

export function seedTemplateWorkflow(name: string): "seeded" | "exists" | "no-template" | "has-ts" {
  if (getWorkflowFromDb(name)) return "exists";
  const root = findExamplesRoot();
  if (!root) return "no-template";
  // L6 守卫：含 workflow.ts 的模板不是声明式，种成 native/template 会被 declarative 闸门拒、组装失败
  if (existsSync(join(root, name, "workflow.ts"))) return "has-ts";
  const spec = buildTemplateSpecFromExamples(name);
  if (!spec) return "no-template";
  createTemplateDbWorkflow({ name, description: spec.description, spec_json: spec.specJson });
  return "seeded";
}

/**
 * 从内置模板克隆出可编辑的工作流（DB 种植）。
 * - 读 examples/workflows/<template>/workflow.json
 * - doc.name 改为 targetName
 * - createNativeDbWorkflow 写 DB
 * - 调用方负责重启 discover 让 registry 重新加载
 */
export function cloneTemplate(template: string, targetName: string): void {
  const root = findExamplesRoot();
  if (!root) throw new Error(`找不到 examples/workflows 根目录（cwd=${process.cwd()}）。确保仓库结构完整`);
  const srcDir = join(root, template);
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`模板 "${template}" 不存在：${srcDir}。已有模板：${availableTemplates(root).join(", ") || "(无)"}`);
  }
  const jsonPath = join(srcDir, "workflow.json");
  if (!existsSync(jsonPath)) {
    throw new Error(`模板 "${template}" 缺 workflow.json：${srcDir}`);
  }

  if (getWorkflowFromDb(targetName)) {
    throw new Error("target workflow already exists");
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`解析模板 ${template}/workflow.json 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 把 name 改为 targetName，再种植到 DB
  doc["name"] = targetName;
  const description = typeof doc["description"] === "string" ? doc["description"] : "";
  createNativeDbWorkflow({ name: targetName, description, spec_json: stringifyWorkflowDoc(doc, "json") });
}

/**
 * 从用户已有的工作流克隆为新工作流（DB 层克隆）。
 *
 * 跟 cloneTemplate 的区别：
 *   - cloneTemplate 的源在仓库内 `examples/workflows/`（只读、只能克隆内置模板）
 *   - cloneWorkflow 的源在 DB（含用户修改过的内容、自己创建的工作流）
 *
 * file 轨退役后（P1），磁盘目录克隆路径已删。所有工作流均在 DB。
 */
export function cloneWorkflow(sourceName: string, targetName: string): void {
  if (!/^[\w.\-]+$/.test(targetName)) {
    throw new Error("target name 只允许字母 / 数字 / . _ -");
  }
  if (getWorkflowFromDb(targetName)) {
    throw new Error("target workflow already exists");
  }
  const row = getWorkflowFromDb(sourceName);
  if (!row) throw new Error("source workflow not found");
  if ((row.kind === "native" || row.kind === "template") && row.spec_json) {
    // 克隆出 native（可编辑）；内层 name 归一为 targetName
    const doc = JSON.parse(row.spec_json) as Record<string, unknown>;
    doc["name"] = targetName;
    createNativeDbWorkflow({ name: targetName, description: row.description, spec_json: stringifyWorkflowDoc(doc, "json") });
  } else if (row.kind === "derived" && row.derives_from) {
    const doc = JSON.parse(row.spec_json ?? "{}") as Record<string, unknown>;
    doc["name"] = targetName;
    createDbWorkflow({ name: targetName, description: row.description, derives_from: row.derives_from, yaml_content: row.yaml_content });
  } else {
    throw new Error("source workflow not found");
  }
}

// ──────────────────────────────────────────────
// template_revision 比对工具
// ──────────────────────────────────────────────

/**
 * 从 spec_json（DB native/template 行的真相）取顶层 template_revision（缺失 / 解析失败 → 0）。
 */
export function parseSpecRevision(specJson: string): number {
  try {
    const o = JSON.parse(specJson) as { template_revision?: unknown };
    return typeof o.template_revision === "number" ? o.template_revision : 0;
  } catch {
    return 0;
  }
}

/**
 * 从 JSON 字符串（workflow.json 内容）取顶层 `template_revision`（缺失 / 解析失败 → 0）。
 * P1 后：examples 均为 workflow.json，revision 是 JSON 数字字段，直接 JSON.parse 取。
 * 注：P2 前保留 parseSpecRevision 作为主力；此函数供 template-revision.test.ts + 兼容层使用。
 */
export function parseTemplateRevision(jsonContent: string): number {
  return parseSpecRevision(jsonContent);
}

/** 读 examples/<name>/workflow.json 顶层 `template_revision`（文件不存在 / 读失败 → 0）。 */
function readTemplateRevision(jsonPath: string): number {
  try {
    const content = readFileSync(jsonPath, "utf-8");
    return parseSpecRevision(content);
  } catch {
    return 0;
  }
}

/**
 * 内置模板的 revision 现状：DB native/template 行的 spec_json revision（local）vs examples revision（template）。
 * 非 DB 模板（file 副本 / 不存在）→ null。给 CLI sync 展示「旧→新」+ 判是否需刷新。
 */
export function templateRevisionStatus(name: string): { local: number; template: number } | null {
  const row = getWorkflowFromDb(name);
  if (!row || row.source !== "db" || (row.kind !== "template" && row.kind !== "native")) return null;
  const root = findExamplesRoot();
  if (!root) return null;
  const template = readTemplateRevision(join(root, name, "workflow.json"));
  const local = row.spec_json ? parseSpecRevision(row.spec_json) : 0;
  return { local, template };
}

/**
 * native 化后「拉 repo 最新 fix」的等价替身（file 覆盖语义对 DB 工作流失效）：按 template_revision
 * 比对，examples 更高才用其最新 spec 覆盖 DB 行（updateDbWorkflow 归一化 + 重派生 spec_json）。
 * 只对 DB native/template 行生效；用户克隆体是别的 name、不受波及。
 * 返回：'reseeded'（已更新）| 'up-to-date'（DB ≥ examples）| 'not-template'（非 DB 模板）| 'no-template'（examples 无）。
 */
export function reseedTemplateWorkflow(name: string): "reseeded" | "up-to-date" | "not-template" | "no-template" {
  const row = getWorkflowFromDb(name);
  if (!row || row.source !== "db" || (row.kind !== "template" && row.kind !== "native")) return "not-template";
  const spec = buildTemplateSpecFromExamples(name);
  if (!spec) return "no-template";
  const local = row.spec_json ? parseSpecRevision(row.spec_json) : 0;
  if (spec.revision <= local) return "up-to-date";
  // examples 更新 → 覆盖。updateDbWorkflow 接 yaml_content，内部对 native/template 归一化 + 重派生 spec_json。
  updateDbWorkflow(name, {
    description: spec.description,
    yaml_content: stringifyWorkflowDoc(JSON.parse(spec.specJson) as Record<string, unknown>, "yaml"),
  });
  return "reseeded";
}

/**
 * 列出所有「DB native/template 副本落后内置模板」的工作流（template_revision 比对）。
 * P1 后：只查 DB 行（磁盘 file 副本路径已删）。
 * daemon 启动 / doctor 跑一次，把「副本该同步了」从「每个 git 任务无条件 warn」收敛成「真落后才提示」。
 */
export function listOutdatedWorkflowCopies(): Array<{ name: string; local: number; template: number }> {
  const root = findExamplesRoot();
  if (!root) return [];
  const out: Array<{ name: string; local: number; template: number }> = [];
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => existsSync(join(root, n, "workflow.json")));
  } catch {
    return [];
  }
  for (const name of names) {
    const template = readTemplateRevision(join(root, name, "workflow.json"));
    // 查 DB native/template 行（P1 后的形态；file 行视为不在管控范围）。
    try {
      const row = getWorkflowFromDb(name);
      if (row && row.source === "db" && (row.kind === "template" || row.kind === "native") && row.spec_json) {
        const local = parseSpecRevision(row.spec_json);
        if (template > local) out.push({ name, local, template });
      }
    } catch {
      /* db 不可用 → 跳过 */
    }
  }
  return out;
}
