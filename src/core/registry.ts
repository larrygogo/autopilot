import type { TransitionTable } from "./state-machine";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "fs";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface PhaseDefinition {
  name: string;
  pending_state: string;
  running_state: string;
  trigger: string;
  complete_trigger: string;
  fail_trigger: string;
  label: string;
  timeout?: number;
  agent?: string;
  func?: (taskId: string) => Promise<void>;
  jump_trigger?: string;
  jump_target?: string;
  max_rejections?: number;
  _jump_origin?: string;
  [key: string]: unknown;
}

export interface ParallelDefinition {
  name: string;
  fail_strategy: string;
  phases: PhaseDefinition[];
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  agents?: Record<string, unknown>[];
  phases: (PhaseDefinition | { parallel: ParallelDefinition })[];
  initial_state: string;
  terminal_states: string[];
  transitions?: TransitionTable;
  hooks?: Record<string, (...args: any[]) => void>;
  setup_func?: (args: any) => Record<string, unknown>;
  notify_func?: (task: any, message: string, mediaPath?: string) => void;
  [key: string]: unknown;
}

// 类型守卫：判断阶段条目是否为 parallel 块
export function isParallelPhase(
  phase: PhaseDefinition | { parallel: ParallelDefinition }
): phase is { parallel: ParallelDefinition } {
  return "parallel" in phase && phase.parallel instanceof Object;
}

// ──────────────────────────────────────────────
// 全局注册表
// ──────────────────────────────────────────────

const _registry: Map<string, WorkflowDefinition> = new Map();

export function _clearRegistry(): void {
  _registry.clear();
}

// ──────────────────────────────────────────────
// 阶段默认值展开
// ──────────────────────────────────────────────

/**
 * 自动推导阶段的默认字段。
 * 推导规则（以 phase name 'design' 为例）：
 *   pending_state: pending_design
 *   running_state: running_design
 *   trigger: start_design
 *   complete_trigger: design_complete
 *   fail_trigger: design_fail
 *   label: DESIGN
 *
 * reject 语法糖：
 *   reject: design → jump_trigger: {name}_reject, jump_target: design, max_rejections: 10
 */
export function expandPhaseDefaults(
  phase: Record<string, unknown>,
  allPhaseNames: Set<string>
): PhaseDefinition {
  const name = phase["name"] as string;
  const expanded: Record<string, unknown> = { ...phase };

  if (!expanded["pending_state"]) expanded["pending_state"] = `pending_${name}`;
  if (!expanded["running_state"]) expanded["running_state"] = `running_${name}`;
  if (!expanded["trigger"]) expanded["trigger"] = `start_${name}`;
  if (!expanded["complete_trigger"]) expanded["complete_trigger"] = `${name}_complete`;
  if (!expanded["fail_trigger"]) expanded["fail_trigger"] = `${name}_fail`;
  if (!expanded["label"]) expanded["label"] = name.toUpperCase();

  // reject 语法糖 → jump_trigger/jump_target
  const rejectTarget = expanded["reject"] as string | undefined;
  delete expanded["reject"];

  if (rejectTarget) {
    if (!expanded["jump_trigger"]) expanded["jump_trigger"] = `${name}_reject`;
    if (!expanded["jump_target"]) expanded["jump_target"] = rejectTarget;
    expanded["_jump_origin"] = "reject";
    if (!allPhaseNames.has(rejectTarget)) {
      log.warn("阶段 %s 的 reject 目标 '%s' 不在 phases 中", name, rejectTarget);
    }
    if (expanded["max_rejections"] === undefined) expanded["max_rejections"] = 10;
  }

  // 兼容旧字段：reject_trigger/retry_target → jump_trigger/jump_target
  const legacyRejectTrigger = expanded["reject_trigger"] as string | undefined;
  const legacyRetryTarget = expanded["retry_target"] as string | undefined;
  delete expanded["reject_trigger"];
  delete expanded["retry_target"];
  if (legacyRejectTrigger && !expanded["jump_trigger"]) {
    expanded["jump_trigger"] = legacyRejectTrigger;
  }
  if (legacyRetryTarget && !expanded["jump_target"]) {
    expanded["jump_target"] = legacyRetryTarget;
  }

  return expanded as PhaseDefinition;
}

