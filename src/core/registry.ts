import type { TransitionTable } from "./state-machine";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parse as parseYaml, parseDocument, type Document } from "yaml";

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

/**
 * 热重载：清空注册表 + 重新发现工作流。
 */
export async function reload(): Promise<void> {
  _registry.clear();
  await discover();
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
  const name = phase["name"];
  if (!name || typeof name !== "string") {
    throw new Error(`阶段定义缺少有效的 name 字段：${JSON.stringify(phase)}`);
  }
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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("解析 YAML 工作流 %s 失败：%s", yamlPath, message);
    return null;
  }

  // 动态 import workflow.ts（如果存在）。
  // Bun 的 ESM import() 会按路径缓存，一旦首次加载，后续 reload 即使磁盘变化
  // 仍拿到旧版本。加 ?t=<mtime> query 强制每次文件变动后重新加载。
  let tsModule: Record<string, unknown> | null = null;
  if (existsSync(tsPath)) {
    try {
      const { statSync } = await import("fs");
      const mtime = statSync(tsPath).mtimeMs;
      tsModule = await import(`${tsPath}?t=${mtime}`) as Record<string, unknown>;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("加载 YAML 工作流 TS 模块 %s 失败：%s", tsPath, message);
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
        const doneState = terminalStates.has("done")
          ? "done"
          : [...terminalStates].find((s) => s !== "cancelled") ?? "done";
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("加载 YAML 工作流 %s 失败：%s", subDir, message);
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

/**
 * 读取工作流 YAML 原文
 */
export function getWorkflowYaml(workflowName: string): string | null {
  const yamlPath = join(AUTOPILOT_HOME, "workflows", workflowName, "workflow.yaml");
  if (!existsSync(yamlPath)) return null;
  return readFileSync(yamlPath, "utf-8");
}

/**
 * 保存工作流 YAML（写入磁盘 + 备份）
 * @throws 如果 YAML 解析失败
 */
export function saveWorkflowYaml(workflowName: string, yamlContent: string): void {
  // 校验 YAML 语法
  parseYaml(yamlContent);

  const yamlPath = join(AUTOPILOT_HOME, "workflows", workflowName, "workflow.yaml");
  if (!existsSync(join(AUTOPILOT_HOME, "workflows", workflowName))) {
    throw new Error(`工作流目录不存在：${workflowName}`);
  }
  // 备份
  if (existsSync(yamlPath)) {
    copyFileSync(yamlPath, yamlPath + ".bak");
  }
  writeFileSync(yamlPath, yamlContent, "utf-8");
}

// ──────────────────────────────────────────────
// 工作流创建 / 删除
// ──────────────────────────────────────────────

const WORKFLOW_NAME_RE = /^[a-z][a-z0-9_\-]{0,39}$/;

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  /** 初始阶段名（不含前缀，类似 "step1"），默认 "step1" */
  firstPhase?: string;
}

/**
 * 创建新工作流目录 + 脚手架 workflow.yaml / workflow.ts。
 * 不注册到 registry —— 调用方需在成功后执行 reload()。
 * @throws 名称非法 / 目录已存在
 */
export function createWorkflow(input: CreateWorkflowInput): { dir: string; yamlPath: string; tsPath: string } {
  const { name, description, firstPhase = "step1" } = input;
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error("工作流名称非法：需以小写字母开头，仅包含小写字母、数字、下划线、连字符，长度 ≤ 40");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(firstPhase)) {
    throw new Error("首阶段名非法：需以小写字母开头，仅包含小写字母、数字、下划线");
  }

  const wfRoot = join(AUTOPILOT_HOME, "workflows");
  const dir = join(wfRoot, name);
  if (existsSync(dir)) {
    throw new Error(`工作流目录已存在：${name}`);
  }

  mkdirSync(dir, { recursive: true });

  const yamlPath = join(dir, "workflow.yaml");
  const tsPath = join(dir, "workflow.ts");

  const yamlContent = renderWorkflowYamlTemplate(name, description, firstPhase);
  const tsContent = renderWorkflowTsTemplate(firstPhase);
  writeFileSync(yamlPath, yamlContent, "utf-8");
  writeFileSync(tsPath, tsContent, "utf-8");

  return { dir, yamlPath, tsPath };
}

