import { existsSync, readFileSync, writeFileSync } from "fs";
import { parseDocument, isMap } from "yaml";

/**
 * 在 yaml 文档里写嵌套键 doc[parentKey][childKey]=value，但**容错 parent 不是 map** 的情况：
 * 若 parentKey 已存在却是 null 标量 / 字符串（如 `requires:` 空、`requires: optional` 等被写坏的状态），
 * 直接 `setIn([parentKey, childKey])` 会抛「Expected YAML collection at parentKey」。这里先整体替换成
 * 只含该子键的 map（workflow 级 requires/sandbox 只含 git，替换无损），杜绝保存声明时崩。
 */
function setNestedSafe(doc: ReturnType<typeof parseDocument>, parentKey: string, childKey: string, value: unknown): void {
  const parent = doc.getIn([parentKey], true); // keepScalar：拿到 Node（含 null/字符串标量）
  if (parent != null && !isMap(parent)) {
    doc.setIn([parentKey], { [childKey]: value });
    return;
  }
  doc.setIn([parentKey, childKey], value);
}

/**
 * 删嵌套键 doc[parentKey][childKey]，容错 parent 不是 map 或**根本不存在**：
 * yaml 的 `deleteIn([parentKey, childKey])` 在 parentKey 缺失 / 非 collection 时也抛
 * 「Expected YAML collection at parentKey」（不是无声 no-op）。这是用户「跟随默认（requiresGit=null）」
 * 保存崩的真凶——dev 根本没 requires 键，删它的 git 子键就炸。
 * 这里：parent 是 map → 删子键；否则（缺失 / 非 map）→ 删整个 parent 键（缺失则无声 no-op）。
 */
function deleteNestedSafe(doc: ReturnType<typeof parseDocument>, parentKey: string, childKey: string): void {
  if (isMap(doc.getIn([parentKey], true))) {
    doc.deleteIn([parentKey, childKey]);
  } else {
    doc.deleteIn([parentKey]); // 缺失 → no-op（返回 false 不抛）；非 map 坏状态 → 整删
  }
}
import {
  getWorkflowYamlPath,
  isParallelInput,
  reload,
  type PhaseEntryInput,
  type PhaseInput,
  type ParallelPhaseInput,
} from "./registry";

/**
 * 工作流 phases / meta 的 YAML 编辑（authoring）——从 registry.ts 拆出的叶子模块。
 *
 * 「编辑用户 workflow.yaml 的 phases 数组 / meta 字段」这一与工作流注册/运行无关的关注点：
 * collectPhaseNames / setWorkflowPhases / patchWorkflowMetaYaml / setWorkflowMeta + 清洗私有。
 * Web 工作流编辑器经 rpc 调用。依赖 registry 的只读接口（getWorkflowYamlPath/isParallelInput/
 * reload）；registry 不依赖本模块 → 干净 DAG 无回环。
 */

/** 合法 phase 名（小写字母开头 + 小写字母/数字/下划线）。 */
const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 提取 phases 中所有（含 parallel 内）阶段的 name。
 */
export function collectPhaseNames(phases: PhaseEntryInput[]): string[] {
  const names: string[] = [];
  for (const p of phases) {
    if (isParallelInput(p)) {
      for (const sub of p.parallel.phases ?? []) names.push(sub.name);
    } else {
      names.push(p.name);
    }
  }
  return names;
}

/**
 * 结构化校验 + 把 phases 段写进一段 yaml 文本（保留其他字段与注释），返回新 yaml 文本。
 * 纯函数、不碰磁盘/DB —— file 来源与 db 来源共用（file 读写文件、db 读写 yaml_content）。
 */
export function applyPhasesToYaml(rawYaml: string, phases: PhaseEntryInput[]): string {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error(`phases 不能为空数组（至少一个阶段）`);
  }

  // 1. 校验
  const seen = new Set<string>();
  const allNames = new Set<string>();
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (isParallelInput(p)) {
      if (!p.parallel.name || !PHASE_NAME_RE.test(p.parallel.name)) {
        throw new Error(`第 ${i + 1} 项 parallel 名称非法：${p.parallel.name}`);
      }
      if (!Array.isArray(p.parallel.phases) || p.parallel.phases.length === 0) {
        throw new Error(`parallel "${p.parallel.name}" 内部 phases 不能为空`);
      }
      if (seen.has(p.parallel.name)) throw new Error(`阶段名重复：${p.parallel.name}`);
      seen.add(p.parallel.name);
      allNames.add(p.parallel.name);
      for (const sub of p.parallel.phases) {
        if (!PHASE_NAME_RE.test(sub.name)) throw new Error(`阶段名非法：${sub.name}`);
        if (allNames.has(sub.name)) throw new Error(`阶段名重复：${sub.name}`);
        allNames.add(sub.name);
      }
    } else {
      if (!PHASE_NAME_RE.test(p.name)) throw new Error(`阶段名非法：${p.name}`);
      if (seen.has(p.name)) throw new Error(`阶段名重复：${p.name}`);
      seen.add(p.name);
      allNames.add(p.name);
    }
  }

  // 2. reject 必须指向当前阶段之前的某个阶段（仅支持往回跳）
  const orderedNames: string[] = [];
  for (const p of phases) {
    const myName = isParallelInput(p) ? p.parallel.name : p.name;
    if (!isParallelInput(p) && p.reject) {
      if (!orderedNames.includes(p.reject)) {
        throw new Error(`阶段 "${p.name}" 的 reject 目标 "${p.reject}" 不存在或在其后；驳回只能往回跳`);
      }
    }
    orderedNames.push(myName);
  }

  // 3. 写入 yaml Document（保留其他段、注释）
  const doc = parseDocument(rawYaml);
  // 清洗 undefined / null / 空串 避免脏字段
  const cleaned = phases.map((p) => cleanPhaseEntry(p));
  doc.setIn(["phases"], cleaned);
  return doc.toString();
}