function expandParallelDefaults(
  parallelDef: Record<string, unknown>,
  allPhaseNames: Set<string>
): ParallelDefinition {
  const expanded: Record<string, unknown> = { ...parallelDef };
  if (!expanded["fail_strategy"]) expanded["fail_strategy"] = "cancel_all";

  const rawPhases = (expanded["phases"] as Record<string, unknown>[]) ?? [];
  expanded["phases"] = rawPhases.map((sub) => expandPhaseDefaults(sub, allPhaseNames));

  return expanded as unknown as ParallelDefinition;
}

// ──────────────────────────────────────────────
// YAML 工作流加载
// ──────────────────────────────────────────────

/**
 * 从工作流目录加载 YAML 工作流定义。
 * 目录需包含：
 *   - workflow.yaml — 工作流结构定义
 *   - workflow.ts   — 阶段函数实现（可选）
 */
export async function loadYamlWorkflow(wfDir: string): Promise<WorkflowDefinition | null> {
  const yamlPath = join(wfDir, "workflow.yaml");
  const tsPath = join(wfDir, "workflow.ts");

  if (!existsSync(yamlPath)) {
    return null;
  }

  let wfDef: Record<string, unknown>;
  try {
    const content = readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== "object") {
      log.warn("YAML 工作流 %s 为空或格式错误", yamlPath);
      return null;
    }
    wfDef = parsed as Record<string, unknown>;
  } catch (e: any) {
    log.error("解析 YAML 工作流 %s 失败：%s", yamlPath, e.message);
    return null;
  }

  // 动态 import workflow.ts（如果存在）
  let tsModule: Record<string, unknown> | null = null;
  if (existsSync(tsPath)) {
    try {
      tsModule = await import(tsPath) as Record<string, unknown>;
    } catch (e: any) {
      log.warn("加载 YAML 工作流 TS 模块 %s 失败：%s", tsPath, e.message);
      return null;
    }
  }

  // 收集所有阶段名（用于 reject 目标校验）
  const allPhaseNames = new Set<string>();
  const rawPhases = (wfDef["phases"] as Record<string, unknown>[]) ?? [];
  for (const phase of rawPhases) {
    if (typeof phase !== "object" || !phase) continue;
    if ("parallel" in phase) {
      const par = phase["parallel"] as Record<string, unknown>;
      const subPhases = (par["phases"] as Record<string, unknown>[]) ?? [];
      for (const sub of subPhases) {
        if (sub["name"]) allPhaseNames.add(sub["name"] as string);
      }
    } else if (phase["name"]) {
      allPhaseNames.add(phase["name"] as string);
    }
  }

  // 展开阶段默认值并绑定函数
  const expandedPhases: (PhaseDefinition | { parallel: ParallelDefinition })[] = [];
  for (const phase of rawPhases) {
    if (typeof phase !== "object" || !phase) continue;

    if ("parallel" in phase) {
      const par = phase["parallel"] as Record<string, unknown>;
      const parExpanded = expandParallelDefaults(par, allPhaseNames);
      // 绑定子阶段函数
      for (const sub of parExpanded.phases) {
        bindPhaseFunc(sub, tsModule);
      }
      expandedPhases.push({ parallel: parExpanded });
    } else {
      const phaseExpanded = expandPhaseDefaults(phase as Record<string, unknown>, allPhaseNames);
      bindPhaseFunc(phaseExpanded, tsModule);
      expandedPhases.push(phaseExpanded);
    }
  }

  wfDef["phases"] = expandedPhases;

  // 自动推导 workflow 级别默认值
  if (expandedPhases.length > 0) {
    const first = expandedPhases[0];
    if (!("parallel" in first)) {
      if (!wfDef["initial_state"]) {
        wfDef["initial_state"] = (first as PhaseDefinition).pending_state;
      }
    } else {
      const parName = (first as { parallel: ParallelDefinition }).parallel.name;
      if (!wfDef["initial_state"]) {
        wfDef["initial_state"] = `pending_${parName}`;
      }
    }
  }
  if (!wfDef["terminal_states"]) {
    wfDef["terminal_states"] = ["done", "cancelled"];
  }

  // 绑定 workflow 级别函数
  bindWorkflowFuncs(wfDef, tsModule);

  // 转换 YAML 中的 transitions 格式（数组 → 转换表）
  if ("transitions" in wfDef && wfDef["transitions"]) {
    wfDef["transitions"] = normalizeTransitions(
      wfDef["transitions"] as Record<string, unknown[]>
    );
  }

  return wfDef as unknown as WorkflowDefinition;
}

