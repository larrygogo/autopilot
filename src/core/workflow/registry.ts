import type { TransitionTable } from "../state-machine";
import { log } from "../logger";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { tryMakePromptRunnerForPhase } from "./prompt-runner";
import { makeArtifactDeliverRunner } from "./builtin-deliver";
import { makePrDeliverRunner } from "./builtin-deliver-pr";
import type { PhaseDecision } from "./phase-decision";
import { DEFAULT_AGENT, type InlineAgentConfig } from "../agent-defaults";
import { listWorkflowsInDb } from "./workflows";

/** 动态读取 AUTOPILOT_HOME，便于测试通过 env 注入临时目录 */
function getAutopilotHomeDynamic(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

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
  /**
   * Phase 内联 agent 配置。
   * - 对象：就地配置（provider/model/system_prompt...），不引用命名 agent
   * - 省略：走 DEFAULT_AGENT 兜底
   * - string：旧格式（引用命名 agent），兼容期保留，由 agentForPhase 降级处理
   */
  agent?: string | InlineAgentConfig;
  func?: (taskId: string) => Promise<void>;
  jump_trigger?: string;
  jump_target?: string;
  max_rejections?: number;
  _jump_origin?: string;
  /** 跑完后挂起到 awaiting_<name>，等 UI 决断（pass/reject）才推进 */
  gate?: boolean;
  /** 等待界面的提示文案；默认 "请审阅产物后决定" */
  gate_message?: string;
  /**
   * 声明式判据 / 分支（仅 prompt 模式 phase 生效）。prompt-runner 跑完 agent 后按此判
   * pass/reject：pass → 框架自动推进；reject → 回退 reject: 目标重做、数驳回、触顶转 failed。
   * 复用 reject:/max_rejections 已生成的转换，不新增状态机机制。详见 phase-decision.ts。
   */
  decision?: PhaseDecision;
  /**
   * Phase 6: 是否启用 handoff 协议（spec §3.10）。
   * true 时 prompt-runner 在 prompt 末尾追加 4 段指令（Decided/Files/Risks/Remaining），
   * 跑完后解析 agent_output.md 抽出 4 段写 handoff.md；
   * 下游 phase 通过 ${HANDOFF} 占位符拿到拼接的 handoff 链。
   * 仅对纯 yaml prompt phase 生效（ts phase 已有完全控制权，不强加）。
   */
  handoff?: boolean;
  /**
   * 【已废弃 / 当前共用沙盒模型不消费，无任何运行时效果】Phase 级 sandbox 策略。
   * 即焚+patch 模型的遗留字段（2026-06-09 revert 为任务级共用 clone 后 runner 不再读
   * getPhaseSandboxSpec）。保留字段仅为兼容存量 workflow.yaml 不报错；read-only/read-write/
   * deliver 不再限制任何 phase。未来若上 L2 环境隔离再重新定义。**勿据此以为有沙盒隔离语义。**
   */
  sandbox?: PhaseSandboxSpec;
  [key: string]: unknown;
}

export interface ParallelDefinition {
  name: string;
  fail_strategy: string;
  phases: PhaseDefinition[];
}

export interface WorkflowSandboxSpec {
  /** 模板目录名（相对工作流目录），创建任务时 copy 到 sandbox 目录 */
  template?: string;
  /** 工作流是否需要代码仓库（true → 任务启动反查 workspace、`ensureTaskSandbox` 建共用 clone） */
  git?: boolean;
}

/** 【已废弃，共用沙盒模型不消费】Phase 级 sandbox 策略遗留字段。详见 PhaseDefinition.sandbox。 */
export interface PhaseSandboxSpec {
  code?: "read-only" | "read-write";
  ephemeral?: boolean;
  deliver?: boolean;
}

/**
 * 工作流声明层（需求中心架构 v2 R5，runtime spec D 节）：
 * requires = 输入闸门声明（能不能往下走），sandbox = 执行机制（怎么建沙盒）——分层不合并。
 * registry 只透传形状 + 缺省派生（requires.git 缺省 = sandbox.git ?? false，老副本零感知）；
 * 枚举值的业务语义（'pr'/'artifacts'、闸门拦截）全在 daemon，core 零业务知识。
 */
export interface WorkflowRequiresSpec {
  /** true=需要代码库（一定 clone）；false=不需要（不 clone）。2026-06-22：optional 第三态废弃，只剩二态。 */
  git?: boolean;
}

export interface WorkflowDefinition {
  name: string;
  /** 显示名（UI 显示），未填则回退到 name */
  label?: string;
  description?: string;
  config?: Record<string, unknown>;
  sandbox?: WorkflowSandboxSpec;
  /** 输入闸门声明；缺省派生自 sandbox.git（见 getWorkflowGitRequirement） */
  requires?: WorkflowRequiresSpec;
  /** 产出形态声明（如 "pr" / "artifacts"）；registry 纯字符串透传，枚举语义在 daemon。缺省 = 事实推断 */
  delivers?: string;
  /**
   * 声明式安全闸门（spec 2026-06-14 砖 3）。true → 加载期硬拒任何用户 TS 代码：
   * 工作流不得含 workflow.ts 函数导出，phase 只能来自框架原语（prompt / gate /
   * parallel）。保证能力上界由框架钉死（tools 授权 + sandbox + 无 spawn）→「沙盒安全」，可安全
   * 跨人运行别人写的工作流。正交于 requires（输入）/ delivers（输出）。
   */
  declarative?: boolean;
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

/** 在工作流里查 phase 定义（顶层或并行子阶段），找不到返回 null。 */
function findPhaseDef(wf: WorkflowDefinition, phaseName: string): PhaseDefinition | null {
  for (const p of wf.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) if (sub.name === phaseName) return sub;
    } else if (p.name === phaseName) {
      return p;
    }
  }
  return null;
}

