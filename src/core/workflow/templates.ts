/**
 * 工作流模板管理：从编译期内联常量读取 examples/workflows/* 数据，让用户从内置模板克隆出自己的工作流。
 *
 * - 模板源：src/generated/_examples.ts（由 scripts/gen-examples-index.ts 生成，编译期嵌入）
 * - 克隆 = DB 种植（读常量 doc → createNativeDbWorkflow）
 * - file 轨（磁盘目录拷贝）已退役（1f6d278 + P1），相关死码已清理
 * - 磁盘扫描已于阶段 1 移除，数据源切为静态常量（零运行时 fs 依赖）
 */

import { getWorkflowFromDb, createTemplateDbWorkflow, createNativeDbWorkflow, createDbWorkflow, updateDbWorkflow } from "./workflows";
import { stringifyWorkflowDoc } from "./serialize";
import { EXAMPLE_TEMPLATES, EXAMPLE_TS_ONLY } from "../../generated/_examples";

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

/** 按名字查 example 模板（未找到 → null）。 */
function findExample(name: string): { doc: Record<string, unknown>; revision: number } | null {
  const t = EXAMPLE_TEMPLATES.find((e) => e.name === name);
  return t ? { doc: t.doc, revision: t.revision } : null;
}

/** 是否是仅含 workflow.ts 的模板（非声明式，不能种成 native/template）。 */
function exampleHasTs(name: string): boolean {
  return EXAMPLE_TS_ONLY.includes(name);
}