function normalizeTransitions(
  transitions: Record<string, unknown[]>
): TransitionTable {
  const normalized: TransitionTable = {};
  for (const [state, transList] of Object.entries(transitions)) {
    if (!Array.isArray(transList)) continue;
    const tuples: [string, string][] = [];
    for (const item of transList) {
      if (Array.isArray(item) && item.length === 2) {
        tuples.push([String(item[0]), String(item[1])]);
      }
    }
    normalized[state] = tuples;
  }
  return normalized;
}

function bindPhaseFunc(
  phase: PhaseDefinition,
  tsModule: Record<string, unknown> | null
): void {
  const funcRef = phase.func;
  if (typeof funcRef === "function") return; // 已经是 callable

  const funcName = typeof funcRef === "string" ? funcRef : `run_${phase.name}`;

  if (tsModule && typeof tsModule[funcName] === "function") {
    phase.func = tsModule[funcName] as (taskId: string) => Promise<void>;
  } else {
    log.warn("找不到阶段函数 %s", funcName);
    // 缺失的阶段函数在执行时抛出错误，防止工作流静默空跑
    phase.func = async (_taskId: string) => {
      throw new Error(
        `阶段函数 "${funcName}" 未定义，请在 workflow.ts 中导出该函数`
      );
    };
  }
}

function bindWorkflowFuncs(
  wfDef: Record<string, unknown>,
  tsModule: Record<string, unknown> | null
): void {
  for (const key of ["setup_func", "notify_func"]) {
    const funcRef = wfDef[key];
    if (typeof funcRef === "string" && tsModule) {
      if (typeof tsModule[funcRef] === "function") {
        wfDef[key] = tsModule[funcRef];
      } else {
        log.warn("找不到工作流函数 %s.%s", key, funcRef);
        delete wfDef[key];
      }
    }
  }

  const hooks = wfDef["hooks"];
  if (hooks && typeof hooks === "object" && tsModule) {
    const hooksObj = hooks as Record<string, unknown>;
    for (const [hookName, funcRef] of Object.entries(hooksObj)) {
      if (typeof funcRef === "string") {
        if (typeof tsModule[funcRef] === "function") {
          hooksObj[hookName] = tsModule[funcRef];
        } else {
          log.warn("找不到钩子函数 hooks.%s = %s", hookName, funcRef);
          delete hooksObj[hookName];
        }
      }
    }
  }
}

// ──────────────────────────────────────────────
// 转换表构建
// ──────────────────────────────────────────────

/**
 * 构建状态转换表。
 *
 * 自动生成规则：
 * - 每个阶段的 pending_state 可以通过 trigger 转换到 running_state
 * - running_state 可以通过 complete_trigger 转换到下一阶段的 pending_state（或终态）
 * - 如果有 fail_trigger，running_state 可以回退到 pending_state（重试）
 * - 如果有 jump_trigger + jump_target，生成驳回和重试转换
 * - parallel 阶段生成 fork/join 转换
 * - 所有非终态都可以通过 'cancel' 转换到 'cancelled'
 */