/**
 * 删除工作流目录（整体移除）。只要工作流在预期根目录下就允许删除。
 * 不刷新 registry —— 调用方应在成功后执行 reload()。
 * @returns true if removed, false if dir doesn't exist
 */
export function deleteWorkflowDir(workflowName: string): boolean {
  if (!WORKFLOW_NAME_RE.test(workflowName)) {
    throw new Error("工作流名称非法");
  }
  const wfRoot = join(AUTOPILOT_HOME, "workflows");
  const dir = join(wfRoot, workflowName);
  // 安全校验：最终路径必须仍在 wfRoot 下
  if (!dir.startsWith(wfRoot + "/") && dir !== wfRoot) {
    throw new Error("非法路径");
  }
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function renderWorkflowYamlTemplate(name: string, description: string | undefined, firstPhase: string): string {
  const desc = description?.trim() ? description.trim() : "请补充描述";
  return `name: ${name}
description: ${desc}

# 工作流阶段列表。最简写法：只写 name 和 timeout，状态机将自动推导：
#   pending_<name> / running_<name> / start_<name> / complete_<name>
# 更多写法（并行、reject 跳转、自定义状态）见 docs/workflow-development.md
phases:
  - name: ${firstPhase}
    timeout: 900

# 可选：覆盖工作流内的智能体（全局 agents 在 config.yaml 定义）
# agents:
#   - name: coder
#     extends: coder       # 继承全局同名 agent，可在此覆盖字段
#     system_prompt: "特化提示词..."
`;
}

function renderWorkflowTsTemplate(firstPhase: string): string {
  const fn = `run_${firstPhase}`;
  return `// 每个 phase 函数接收 taskId: string 参数；抛错则该阶段失败，
// 可被状态机重试或驳回。详见 docs/workflow-development.md
//
// 常见用法（按需启用）：
//   import { getTask } from "@autopilot/db";        // 取任务对象
//   import { getAgent } from "@autopilot/agents";   // 取配置好的 agent
//
//   const task = getTask(taskId);
//   const agent = getAgent("coder", "<工作流名>");
//   const result = await agent.run("...prompt...");

export async function ${fn}(taskId: string): Promise<void> {
  console.log(\`[\${taskId}] 执行阶段 ${firstPhase}\`);
  // TODO: 在这里实现阶段业务逻辑
}
`;
}

// ──────────────────────────────────────────────
// 阶段级结构化编辑（保留 YAML 其他段）
// ──────────────────────────────────────────────

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface PhaseInput {
  name: string;
  timeout?: number;
  reject?: string | null;
  retry_on_failure?: boolean;
  [key: string]: unknown;
}

export interface ParallelPhaseInput {
  parallel: {
    name: string;
    fail_strategy?: string;
    phases: PhaseInput[];
  };
}

export type PhaseEntryInput = PhaseInput | ParallelPhaseInput;

function isParallelInput(p: PhaseEntryInput): p is ParallelPhaseInput {
  return "parallel" in p && p.parallel !== null && typeof p.parallel === "object";
}

function getWorkflowYamlPath(workflowName: string): string {
  return join(AUTOPILOT_HOME, "workflows", workflowName, "workflow.yaml");
}

function getWorkflowTsPath(workflowName: string): string {
  return join(AUTOPILOT_HOME, "workflows", workflowName, "workflow.ts");
}

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
    throw new Error("phases 不能为空数组");
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

// ──────────────────────────────────────────────
// workflow.ts 校准 —— 只追加缺失的 run_<phase>，不修改已有函数
// ──────────────────────────────────────────────

export interface SyncTsResult {
  /** 新追加的函数名列表 */
  added: string[];
  /** 存在但 phases 未引用的孤儿函数（不自动删） */
  orphans: string[];
  /** 是否修改了文件 */
  modified: boolean;
  /** 使用了旧 `ctx` 签名（runner 实际只传 taskId 字符串，会运行时报错）的函数名 */
  legacy_signature?: string[];
}

export function syncWorkflowTs(workflowName: string): SyncTsResult {
  const tsPath = getWorkflowTsPath(workflowName);
  if (!existsSync(tsPath)) throw new Error(`workflow.ts 不存在：${workflowName}`);

  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`工作流未注册：${workflowName}（请先 reload）`);

  const phaseNames = collectPhaseNames(wf.phases as PhaseEntryInput[]);
  const phaseSet = new Set(phaseNames);

  const content = readFileSync(tsPath, "utf-8");
  const existingFns = extractRunFunctions(content);
  const existingSet = new Set(existingFns);

  const missing = phaseNames.filter((n) => !existingSet.has(n));
  const orphans = existingFns.filter((n) => !phaseSet.has(n));
  const legacy = detectLegacySignatures(content);

  if (missing.length === 0) {
    return { added: [], orphans, modified: false, legacy_signature: legacy };
  }

  const appended = missing.map((name) => renderRunFunctionStub(name)).join("\n");
  const newContent = content.replace(/\s*$/, "") + "\n\n" + appended + "\n";

  copyFileSync(tsPath, tsPath + ".bak");
  writeFileSync(tsPath, newContent, "utf-8");

  return { added: missing, orphans, modified: true, legacy_signature: legacy };
}