/**
 * 【已废弃，零调用方】取 phase 的 sandbox 策略。即焚模型遗留——共用沙盒模型下 runner 不再读它，
 * 保留仅防外部引用编译断裂。返回值不影响任何运行时行为。
 */
export function getPhaseSandboxSpec(
  workflowName: string,
  phaseName: string,
): Required<PhaseSandboxSpec> {
  const wf = getWorkflow(workflowName);
  const phase = wf ? findPhaseDef(wf, phaseName) : null;
  const s: PhaseSandboxSpec = (phase?.sandbox as PhaseSandboxSpec | undefined) ?? {};
  return {
    code: s.code === "read-write" ? "read-write" : "read-only",
    ephemeral: s.ephemeral !== false,
    deliver: s.deliver === true,
  };
}

// ──────────────────────────────────────────────
// 全局注册表
// ──────────────────────────────────────────────

const _registry: Map<string, WorkflowDefinition> = new Map();

/**
 * 程序化注册的内置工作流（如 daemon 注册的平台级执行器 `__fix`）。
 * 与文件/DB 工作流的区别：不依赖磁盘发现，reload() 清空注册表后自动重新注册。
 * 命名约定 `__` 前缀标内置 —— listWorkflows 默认隐藏（getWorkflow / runner 照常可用）。
 */
const _builtins: Map<string, WorkflowDefinition> = new Map();

export function _clearRegistry(): void {
  _registry.clear();
  _builtins.clear();
}

/**
 * 注册内置工作流：进注册表 + 记入 builtins 集合（reload 后存活）。
 * 框架只提供机制；具体内置工作流的定义（prompt / 业务语义）由 daemon 层提供。
 */
export function registerBuiltin(wf: WorkflowDefinition): void {
  _builtins.set(wf.name, wf);
  _registry.set(wf.name, wf);
}

/**
 * 热重载：清空注册表 + 重新发现工作流。内置工作流（registerBuiltin）自动保留。
 */
export async function reload(): Promise<void> {
  _registry.clear();
  for (const wf of _builtins.values()) _registry.set(wf.name, wf);
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

  lintPhaseDecision(expanded, name);

  return expanded as PhaseDefinition;
}

/**
 * 声明式判据（decision）author-time 配置 lint：在加载/派生时前置报错，避免运行期才炸。
 * 调用点须保证 phase 已展开 reject 语法糖（jump_target 已派生）。
 */