export function buildTransitions(workflow: WorkflowDefinition): TransitionTable {
  // 如果工作流自定义了转换表，直接使用
  if (workflow.transitions) {
    return workflow.transitions;
  }

  const phases = workflow.phases;
  const terminalStates = new Set<string>(workflow.terminal_states ?? ["cancelled"]);
  const transitions: TransitionTable = {};

  // 收集所有普通阶段（用于 jump_target 查找）
  const allFlatPhases: PhaseDefinition[] = [];
  for (const phase of phases) {
    if (isParallelPhase(phase)) {
      for (const sub of phase.parallel.phases) {
        allFlatPhases.push(sub);
      }
    } else {
      allFlatPhases.push(phase as PhaseDefinition);
    }
  }

  function getNextPending(idx: number): string | null {
    if (idx + 1 < phases.length) {
      const next = phases[idx + 1];
      if (isParallelPhase(next)) {
        return `pending_${next.parallel.name}`;
      }
      return (next as PhaseDefinition).pending_state;
    }
    return null;
  }

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];

    if (isParallelPhase(phase)) {
      buildParallelTransitions(phase.parallel, i, phases, terminalStates, transitions);
      continue;
    }

    const p = phase as PhaseDefinition;
    const pending = p.pending_state;
    const running = p.running_state;

    // pending → running
    if (p.trigger) {
      if (!transitions[pending]) transitions[pending] = [];
      transitions[pending].push([p.trigger, running]);
    }

    // running → 下一阶段的 pending 或终态
    if (p.complete_trigger) {
      const nextPending = getNextPending(i);
      if (!transitions[running]) transitions[running] = [];
      if (nextPending) {
        transitions[running].push([p.complete_trigger, nextPending]);
      } else {
        const doneState =
          [...terminalStates].find((s) => s !== "cancelled") ?? "done";
        transitions[running].push([p.complete_trigger, doneState]);
      }
    }

    // fail_trigger：running → pending（重试）
    if (p.fail_trigger) {
      if (!transitions[running]) transitions[running] = [];
      transitions[running].push([p.fail_trigger, pending]);
    }

    // jump_trigger：running → rejected 状态
    if (p.jump_trigger) {
      const rejectedState = `${p.name}_rejected`;
      if (!transitions[running]) transitions[running] = [];
      transitions[running].push([p.jump_trigger, rejectedState]);

      // jump_target：rejected → 目标阶段的 pending
      if (p.jump_target) {
        const targetPhase = allFlatPhases.find((fp) => fp.name === p.jump_target);
        if (targetPhase) {
          const retryTrigger = `retry_${p.jump_target}`;
          if (!transitions[rejectedState]) transitions[rejectedState] = [];
          transitions[rejectedState].push([retryTrigger, targetPhase.pending_state]);
        }
      }
    }
  }

  // 所有非终态加 cancel 转换
  for (const state of Object.keys(transitions)) {
    if (!terminalStates.has(state)) {
      const existingTriggers = new Set(transitions[state].map(([t]) => t));
      if (!existingTriggers.has("cancel")) {
        transitions[state].push(["cancel", "cancelled"]);
      }
    }
  }

  // rejected 状态也加 cancel（rejected 状态可能不在 transitions keys 中）
  for (const phase of phases) {
    if (isParallelPhase(phase)) {
      for (const sub of phase.parallel.phases) {
        if (sub.jump_trigger) {
          const rejectedState = `${sub.name}_rejected`;
          if (transitions[rejectedState]) {
            const existingTriggers = new Set(transitions[rejectedState].map(([t]) => t));
            if (!existingTriggers.has("cancel")) {
              transitions[rejectedState].push(["cancel", "cancelled"]);
            }
          }
        }
      }
    } else {
      const p = phase as PhaseDefinition;
      if (p.jump_trigger) {
        const rejectedState = `${p.name}_rejected`;
        if (transitions[rejectedState]) {
          const existingTriggers = new Set(transitions[rejectedState].map(([t]) => t));
          if (!existingTriggers.has("cancel")) {
            transitions[rejectedState].push(["cancel", "cancelled"]);
          }
        }
      }
    }
  }

  return transitions;
}

function buildParallelTransitions(
  parallelDef: ParallelDefinition,
  idx: number,
  allPhases: (PhaseDefinition | { parallel: ParallelDefinition })[],
  terminalStates: Set<string>,
  transitions: TransitionTable
): void {
  const groupName = parallelDef.name;
  const pendingGroup = `pending_${groupName}`;
  const waitingGroup = `waiting_${groupName}`;
  const forkTrigger = `start_${groupName}`;
  const joinTrigger = `${groupName}_complete`;

  // pending_group → waiting_group（fork）
  if (!transitions[pendingGroup]) transitions[pendingGroup] = [];
  transitions[pendingGroup].push([forkTrigger, waitingGroup]);

  // 子阶段各自的转换
  for (const sub of parallelDef.phases) {
    const pending = sub.pending_state;
    const running = sub.running_state;

    if (sub.trigger) {
      if (!transitions[pending]) transitions[pending] = [];
      transitions[pending].push([sub.trigger, running]);
    }

    // 子阶段 complete：running → sub_done 状态
    if (sub.complete_trigger) {
      const subDone = `${sub.name}_done`;
      if (!transitions[running]) transitions[running] = [];
      transitions[running].push([sub.complete_trigger, subDone]);
    }

    if (sub.fail_trigger) {
      if (!transitions[running]) transitions[running] = [];
      transitions[running].push([sub.fail_trigger, pending]);
    }
  }

  // waiting_group → 下一阶段（join）
  if (!transitions[waitingGroup]) transitions[waitingGroup] = [];
  if (idx + 1 < allPhases.length) {
    const nextP = allPhases[idx + 1];
    const nextPending =
      isParallelPhase(nextP)
        ? `pending_${nextP.parallel.name}`
        : (nextP as PhaseDefinition).pending_state;
    transitions[waitingGroup].push([joinTrigger, nextPending]);
  } else {
    const doneState = [...terminalStates].find((s) => s !== "cancelled") ?? "done";
    transitions[waitingGroup].push([joinTrigger, doneState]);
  }

  // fail trigger for parallel group
  const failTrigger = `${groupName}_fail`;
  transitions[waitingGroup].push([failTrigger, pendingGroup]);
}

