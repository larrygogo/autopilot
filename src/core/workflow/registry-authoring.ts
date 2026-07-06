/**
 * 工作流 phases / meta 的 JSON Spec 编辑（authoring）——P2 后 yaml_content 列已删除，
 * 以 spec_json（JSON 对象）为唯一真相，applyPhasesToYaml/patchWorkflowMetaYaml 全面迁至 JSON 操作。
 *
 * 「编辑 DB 工作流的 phases / meta 字段」这一与工作流注册/运行无关的关注点：
 * collectPhaseNames / setWorkflowPhases（已废弃：file 轨退役）/ applyPhasesToSpec /
 * patchWorkflowMetaSpec / setWorkflowMeta（已废弃）+ 清洗私有。
 * Web 工作流编辑器经 rpc 调用。依赖 registry 的只读接口（isParallelInput）；
 * registry 不依赖本模块 → 干净 DAG 无回环。
 */

import {
  isParallelInput,
  type PhaseEntryInput,
  type PhaseInput,
  type ParallelPhaseInput,
} from "./registry";

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
 * 结构化校验 + 把 phases 段写进 JSON spec 对象（保留其他字段），返回新 JSON 文本。
 * 纯函数、不碰磁盘/DB —— P2 后专用于 DB spec_json 路径。
 */
export function applyPhasesToSpec(rawSpec: string, phases: PhaseEntryInput[]): string {
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

  // 3. 写入 JSON 对象（保留其他段）
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(rawSpec) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`spec_json 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  // 清洗 undefined / null / 空串 避免脏字段
  const cleaned = phases.map((p) => cleanPhaseEntry(p));
  doc["phases"] = cleaned;
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * @deprecated P2 后用 applyPhasesToSpec（JSON 操作）。
 * 此函数已改为调用 applyPhasesToSpec——rawYaml 参数现在应传 JSON spec 文本。
 * 保留签名让调用方编译通过，逻辑委托给新实现。
 */
export function applyPhasesToYaml(rawYaml: string, phases: PhaseEntryInput[]): string {
  return applyPhasesToSpec(rawYaml, phases);
}

/**
 * @deprecated file 轨已退役（P2）。仅保留签名兼容，内部为 no-op。
 * 结构化校验 + 写入 file 来源工作流的 phases 段——file 轨退役后不再有 file 工作流。
 */
export function setWorkflowPhases(_workflowName: string, _phases: PhaseEntryInput[]): void {
  throw new Error("file 轨已退役（P2），setWorkflowPhases 不再可用；请用 applyPhasesToSpec + updateDbWorkflow");
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
 * 在 JSON spec 对象上手术式修改 label / description + 声明层（requires.git）。
 * 纯函数：file 来源与 db 来源共用（P2 后均为 JSON）。
 */
export function patchWorkflowMetaSpec(rawSpec: string, meta: WorkflowMetaInput): string {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(rawSpec) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`spec_json 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  for (const key of ["label", "description"] as const) {
    const v = meta[key];
    if (v === undefined) continue;
    const trimmed = typeof v === "string" ? v.trim() : v;
    if (trimmed === null || trimmed === "") {
      delete doc[key];
    } else {
      doc[key] = trimmed;
    }
  }

  // requires.git：显式值写键；null = 删键（回退派生自 sandbox.git）
  if (meta.requiresGit !== undefined) {
    if (meta.requiresGit === null) {
      const requires = doc["requires"];
      if (requires && typeof requires === "object" && !Array.isArray(requires)) {
        const r = { ...(requires as Record<string, unknown>) };
        delete r["git"];
        if (Object.keys(r).length === 0) {
          delete doc["requires"];
        } else {
          doc["requires"] = r;
        }
      } else {
        delete doc["requires"];
      }
    } else {
      const existing = doc["requires"];
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        doc["requires"] = { ...(existing as Record<string, unknown>), git: meta.requiresGit };
      } else {
        doc["requires"] = { git: meta.requiresGit };
      }
    }
  }

  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * @deprecated P2 后用 patchWorkflowMetaSpec（JSON 操作）。
 * 此函数已改为调用 patchWorkflowMetaSpec——raw 参数现在应传 JSON spec 文本。
 * 保留签名让调用方编译通过，逻辑委托给新实现。
 */
export function patchWorkflowMetaYaml(raw: string, meta: WorkflowMetaInput): string {
  return patchWorkflowMetaSpec(raw, meta);
}

/**
 * @deprecated file 轨已退役（P2）。仅保留签名兼容，内部抛错。
 */
export function setWorkflowMeta(_workflowName: string, _meta: WorkflowMetaInput): void {
  throw new Error("file 轨已退役（P2），setWorkflowMeta 不再可用；请用 patchWorkflowMetaSpec + updateDbWorkflow");
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

// ── 旧 file-路径占位（file 轨退役后不再需要 YAML 格式路径，但接口仍保留签名兼容）──
// 已删除 getWorkflowYamlPath（file 轨退役，不再需要磁盘 yaml 路径）。
// routes / rpc 中原先调 setWorkflowPhases/setWorkflowMeta 的地方已改直接走
// applyPhasesToSpec/patchWorkflowMetaSpec + updateDbWorkflow。

// P2 废弃：不再需要 reload（调用方已在 rpc-methods/routes 中直接调 reloadRegistry）