/**
 * 列出所有可用模板（来自编译期内联常量）。
 */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  const result: WorkflowTemplate[] = [];

  for (const t of EXAMPLE_TEMPLATES) {
    const doc = t.doc;
    const label = typeof doc["label"] === "string" && (doc["label"] as string).trim()
      ? (doc["label"] as string).trim()
      : undefined;
    const description = typeof doc["description"] === "string" ? (doc["description"] as string) : "";
    const phases = Array.isArray(doc["phases"]) ? (doc["phases"] as unknown[]) : [];
    const agents = Array.isArray(doc["agents"]) ? (doc["agents"] as unknown[]) : [];
    result.push({
      name: t.name,
      label,
      description,
      phase_count: phases.length,
      agent_count: agents.length,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * 读编译期常量 <name> 转成「native 模板 spec」（待写的 spec_json + 描述 + revision）。
 * **纯转换**：不写库、不碰家目录——供 seedTemplateWorkflow（init 种子）/ migration 049（存量 file
 * 副本转 native）/ reseedTemplateWorkflow（拉 repo fix 刷新）三处共用，杜绝各处重复 JSON 解析。
 * 归一化（去 func 字段 / 结构校验）在 createTemplateDbWorkflow 写库时统一做，这里只产原始 spec_json。
 * 返回 null：常量中无该名 / 含 workflow.ts（含 ts 非声明式，不能当 native）/ phases 畸形。
 */
export function buildTemplateSpecFromExamples(
  name: string,
): { description: string; specJson: string; revision: number } | null {
  if (exampleHasTs(name)) return null;
  const example = findExample(name);
  if (!example) return null;
  const doc = example.doc;
  if (!doc || !Array.isArray(doc["phases"])) return null;
  const description = typeof doc["description"] === "string" ? (doc["description"] as string) : "";
  return { description, specJson: stringifyWorkflowDoc(doc, "json"), revision: example.revision };
}

export function seedTemplateWorkflow(name: string): "seeded" | "exists" | "no-template" | "has-ts" {
  if (getWorkflowFromDb(name)) return "exists";
  if (exampleHasTs(name)) return "has-ts";
  const spec = buildTemplateSpecFromExamples(name);
  if (!spec) return "no-template";
  createTemplateDbWorkflow({ name, description: spec.description, spec_json: spec.specJson });
  return "seeded";
}

/**
 * 从内置模板克隆出可编辑的工作流（DB 种植）。
 * - 读编译期常量 <template> 的 doc
 * - 深拷贝 doc，doc.name 改为 targetName（避免污染共享常量对象）
 * - createNativeDbWorkflow 写 DB
 * - 调用方负责重启 discover 让 registry 重新加载
 */
export function cloneTemplate(template: string, targetName: string): void {
  const example = findExample(template);
  if (!example) {
    const available = EXAMPLE_TEMPLATES.map((t) => t.name);
    throw new Error(`模板 "${template}" 不存在。已有模板：${available.join(", ") || "(无)"}`);
  }

  if (getWorkflowFromDb(targetName)) {
    throw new Error("target workflow already exists");
  }

  // 深拷贝，避免污染共享常量
  const doc = JSON.parse(JSON.stringify(example.doc)) as Record<string, unknown>;
  doc["name"] = targetName;
  const description = typeof doc["description"] === "string" ? (doc["description"] as string) : "";
  createNativeDbWorkflow({ name: targetName, description, spec_json: stringifyWorkflowDoc(doc, "json") });
}

/**
 * 从用户已有的工作流克隆为新工作流（DB 层克隆）。
 *
 * 跟 cloneTemplate 的区别：
 *   - cloneTemplate 的源在编译期常量（内置模板，只读）
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
    const clonedSpec = stringifyWorkflowDoc(doc, "json");
    createDbWorkflow({ name: targetName, description: row.description, derives_from: row.derives_from, spec_json: clonedSpec });
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

/**
 * 内置模板的 revision 现状：DB native/template 行的 spec_json revision（local）vs 编译期常量 revision（template）。
 * 非 DB 模板（file 副本 / 不存在）→ null。给 CLI sync 展示「旧→新」+ 判是否需刷新。
 */
export function templateRevisionStatus(name: string): { local: number; template: number } | null {
  const row = getWorkflowFromDb(name);
  if (!row || row.source !== "db" || (row.kind !== "template" && row.kind !== "native")) return null;
  const templateRevision = findExample(name)?.revision ?? 0;
  const local = row.spec_json ? parseSpecRevision(row.spec_json) : 0;
  return { local, template: templateRevision };
}

/**
 * native 化后「拉 repo 最新 fix」的等价替身（file 覆盖语义对 DB 工作流失效）：按 template_revision
 * 比对，编译期常量更高才用其最新 spec 覆盖 DB 行（updateDbWorkflow 归一化 + 重派生 spec_json）。
 * 只对 DB native/template 行生效；用户克隆体是别的 name、不受波及。
 * 返回：'reseeded'（已更新）| 'up-to-date'（DB ≥ 常量）| 'not-template'（非 DB 模板）| 'no-template'（常量无）。
 */
export function reseedTemplateWorkflow(name: string): "reseeded" | "up-to-date" | "not-template" | "no-template" {
  const row = getWorkflowFromDb(name);
  if (!row || row.source !== "db" || (row.kind !== "template" && row.kind !== "native")) return "not-template";
  const spec = buildTemplateSpecFromExamples(name);
  if (!spec) return "no-template";
  const local = row.spec_json ? parseSpecRevision(row.spec_json) : 0;
  if (spec.revision <= local) return "up-to-date";
  // 常量更新 → 覆盖。P2 后：updateDbWorkflow 接 spec_json（JSON 文本），内部对 native/template 归一化。
  updateDbWorkflow(name, {
    description: spec.description,
    spec_json: spec.specJson,
  });
  return "reseeded";
}

/**
 * 列出所有「DB native/template 副本落后内置模板」的工作流（template_revision 比对）。
 * P1 后：只查 DB 行（磁盘 file 副本路径已删）。
 * daemon 启动 / doctor 跑一次，把「副本该同步了」从「每个 git 任务无条件 warn」收敛成「真落后才提示」。
 */
export function listOutdatedWorkflowCopies(): Array<{ name: string; local: number; template: number }> {
  const out: Array<{ name: string; local: number; template: number }> = [];
  for (const t of EXAMPLE_TEMPLATES) {
    const templateRevision = t.revision;
    try {
      const row = getWorkflowFromDb(t.name);
      if (row && row.source === "db" && (row.kind === "template" || row.kind === "native") && row.spec_json) {
        const local = parseSpecRevision(row.spec_json);
        if (templateRevision > local) out.push({ name: t.name, local, template: templateRevision });
      }
    } catch {
      /* db 不可用 → 跳过 */
    }
  }
  return out;
}