// ──────────────────────────────────────────────
// 发现与注册
// ──────────────────────────────────────────────

/**
 * 扫描 AUTOPILOT_HOME/workflows/ 子目录，注册所有 YAML 工作流
 */
export async function discover(): Promise<void> {
  const userWfDir = join(AUTOPILOT_HOME, "workflows");
  if (!existsSync(userWfDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(userWfDir);
  } catch {
    return;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith("_")) continue;
    const subDir = join(userWfDir, entry);
    const yamlPath = join(subDir, "workflow.yaml");
    if (!existsSync(yamlPath)) continue;

    try {
      const wf = await loadYamlWorkflow(subDir);
      if (!wf) continue;
      register(wf);
      log.debug("注册 YAML 工作流：%s（来自 %s）", wf.name, subDir);
    } catch (e: any) {
      log.warn("加载 YAML 工作流 %s 失败：%s", subDir, e.message);
    }
  }
}

/**
 * 手动注册工作流定义
 */
export function register(wf: WorkflowDefinition): void {
  _registry.set(wf.name, wf);
}

// ──────────────────────────────────────────────
// 查询
// ──────────────────────────────────────────────

export function getWorkflow(name: string): WorkflowDefinition | null {
  return _registry.get(name) ?? null;
}

export function listWorkflows(): { name: string; description: string }[] {
  return [..._registry.values()].map((wf) => ({
    name: wf.name,
    description: wf.description ?? "",
  }));
}

/**
 * 获取指定工作流的阶段定义（支持 parallel 子阶段查找）
 */
export function getPhase(
  workflowName: string,
  phaseName: string
): PhaseDefinition | null {
  const wf = getWorkflow(workflowName);
  if (!wf) return null;

  for (const phase of wf.phases) {
    if (isParallelPhase(phase)) {
      for (const sub of phase.parallel.phases) {
        if (sub.name === phaseName) return sub;
      }
    } else if ((phase as PhaseDefinition).name === phaseName) {
      return phase as PhaseDefinition;
    }
  }
  return null;
}

/**
 * 获取阶段的执行函数
 */
export function getPhaseFunc(
  workflowName: string,
  phaseName: string
): ((taskId: string) => Promise<void>) | null {
  const phase = getPhase(workflowName, phaseName);
  if (!phase) return null;
  return phase.func ?? null;
}

/**
 * 获取下一阶段名称（按 phases 列表顺序，跳过 parallel 块内部）
 */
export function getNextPhase(
  workflowName: string,
  currentPhase: string
): string | null {
  const wf = getWorkflow(workflowName);
  if (!wf) return null;

  const phases = wf.phases;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const name = isParallelPhase(phase) ? phase.parallel.name : (phase as PhaseDefinition).name;

    if (name === currentPhase && i + 1 < phases.length) {
      const next = phases[i + 1];
      return isParallelPhase(next) ? next.parallel.name : (next as PhaseDefinition).name;
    }

    // 也检查 parallel 子阶段名
    if (isParallelPhase(phase)) {
      for (const sub of phase.parallel.phases) {
        if (sub.name === currentPhase) {
          if (i + 1 < phases.length) {
            const next = phases[i + 1];
            return isParallelPhase(next) ? next.parallel.name : (next as PhaseDefinition).name;
          }
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 获取工作流的终态列表
 */
export function getTerminalStates(workflowName: string): string[] {
  const wf = getWorkflow(workflowName);
  if (!wf) return ["cancelled"];
  return wf.terminal_states ?? ["cancelled"];
}
