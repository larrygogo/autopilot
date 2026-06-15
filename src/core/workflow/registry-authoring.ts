import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { parseDocument } from "yaml";
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
 * 结构化校验 + 写入工作流 phases 段。保留 YAML 中的其他字段与注释。
 * 不自动调用 reload —— 调用方负责。
 */
export function setWorkflowPhases(workflowName: string, phases: PhaseEntryInput[]): void {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error(`工作流 "${workflowName}" 的 phases 不能为空数组（至少一个阶段）`);
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

  // 3. 读取 + 写入 yaml Document（保留其他段）
  const yamlPath = getWorkflowYamlPath(workflowName);
  if (!existsSync(yamlPath)) throw new Error(`工作流不存在：${workflowName}`);

  const raw = readFileSync(yamlPath, "utf-8");
  const doc = parseDocument(raw);

  // 清洗 undefined / null / 空串 避免脏字段
  const cleaned = phases.map((p) => cleanPhaseEntry(p));
  doc.setIn(["phases"], cleaned);

  // 备份原文件
  copyFileSync(yamlPath, yamlPath + ".bak");
  writeFileSync(yamlPath, doc.toString(), "utf-8");
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
   * 声明层（v2 R5）输入闸门 requires.git：true（必须）/ "optional"（可选）/ false（不需要）
   * 显式写键；null = 删键（回退缺省派生自 sandbox.git）。undefined = 不动。
   */
  requiresGit?: boolean | "optional" | null;
  /**
   * 声明层执行机制 sandbox.git：true = 建 git 沙盒（写键）；false / null = 不建（删键，
   * 「不建」≡ 缺省，删键保持 yaml 干净、老副本零感知）。undefined = 不动。
   */
  sandboxGit?: boolean | null;
  /**
   * 声明层产出形态 delivers："pr" / "artifacts" 显式写；null / 空串 = 删键
   * （回退运行时事实推断）。undefined = 不动。
   */
  delivers?: string | null;
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
      doc.deleteIn(["requires", "git"]);
      pruneEmptyMap(doc, "requires");
    } else {
      doc.setIn(["requires", "git"], meta.requiresGit);
    }
  }
  // sandbox.git：仅 true 写键；false / null 删键（不建 ≡ 缺省）
  if (meta.sandboxGit !== undefined) {
    if (meta.sandboxGit === true) {
      doc.setIn(["sandbox", "git"], true);
    } else {
      doc.deleteIn(["sandbox", "git"]);
      pruneEmptyMap(doc, "sandbox");
    }
  }
  // delivers：顶层字段
  if (meta.delivers !== undefined) {
    const d = typeof meta.delivers === "string" ? meta.delivers.trim() : meta.delivers;
    if (d === null || d === "") doc.deleteIn(["delivers"]);
    else doc.setIn(["delivers"], d);
  }
  return doc.toString();
}

/**
 * 修改 file 来源工作流的元信息。不自动 reload —— 调用方负责。
 */
export function setWorkflowMeta(workflowName: string, meta: WorkflowMetaInput): void {
  const yamlPath = getWorkflowYamlPath(workflowName);
  if (!existsSync(yamlPath)) throw new Error(`工作流不存在：${workflowName}`);
  const raw = readFileSync(yamlPath, "utf-8");
  copyFileSync(yamlPath, yamlPath + ".bak");
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
  if (p.retry_on_failure) out.retry_on_failure = p.retry_on_failure;
  // 保留未知扩展字段（忽略已处理的 name/timeout/reject/retry_on_failure）
  for (const [k, v] of Object.entries(p)) {
    if (["name", "timeout", "reject", "retry_on_failure"].includes(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