/**
 * 结构化校验 + 写入 file 来源工作流的 phases 段。保留 YAML 中的其他字段与注释。
 * 不自动调用 reload —— 调用方负责。db 来源工作流由调用方用 applyPhasesToYaml + updateDbWorkflow 处理。
 */
export function setWorkflowPhases(workflowName: string, phases: PhaseEntryInput[]): void {
  const yamlPath = getWorkflowYamlPath(workflowName);
  if (!existsSync(yamlPath)) throw new Error(`工作流不存在：${workflowName}`);
  const raw = readFileSync(yamlPath, "utf-8");
  writeFileSync(yamlPath, applyPhasesToYaml(raw, phases), "utf-8");
}

/**
 * 工作流元信息（label / description）。name 是标识符（目录名 + tasks.workflow /
 * requirements.workflow 引用键），不在可改范围内——改名等于新建工作流。
 */
export interface WorkflowMetaInput {
  /** 显示名；null / 空串 = 删除该字段（UI 回退显示 name） */
  label?: string | null;
  /** 描述；null / 空串 = 删除该字段 */
  description?: string | null;
  /**
   * 声明层输入闸门 requires.git：true（需要代码库）/ false（不需要）显式写键；null = 删键
   * （回退缺省派生自 sandbox.git）。undefined = 不动。（2026-06-22：optional 第三态废弃，二态。）
   */
  requiresGit?: boolean | null;
  // 注：① sandbox.git（建 git 沙盒）不再由 meta 编辑——它从 requires.git 派生（registry
  //   getWorkflowGitSandbox：需要代码库 → 一定 clone）。② 产出形态 delivers 从 phase 派生
  //   （deriveDelivers）。两者都不是用户输入，故 WorkflowMetaInput 只剩 label/description/requiresGit。
}

/**
 * 删除嵌套键后，若父 map 已空则一并删除（保持 yaml 不留 `requires: {}` 空壳）。
 */
function pruneEmptyMap(doc: ReturnType<typeof parseDocument>, key: string): void {
  const node = doc.getIn([key]) as { items?: unknown[] } | undefined;
  if (node && typeof node === "object" && Array.isArray(node.items) && node.items.length === 0) {
    doc.deleteIn([key]);
  }
}

/**
 * 在 yaml 原文上手术式修改 label / description + 声明层（requires.git / sandbox.git /
 * delivers）（Document API，保留注释与其他段）。纯函数：file 来源与 db 来源共用。
 */
export function patchWorkflowMetaYaml(raw: string, meta: WorkflowMetaInput): string {
  const doc = parseDocument(raw);
  for (const key of ["label", "description"] as const) {
    const v = meta[key];
    if (v === undefined) continue;
    const trimmed = typeof v === "string" ? v.trim() : v;
    if (trimmed === null || trimmed === "") doc.deleteIn([key]);
    else doc.setIn([key], trimmed);
  }
  // requires.git：显式值写键；null 删键 + 清空壳
  if (meta.requiresGit !== undefined) {
    if (meta.requiresGit === null) {
      deleteNestedSafe(doc, "requires", "git");
      pruneEmptyMap(doc, "requires");
    } else {
      setNestedSafe(doc, "requires", "git", meta.requiresGit);
    }
  }
  // 注：① sandbox.git 不再写——建 git 沙盒从 requires.git 派生（getWorkflowGitSandbox），不是 meta 字段；
  //   ② delivers 不再写——产出形态从 phase 派生（deriveDelivers）。patchWorkflowMetaYaml 只改 requires.git。
  return doc.toString();
}

/**
 * 修改 file 来源工作流的元信息。不自动 reload —— 调用方负责。
 */
export function setWorkflowMeta(workflowName: string, meta: WorkflowMetaInput): void {
  const yamlPath = getWorkflowYamlPath(workflowName);
  if (!existsSync(yamlPath)) throw new Error(`工作流不存在：${workflowName}`);
  const raw = readFileSync(yamlPath, "utf-8");
  writeFileSync(yamlPath, patchWorkflowMetaYaml(raw, meta), "utf-8");
}

function cleanPhaseEntry(p: PhaseEntryInput): Record<string, unknown> {
  if (isParallelInput(p)) {
    const parallel: Record<string, unknown> = { name: p.parallel.name };
    if (p.parallel.fail_strategy) parallel.fail_strategy = p.parallel.fail_strategy;
    parallel.phases = (p.parallel.phases ?? []).map((sub) => cleanSinglePhase(sub));
    return { parallel };
  }
  return cleanSinglePhase(p);
}

function cleanSinglePhase(p: PhaseInput): Record<string, unknown> {
  const out: Record<string, unknown> = { name: p.name };
  if (typeof p.timeout === "number" && p.timeout > 0) out.timeout = p.timeout;
  if (p.reject) out.reject = p.reject;
  // 保留未知扩展字段（含 retry_on_failure 等框架不消费的字段——原样透传不丢弃，
  // 但不当一等字段处理，避免误导成「内核已支持的能力」）
  for (const [k, v] of Object.entries(p)) {
    if (["name", "timeout", "reject"].includes(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