function lintPhaseDecision(phase: Record<string, unknown>, phaseName: string): void {
  const decision = phase["decision"];
  if (decision === undefined) return;
  if (typeof decision !== "object" || decision === null) {
    throw new Error(`阶段 ${phaseName} 的 decision 必须是对象`);
  }
  const d = decision as Record<string, unknown>;
  const mode = d["mode"];
  if (mode === "judge") {
    throw new Error(`阶段 ${phaseName} 的 decision.mode "judge" 已移除——请改用 "tool"（评审 agent 自己调 submit_decision 出裁决），criteria 保留即可，去掉 judge_provider/judge_model/judge_system_prompt`);
  }
  if (mode !== undefined && mode !== "marker" && mode !== "tool") {
    throw new Error(`阶段 ${phaseName} 的 decision.mode 只能是 "marker" 或 "tool"`);
  }
  // 仅 marker 模式（缺省）需要 pass/reject 标记串；tool 靠 agent 调 submit_decision 工具/
  // 产出 JSON 裁决块，不写标记。
  if (mode === undefined || mode === "marker") {
    if (typeof d["pass"] !== "string" || typeof d["reject"] !== "string") {
      throw new Error(`阶段 ${phaseName} 的 decision（marker 模式）必须同时含 pass 与 reject 字段（标记串）`);
    }
  }
  if (phase["gate"] === true) {
    throw new Error(`阶段 ${phaseName} 不能同时配 gate 与 decision（gate=人工判，decision=agent 自动判，互斥）`);
  }
  if (!phase["jump_target"]) {
    throw new Error(`阶段 ${phaseName} 配了 decision，但缺 reject 回退目标——请在该 phase 上写 reject: <目标阶段>`);
  }
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
// JSON 工作流加载（P1：examples 模板 JSON 化）
// ──────────────────────────────────────────────

/**
 * 从工作流目录加载 JSON 工作流定义（P1 后：examples 模板均为 workflow.json）。
 * 目录需包含 workflow.json；如残留 workflow.ts 会被忽略并告警。
 * 现存消费者：examples 模板解析（种子/测试/导出投影），不再用于运行时 discover。
 */
export async function loadJsonWorkflow(wfDir: string): Promise<WorkflowDefinition | null> {
  const jsonPath = join(wfDir, "workflow.json");
  const tsPath = join(wfDir, "workflow.ts");

  if (!existsSync(jsonPath)) {
    return null;
  }

  let wfDef: Record<string, unknown>;
  try {
    const content = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      log.warn("JSON 工作流 %s 为空或格式错误", jsonPath);
      return null;
    }
    wfDef = parsed;
    // Schema 级归一化：允许字段类型宽松但会转为正确类型并记警告
    normalizeWorkflowFields(wfDef, jsonPath);
    // `workspace:` 段已更名为 `sandbox:`；优先读 sandbox，回退老字段并 warn
    normalizeSandboxSection(wfDef, jsonPath);
    // 声明层（requires/delivers）：只做形状归一 + lint，不校验枚举值（语义在 daemon）
    normalizeDeclarations(wfDef, jsonPath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("解析 JSON 工作流 %s 失败：%s", jsonPath, message);
    return null;
  }

  // file 轨退役（2026-07-03）：不再动态 import workflow.ts。残留 ts 文件被忽略（告警），
  // 阶段一律走框架原语（prompt / gate / deliver / decision）；含自定义函数的老工作流
  // 由 migration 052 告警指引重建。
  if (existsSync(tsPath)) {
    log.warn("工作流 %s 含 workflow.ts——file 轨已退役，TS 阶段函数不再加载（仅按 json 声明式解析）", wfDir);
  }

  return buildWorkflowDefinition(wfDef, null);
}

/**
 * 从「已解析 + 归一化的 wfDef 对象」构建完整 WorkflowDefinition：收集 phase 名、声明式安全闸门、
 * 展开默认值 + 绑定函数、推导 initial/terminal_state、绑定 workflow 级函数、归一化 transitions。
 * examples 模板（loadJsonWorkflow 解析 json 后）与 native DB 工作流（解析 spec_json、
 * tsModule=null）共用此构建路径——统一入口。
 */
export function buildWorkflowDefinition(
  wfDef: Record<string, unknown>,
  tsModule: Record<string, unknown> | null,
): WorkflowDefinition {
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

  // 声明式安全闸门（spec 2026-06-14 砖 3）：declarative:true → 硬拒任何用户 TS 代码。
  // 保证工作流没有任意 spawn / 文件 IO，能力上界由框架原语 + tools 授权钉死，可安全跨人运行。
  const declarative = wfDef["declarative"] === true;

  // 产出形态 delivers 从 phases **自动派生**（不再由用户手填）：有 deliver:X 阶段 → "X"。
  // 派生非空 → 注入 wfDef.delivers（下游 enqueue 闸门 / UI 读 wf.delivers 即拿派生值，整类「顶层 vs phase
  // 不一致」的错误从根上消失）；派生 null（无声明式 deliver 阶段）→ 保留 yaml 显式 delivers，兼容交付动作
  // 在 workflow.ts 的 ts 工作流（老 dev 的 run_submit_pr 那种）。rule①（一个工作流只产一种形态）在内校验。
  // 结构操作（只取 phase 的 deliver 字段值），不懂 'pr'/'artifacts' 含义，守 core 红线（同 requires.git 派生）。
  const derivedDelivers = deriveDelivers(rawPhases, String(wfDef["name"] ?? "?"));
  if (derivedDelivers !== null) wfDef["delivers"] = derivedDelivers;
  if (declarative && tsModule) {
    const fnExports = Object.keys(tsModule).filter((k) => typeof tsModule![k] === "function");
    if (fnExports.length > 0) {
      throw new Error(
        `声明式工作流「${wfDef["name"]}」(declarative: true) 不得包含任何 TS 函数，` +
        `但 workflow.ts 导出了：${fnExports.join(", ")}。` +
        `声明式工作流的 phase 只能用框架内置原语（prompt / gate / parallel）。`,
      );
    }
  }

  // 展开阶段默认值并绑定函数
  const workflowName = typeof wfDef["name"] === "string" ? (wfDef["name"] as string) : undefined;
  const expandedPhases: (PhaseDefinition | { parallel: ParallelDefinition })[] = [];
  for (const phase of rawPhases) {
    if (typeof phase !== "object" || !phase) continue;

    if ("parallel" in phase) {
      const par = phase["parallel"] as Record<string, unknown>;
      const parExpanded = expandParallelDefaults(par, allPhaseNames);
      // 绑定子阶段函数
      for (const sub of parExpanded.phases) {
        bindPhaseFunc(sub, tsModule, workflowName, declarative);
      }
      expandedPhases.push({ parallel: parExpanded });
    } else {
      const phaseExpanded = expandPhaseDefaults(phase as Record<string, unknown>, allPhaseNames);
      bindPhaseFunc(phaseExpanded, tsModule, workflowName, declarative);
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
    // failed = 执行失败终态（可重跑，区别于用户主动取消的 cancelled）。
    wfDef["terminal_states"] = ["done", "cancelled", "failed"];
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

/**
 * 从 phases **派生**工作流的产出形态 delivers（v2 R5 + 2026-06-22 收尾）：顶层 delivers 不再由用户手填，
 * 而是从「哪个阶段声明了 `deliver:`」自动派生——有 `deliver: pr` 阶段 → "pr"、`deliver: artifacts` → "artifacts"。
 * 这样整类「顶层声明与 phase 不一致」的错误从根上消失（顶层就是 phase 派生的，不可能矛盾），
 * 用户也不必在编辑器里手选一个可能错的值。
 *
 * 返回：
 *   - "pr" / "artifacts" —— 有声明式交付阶段（rule①：多个交付阶段 deliver 必须一致，否则抛错）
 *   - null —— 无任何声明式交付阶段（纯文本 / 评审工作流，或交付动作在 workflow.ts 的 ts 工作流；
 *     后者由 buildWorkflowDefinition 回退保留 yaml 显式 delivers 兼容）
 *
 * 结构操作：只取 phase 的 `deliver` 字段值，不需懂 'pr'/'artifacts' 的含义，守 core 红线
 * （枚举语义在 daemon/workflow-declarations.ts；这里与 requires.git 从 sandbox.git 派生同类）。
 */
function deriveDelivers(rawPhases: Record<string, unknown>[], name: string): string | null {
  const phaseDelivers: string[] = [];
  for (const p of rawPhases ?? []) {
    if (!p || typeof p !== "object") continue;
    if ("parallel" in p) {
      const subs = ((p["parallel"] as Record<string, unknown>)?.["phases"] as Record<string, unknown>[]) ?? [];
      for (const s of subs) if (s && typeof s["deliver"] === "string") phaseDelivers.push((s["deliver"] as string).trim());
    } else if (typeof p["deliver"] === "string") {
      phaseDelivers.push((p["deliver"] as string).trim());
    }
  }
  if (phaseDelivers.length === 0) return null;
  const distinct = [...new Set(phaseDelivers)];
  if (distinct.length > 1) {
    throw new Error(`工作流「${name}」声明了多种交付形态的阶段（${distinct.join(", ")}）——一个工作流只能产出一种形态。`);
  }
  return distinct[0];
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
  tsModule: Record<string, unknown> | null,
  workflowName?: string,
  declarative = false,
): void {
  const funcRef = phase.func;
  if (typeof funcRef === "function") return; // 已经是 callable

  // 框架内置交付：phase 声明 `deliver: artifacts` → 绑框架自带的 artifacts 交付器（无需用户 ts）。
  // 机械交付（promote 产物落表）收进框架；用户工作流只声明，不写 ts。
  if ((phase as Record<string, unknown>)["deliver"] === "artifacts") {
    phase.func = makeArtifactDeliverRunner(phase.name);
    return;
  }
  // 框架内置交付：phase 声明 `deliver: pr` → 绑框架自带的 PR 交付器（逐库 commit/push + gh 开 PR）。
  // 唯一含 spawn 的内置交付器，框架受信任代码；用户只声明（可选 pr_body_from 取某阶段产物作 PR body）。
  if ((phase as Record<string, unknown>)["deliver"] === "pr") {
    const bodyFrom = (phase as Record<string, unknown>)["pr_body_from"];
    phase.func = makePrDeliverRunner(phase.name, { bodyFromPhase: typeof bodyFrom === "string" ? bodyFrom : undefined });
    return;
  }

  const funcName = typeof funcRef === "string" ? funcRef : `run_${phase.name}`;

  // 声明式工作流：不绑定任何用户 TS 函数，只能 prompt-runner / 纯 gate 关卡。
  if (declarative) {
    if (tsModule && typeof tsModule[funcName] === "function") {
      throw new Error(
        `声明式工作流的阶段 "${phase.name}" 绑定了 TS 函数 "${funcName}"——` +
        `declarative: true 工作流不得含任意用户代码（phase 只能用 prompt / gate / parallel）`,
      );
    }
    if (workflowName) {
      const promptRunner = tryMakePromptRunnerForPhase(phase, workflowName);
      if (promptRunner) {
        phase.func = promptRunner;
        log.info("阶段 %s 使用 prompt-runner（声明式）", phase.name);
        return;
      }
    }
    // 纯人工关卡（gate=true，无 prompt）：no-op，runner 跑完即挂起到 awaiting_<phase>。
    if (phase.gate === true) {
      phase.func = async (_taskId: string) => {};
      return;
    }
    throw new Error(
      `声明式工作流的阶段 "${phase.name}" 缺少框架原语——需写 prompt: / gate（` +
      `declarative: true 工作流不能用 run_ 函数）`,
    );
  }

  // 提示词优先（全局）：phase 声明了非空 prompt 字段就用框架内置 prompt-runner，
  // 忽略同名 run_<phase> 函数。无 prompt 字段时（tryMake 返回 null）才回退到 ts 函数。
  // —— 这样「同 phase 既有 prompt 又有 ts」时 prompt 赢（与旧的 ts 优先相反）。
  if (workflowName) {
    const promptRunner = tryMakePromptRunnerForPhase(phase, workflowName);
    if (promptRunner) {
      phase.func = promptRunner;
      log.info("阶段 %s 使用 prompt-runner（提示词优先：yaml 有 prompt，忽略 ts run_ 函数）", phase.name);
      return;
    }
  }

  if (tsModule && typeof tsModule[funcName] === "function") {
    phase.func = tsModule[funcName] as (taskId: string) => Promise<void>;
    return;
  }

  log.warn("找不到阶段函数 %s", funcName);
  // 缺失的阶段函数在执行时抛出错误，防止工作流静默空跑
  phase.func = async (_taskId: string) => {
    throw new Error(
      `阶段函数 "${funcName}" 未定义且未提供 prompt 字段；请在 workflow.ts 中导出该函数，或在 yaml 中添加 prompt`,
    );
  };
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

    // gate：phase 跑完后挂起到 awaiting_<name>，等用户决断
    if (p.gate) {
      const awaiting = `awaiting_${p.name}`;
      const passTrigger = `${p.name}_pass`;
      const rejectTrigger = `${p.name}_reject_user`;

      // running → awaiting（runner 在阶段函数完成后自动触发）
      if (!transitions[running]) transitions[running] = [];
      transitions[running].push([`await_${p.name}`, awaiting]);

      // awaiting → next pending（用户 pass）
      if (!transitions[awaiting]) transitions[awaiting] = [];
      const nextPending = getNextPending(i);
      if (nextPending) {
        transitions[awaiting].push([passTrigger, nextPending]);
      } else {
        const doneState = terminalStates.has("done")
          ? "done"
          : [...terminalStates].find((s) => s !== "cancelled") ?? "done";
        transitions[awaiting].push([passTrigger, doneState]);
      }

      // awaiting → reject 目标（用户 reject）
      // jump_target 优先；否则回 pending_<phase> 重做本阶段
      const rejectTargetName = p.jump_target ?? p.name;
      const rejectTargetPhase = allFlatPhases.find((fp) => fp.name === rejectTargetName);
      if (rejectTargetPhase) {
        transitions[awaiting].push([rejectTrigger, rejectTargetPhase.pending_state]);
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
 * 由 DB 工作流的 spec_json 派生出一个完整 WorkflowDefinition：
 * - 解析 spec_json（JSON）拿 phases / 元信息（P2 后 yaml_content 列已删除）
 * - 校验 phase name 必须 ⊆ base 的 phase 集合
 * - 复用 base 的 phase 函数引用（不重新加载 TS）
 *
 * W1 限制：DB 工作流不支持 parallel 子句（W3 视情况扩）。
 */
function composeDbWorkflow(
  name: string,
  description: string,
  specJson: string,
  base: WorkflowDefinition,
): WorkflowDefinition {
  let parsed: { phases?: unknown[] } | null;
  try {
    parsed = JSON.parse(specJson) as { phases?: unknown[] };
  } catch (e: unknown) {
    throw new Error(`DB 工作流 ${name} spec_json 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || !Array.isArray(parsed.phases)) {
    throw new Error(`DB 工作流 ${name} spec_json 缺少 phases 字段`);
  }

  // 收集 base 已注册的 phase name 集合（含 parallel 子项）
  const basePhaseFunctions = new Set<string>();
  for (const p of base.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) basePhaseFunctions.add(sub.name);
    } else {
      basePhaseFunctions.add((p as PhaseDefinition).name);
    }
  }

  const newPhases: WorkflowDefinition["phases"] = [];
  for (const ph of parsed.phases) {
    if (typeof ph !== "object" || ph === null) {
      throw new Error(`DB 工作流 ${name} phase 项必须是对象`);
    }
    const phaseObj = ph as Record<string, unknown>;
    const phName = phaseObj.name;
    if (typeof phName !== "string") {
      throw new Error(`DB 工作流 ${name} phase 缺 name`);
    }
    if (!basePhaseFunctions.has(phName)) {
      throw new Error(
        `DB 工作流 ${name} 含 base "${base.name}" 没有的 phase: ${phName}`
      );
    }
    const basePhase = findFlatPhase(base, phName);
    if (!basePhase) {
      throw new Error(`base ${base.name} 内部找不到 phase ${phName}（不应发生）`);
    }
    const merged: PhaseDefinition = { ...basePhase };
    if (typeof phaseObj.timeout === "number") merged.timeout = phaseObj.timeout;
    if (typeof phaseObj.agent === "string" || (phaseObj.agent !== null && typeof phaseObj.agent === "object")) {
      merged.agent = phaseObj.agent as PhaseDefinition["agent"];
    }
    if (typeof phaseObj.label === "string") merged.label = phaseObj.label;
    if (typeof phaseObj.reject === "string") {
      merged.jump_trigger = `${phName}_reject`;
      merged.jump_target = phaseObj.reject;
    }
    if (phaseObj.decision && typeof phaseObj.decision === "object") {
      merged.decision = phaseObj.decision as PhaseDecision;
    }
    lintPhaseDecision(merged as unknown as Record<string, unknown>, phName);
    // DB 工作流覆写 prompt：声明了 prompt → 用 prompt-runner 取代 base 的 func
    if (typeof phaseObj.prompt === "string" && phaseObj.prompt.trim()) {
      (merged as Record<string, unknown>)["prompt"] = phaseObj.prompt;
      const promptFn = tryMakePromptRunnerForPhase(merged, name);
      if (promptFn) merged.func = promptFn;
    }
    newPhases.push(merged);
  }

  const composed: WorkflowDefinition = {
    name,
    description,
    phases: newPhases,
    initial_state: base.initial_state,
    terminal_states: base.terminal_states,
  };
  if (base.sandbox !== undefined) composed.sandbox = base.sandbox;
  // 声明层随 base 继承（派生工作流的输入/产出形态默认同 base；DB 派生层暂不支持覆写）
  if (base.requires !== undefined) composed.requires = base.requires;
  if (base.delivers !== undefined) composed.delivers = base.delivers;
  if (base.setup_func !== undefined) composed.setup_func = base.setup_func;
  if (base.notify_func !== undefined) composed.notify_func = base.notify_func;
  if (base.config !== undefined) composed.config = base.config;
  if (base.hooks !== undefined) composed.hooks = base.hooks;
  return composed;
}

/**
 * 独立 DB 工作流（kind=native）：从 spec_json 自包含组装完整 WorkflowDefinition，**不寄生 base**。
 * 复用 buildWorkflowDefinition（与 file 工作流同一构建路径）；强制 declarative（tsModule=null +
 * declarative:true）——无任意用户 ts，能力上界由框架原语 + 内置交付器钉死，DB 不存可 eval 代码。
 */
function composeNativeDbWorkflow(
  name: string,
  description: string,
  specJson: string,
): WorkflowDefinition {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(specJson) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`native 工作流 ${name} spec_json 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc["phases"])) {
    throw new Error(`native 工作流 ${name} spec_json 缺 phases 字段`);
  }
  // 名字 / 描述以 DB 行为准；强制 declarative（无 ts）
  doc["name"] = name;
  doc["description"] = description;
  doc["declarative"] = true;
  // 声明层归一（与 file-load 路径一致，2026-06-22 补——此前 DB native 跳过这步）：requires.git 二态归一
  // ——删废弃的 "optional" 等非 true/false 值 → 回退派生自 sandbox.git；delivers 形状同理。否则改造前
  // import 的含 requires.git:"optional" 的 spec_json 会原样幸存、运行时静默翻成「必须有库」拒掉无库需求。
  normalizeDeclarations(doc, `<native:${name}>`);
  return buildWorkflowDefinition(doc, null);
}

/** 在 base 的 phases 里扁平查找指定 name，含 parallel 子项 */
function findFlatPhase(
  base: WorkflowDefinition,
  name: string,
): PhaseDefinition | null {
  for (const p of base.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) {
        if (sub.name === name) return sub;
      }
    } else if ((p as PhaseDefinition).name === name) {
      return p as PhaseDefinition;
    }
  }
  return null;
}

/**
 * Discover（file 轨退役后单源：DB）：
 * 扫 workflows 表所有行注册——native/template 自包含（spec_json 组装），derived 寄生 base
 * 二遍解析。不再扫 ~/.autopilot/workflows/ 目录、不再加载 workflow.ts（migration 052 已把
 * 存量目录工作流救进 DB；残留 source='file' 行视为死行跳过并告警）。
 */
export async function discover(): Promise<void> {
  let rows: ReturnType<typeof listWorkflowsInDb> = [];
  try {
    rows = listWorkflowsInDb();
  } catch (e: unknown) {
    log.error(
      "读取 workflows 表失败：%s",
      e instanceof Error ? e.message : String(e)
    );
  }
  // 两遍：先注册自包含工作流（native / template），再处理寄生 base 的 derived 行。
  // 单遍时若 derived 行字母序排在其 base 之前，base 尚未 register → 解析失败；两遍消除这个顺序依赖。
  const derivedRows: typeof rows = [];
  for (const row of rows) {
    if (row.source === "file") {
      // file 轨已退役：正常情况下 migration 052 已把 file 行转 native 或删除；
      // 走到这说明 052 之后又出现了 file 行（不应发生），跳过并告警。
      log.warn("工作流 %s 是 file 轨残留行（source=file）——file 轨已退役，跳过注册；请用 workflow create 重建", row.name);
      continue;
    } else if (row.kind === "native" || row.kind === "template") {
      // 独立 DB 工作流：从 spec_json 自包含组装，不依赖 file base
      try {
        if (!row.spec_json) {
          log.error("native 工作流 %s 缺 spec_json，跳过", row.name);
          continue;
        }
        const wf = composeNativeDbWorkflow(row.name, row.description, row.spec_json);
        register(wf);
        log.debug("注册 native 工作流：%s（kind=%s）", row.name, row.kind);
      } catch (e: unknown) {
        log.error("加载 native 工作流 %s 失败：%s", row.name, e instanceof Error ? e.message : String(e));
      }
    } else {
      derivedRows.push(row); // 推迟到第二遍，确保 base（file 或 native）已注册
    }
  }
  for (const row of derivedRows) {
    // 派生 DB 工作流（kind=derived）：base 从第一遍已注册的 _registry 解析（native/template）。
    const base = _registry.get(row.derives_from!);
    if (!base) {
      log.error(
        "DB 工作流 %s derives_from %s 不存在或未加载成功，跳过",
        row.name,
        row.derives_from
      );
      continue;
    }
    try {
      if (!row.spec_json) {
        log.error("derived 工作流 %s 缺 spec_json，跳过（请运行迁移 053 回填）", row.name);
        continue;
      }
      const wf = composeDbWorkflow(row.name, row.description, row.spec_json, base);
      register(wf);
      log.debug("注册 db 工作流：%s（派生自 %s）", row.name, row.derives_from);
    } catch (e: unknown) {
      log.error(
        "加载 DB 工作流 %s 失败：%s",
        row.name,
        e instanceof Error ? e.message : String(e)
      );
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

export function listWorkflows(): {
  name: string;
  label?: string;
  description: string;
  /** 声明层（v2 R5）：git 输入要求（二态，含缺省派生），客户端据此调整代码库确认 UI */
  requires_git: boolean;
  /** 声明层（v2 R5）：产出形态字符串透传（"pr"/"artifacts"…），缺省 undefined = 事实推断 */
  delivers?: string;
}[] {
  // `__` 前缀 = 内置平台工作流（registerBuiltin），不进列表：用户不可选它起任务 /
  // 设为需求工作流，UI / CLI 列表也不展示。getWorkflow / 状态机 / watcher 照常工作
  //（watcher 的终态集合对内置工作流由 done/cancelled/failed 固定兜底覆盖）。
  return [..._registry.values()]
    .filter((wf) => !wf.name.startsWith("__"))
    .map((wf) => ({
      name: wf.name,
      label: wf.label,
      description: wf.description ?? "",
      requires_git: getWorkflowGitRequirement(wf),
      delivers: wf.delivers,
    }));
}

/**
 * 反查引用了某 provider 的工作流（provider 条目化：删除守卫 + 「无法使用」标记用）。
 *
 * 「引用」= phase.agent.provider === name，**或** phase 无显式 agent.provider 时隐式
 * 引用 DEFAULT_AGENT.provider（删默认 provider 会让所有未指定的 phase 失效）。
 * 遍历全部已注册工作流（含 __ 内置），处理 parallel 子阶段。
 */
export function listWorkflowsUsingProvider(providerName: string): { workflow: string; phases: string[] }[] {
  const out: { workflow: string; phases: string[] }[] = [];
  const effProviderOf = (ph: PhaseDefinition): string => {
    const ag = ph.agent;
    if (ag && typeof ag === "object" && typeof (ag as { provider?: unknown }).provider === "string") {
      return (ag as { provider: string }).provider;
    }
    return DEFAULT_AGENT.provider; // 无显式 provider → 隐式引用默认
  };
  for (const wf of _registry.values()) {
    const hits: string[] = [];
    for (const phase of wf.phases) {
      if (isParallelPhase(phase)) {
        for (const sub of phase.parallel.phases) {
          if (effProviderOf(sub) === providerName) hits.push(sub.name);
        }
      } else if (effProviderOf(phase as PhaseDefinition) === providerName) {
        hits.push((phase as PhaseDefinition).name);
      }
    }
    if (hits.length > 0) out.push({ workflow: wf.name, phases: hits });
  }
  return out;
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
 * 读取工作流 TS 源文件原文
 */
export function getWorkflowTs(workflowName: string): string | null {
  const tsPath = join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.ts");
  if (!existsSync(tsPath)) return null;
  return readFileSync(tsPath, "utf-8");
}

/**
 * 读取工作流 spec（JSON 文本）。
 * P2 后所有工作流的真相在 DB spec_json 列（yaml_content 列已删除）。
 * file 轨已退役：磁盘 workflow.yaml 不再是真相源。
 *
 * 返回 DB 行的 spec_json；行不存在或 spec_json 为 null 返回 null。
 */
export function getWorkflowSpec(workflowName: string): string | null {
  // P2 后：spec_json 是 DB 唯一真相；磁盘 yaml 已不读
  // 注：需要使用者（routes / rpc）调用此函数而非读老 yaml 路径
  return null; // 调用方统一改从 DB row.spec_json 读（不经此路由）
}

/**
 * @deprecated P2 后 yaml 文件已不再是真相源。等价调用 getWorkflowSpec。
 * 保留签名让老调用方在编译层得到类型提示，运行时返回 null（file 轨退役后磁盘无 yaml）。
 */
export function getWorkflowYaml(workflowName: string): string | null {
  return getWorkflowSpec(workflowName);
}

// ──────────────────────────────────────────────
// 工作流命名（file 轨退役后创建/删除均走 DB：workflows.ts）
// ──────────────────────────────────────────────

export const WORKFLOW_NAME_RE = /^[a-z][a-z0-9_\-]{0,39}$/;

/**
 * YAML 字段类型归一化 —— 用户手写 YAML 容易把 description 写成数字、
 * phases.timeout 写成字符串等。这里做最低限度的容错：非预期类型会警告
 * 并尽量转换，避免下游组件（Web UI / CLI）渲染 "— 11" 之类异常。
 */
function normalizeWorkflowFields(wfDef: Record<string, unknown>, yamlPath: string): void {
  // description 必须是字符串
  if ("description" in wfDef && typeof wfDef.description !== "string") {
    log.warn("workflow.yaml %s：description 应为字符串，当前值 %o 已自动转为字符串",
      yamlPath, wfDef.description);
    wfDef.description = wfDef.description == null ? "" : String(wfDef.description);
  }
  // name 必须是字符串（虽然缺失更常见）
  if ("name" in wfDef && typeof wfDef.name !== "string") {
    log.warn("workflow.yaml %s：name 应为字符串，当前 %o 已转为字符串",
      yamlPath, wfDef.name);
    wfDef.name = String(wfDef.name);
  }
}

/**
 * `workspace:` 段已更名为 `sandbox:`。归一化：
 *   - 若存在 sandbox 段 → 原样用（删掉残留的 workspace 段，避免 spread 时覆盖）
 *   - 否则若存在老 workspace 段 → 搬到 sandbox 并打 deprecation warning
 */
function normalizeSandboxSection(wfDef: Record<string, unknown>, yamlPath: string): void {
  if ("sandbox" in wfDef && wfDef.sandbox && typeof wfDef.sandbox === "object") {
    delete wfDef.workspace;
    return;
  }
  if ("workspace" in wfDef && wfDef.workspace && typeof wfDef.workspace === "object") {
    log.warn(
      "workflow.yaml %s：`workspace:` 段已更名为 `sandbox:`，请尽快迁移（本次回退读老字段）",
      yamlPath,
    );
    wfDef.sandbox = wfDef.workspace;
    delete wfDef.workspace;
  }
}

/**
 * 声明层（requires / delivers）形状归一 + lint（v2 R5）。
 * 只管形状：requires 须是对象、requires.git 须是 boolean|"optional"、delivers 须是字符串，
 * 非法形状删除 + warn（回退缺省派生）。**不校验枚举值**——'pr'/'artifacts' 的语义在 daemon。
 * lint：requires.git===true 而 sandbox.git 缺失 → warn（声明要 git 却没有 git 沙盒供给，
 * 任务会在空目录里跑——大概率是漏写 sandbox.git）。
 */
function normalizeDeclarations(wfDef: Record<string, unknown>, yamlPath: string): void {
  if ("requires" in wfDef && wfDef.requires !== undefined) {
    if (!wfDef.requires || typeof wfDef.requires !== "object" || Array.isArray(wfDef.requires)) {
      log.warn("workflow.yaml %s：`requires:` 应为对象（如 {git: true}），已忽略", yamlPath);
      delete wfDef.requires;
    } else {
      const r = wfDef.requires as Record<string, unknown>;
      // requires.git 二态（2026-06-22：optional 废弃）。非 true/false 删除回退派生自 sandbox.git。
      if ("git" in r && r.git !== undefined && r.git !== true && r.git !== false) {
        log.warn("workflow.yaml %s：`requires.git` 应为 true/false（optional 已废弃），当前 %o 已忽略（回退派生自 sandbox.git）",
          yamlPath, r.git);
        delete r.git;
      }
    }
  }
  if ("delivers" in wfDef && wfDef.delivers !== undefined && typeof wfDef.delivers !== "string") {
    log.warn("workflow.yaml %s：`delivers:` 应为字符串，当前 %o 已忽略（回退事实推断）", yamlPath, wfDef.delivers);
    delete wfDef.delivers;
  }
  // 注：原「requires.git=true 但 sandbox.git 缺失 → warn」的 lint 已删——sandbox.git 现在从 requires.git
  // 派生（getWorkflowGitSandbox），需要代码库就一定建 git 沙盒，不存在「声明要 git 却没沙盒」的漏写。
}

/**
 * 工作流的 git 输入要求（声明层缺省派生，纯形状推导无业务语义）：「需要代码库」**二态**（需要 / 不需要）。
 * requires.git 显式（true/false）优先；缺省回退派生自 sandbox.git（兼容只写 sandbox.git 的老工作流）。
 * （2026-06-22：optional 第三态废弃——只剩 需要 / 不需要。）
 */
export function getWorkflowGitRequirement(wf: WorkflowDefinition): boolean {
  const g = wf.requires?.git;
  if (g === true || g === false) return g;
  return wf.sandbox?.git === true;
}

/**
 * 工作流是否建 git 沙盒（clone 代码到任务目录）——**从 requires.git 派生，不再是单独旋钮**
 * （2026-06-22：与 delivers 从 phase 派生同构——「建 git 沙盒」是「需要代码库」的实现，只要需要代码库
 * 就一定 clone）。显式 sandbox.git（true/false）优先（兼容只写 sandbox.git 的老工作流）；
 * 缺省 = getWorkflowGitRequirement（需要 → clone、不需要 → 不 clone）。task-factory 读它决定建不建 git 沙盒。
 */
export function getWorkflowGitSandbox(wf: WorkflowDefinition): boolean {
  const explicit = wf.sandbox?.git;
  if (typeof explicit === "boolean") return explicit;
  return getWorkflowGitRequirement(wf);
}

// ──────────────────────────────────────────────
// 阶段级结构化编辑（保留 YAML 其他段）
// ──────────────────────────────────────────────

export interface PhaseInput {
  name: string;
  timeout?: number;
  reject?: string | null;
  // 注：retry_on_failure 等字段不在框架白名单内——它们走 cleanSinglePhase 的
  // 通用未知字段透传（写进 yaml 但执行引擎不消费），不作为一等字段声明。
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

/** @internal 导出供 registry-authoring.ts 兄弟模块用。 */
export function isParallelInput(p: PhaseEntryInput): p is ParallelPhaseInput {
  return "parallel" in p && p.parallel !== null && typeof p.parallel === "object";
}

/** @internal 导出供 registry-authoring.ts 兄弟模块用。 */
export function getWorkflowYamlPath(workflowName: string): string {
  return join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.yaml");
}