/** 检测使用旧 `ctx: { task: any; ... }` 签名的 run_ 函数（运行时会崩） */
function detectLegacySignatures(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:async\s+)?function\s+run_([A-Za-z0-9_]+)\s*\(\s*ctx\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function extractRunFunctions(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    /export\s+async\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+const\s+run_([A-Za-z0-9_]+)\s*=/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}

// ──────────────────────────────────────────────
// 工作流内 agents[] 段的结构化读写
// ──────────────────────────────────────────────

export interface WorkflowAgentEntry {
  name: string;
  extends?: string | null;
  provider?: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
  [key: string]: unknown;
}

const AGENT_NAME_RE = /^[\w.\-]+$/;

/**
 * 结构化写入工作流 agents 段。支持空数组（会移除该段）。
 * 不自动 reload —— 调用方负责。
 */
export function setWorkflowAgents(workflowName: string, agents: WorkflowAgentEntry[]): void {
  if (!Array.isArray(agents)) {
    throw new Error("agents 必须是数组");
  }

  // 校验
  const seen = new Set<string>();
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a || typeof a !== "object") throw new Error(`第 ${i + 1} 项非法`);
    if (typeof a.name !== "string" || !AGENT_NAME_RE.test(a.name)) {
      throw new Error(`第 ${i + 1} 项 name 非法：${a.name}`);
    }
    if (seen.has(a.name)) throw new Error(`名称重复：${a.name}`);
    seen.add(a.name);
    if (a.extends !== undefined && a.extends !== null && typeof a.extends !== "string") {
      throw new Error(`"${a.name}" 的 extends 必须是字符串`);
    }
    if (a.max_turns !== undefined && (typeof a.max_turns !== "number" || a.max_turns <= 0)) {
      throw new Error(`"${a.name}" 的 max_turns 必须是正整数`);
    }
  }

  const yamlPath = getWorkflowYamlPath(workflowName);
  if (!existsSync(yamlPath)) throw new Error(`工作流不存在：${workflowName}`);

  const raw = readFileSync(yamlPath, "utf-8");
  const doc = parseDocument(raw);

  if (agents.length === 0) {
    doc.deleteIn(["agents"]);
  } else {
    const cleaned = agents.map(cleanWorkflowAgent);
    doc.setIn(["agents"], cleaned);
  }

  copyFileSync(yamlPath, yamlPath + ".bak");
  writeFileSync(yamlPath, doc.toString(), "utf-8");
}

function cleanWorkflowAgent(a: WorkflowAgentEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { name: a.name };
  if (a.extends) out.extends = a.extends;
  if (a.provider) out.provider = a.provider;
  if (a.model) out.model = a.model;
  if (typeof a.max_turns === "number" && a.max_turns > 0) out.max_turns = a.max_turns;
  if (a.permission_mode) out.permission_mode = a.permission_mode;
  if (a.system_prompt) out.system_prompt = a.system_prompt;
  // 保留未知扩展字段
  const handled = new Set(["name", "extends", "provider", "model", "max_turns", "permission_mode", "system_prompt"]);
  for (const [k, v] of Object.entries(a)) {
    if (handled.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function renderRunFunctionStub(phaseName: string): string {
  return `export async function run_${phaseName}(taskId: string): Promise<void> {
  console.log(\`[\${taskId}] 执行阶段 ${phaseName}\`);
  // TODO: 实现阶段逻辑
}`;
}
