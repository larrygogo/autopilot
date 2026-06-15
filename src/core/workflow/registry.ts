import type { TransitionTable } from "../state-machine";
import { log } from "../logger";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join, sep } from "path";
import { parse as parseYaml } from "yaml";
import { tryMakePromptRunnerForPhase } from "./prompt-runner";
import type { PhaseDecision } from "./phase-decision";
import { DEFAULT_AGENT, type InlineAgentConfig } from "../agent-defaults";
import {
  syncFileWorkflowsToDb,
  listWorkflowsInDb,
  type FileWorkflowScan,
} from "./workflows";

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
  /** true=必须有代码库；false=不要求；"optional"=可有可无（有就 clone 作参考） */
  git?: boolean | "optional";
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
  if (mode !== undefined && mode !== "marker" && mode !== "judge") {
    throw new Error(`阶段 ${phaseName} 的 decision.mode 只能是 "marker" 或 "judge"`);
  }
  // marker 模式（缺省）才需要 pass/reject 标记串；judge 模式靠结构化裁判，不写标记。
  if (mode !== "judge") {
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
    // Schema 级归一化：允许字段类型宽松但会转为正确类型并记警告
    normalizeWorkflowFields(wfDef, yamlPath);
    // `workspace:` 段已更名为 `sandbox:`；优先读 sandbox，回退老字段并 warn
    normalizeSandboxSection(wfDef, yamlPath);
    // 声明层（requires/delivers）：只做形状归一 + lint，不校验枚举值（语义在 daemon）
    normalizeDeclarations(wfDef, yamlPath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("解析 YAML 工作流 %s 失败：%s", yamlPath, message);
    return null;
  }

  // 动态 import workflow.ts（如果存在）。
  // Bun 的 ESM import() 会按路径缓存，一旦首次加载，后续 reload 即使磁盘变化
  // 仍拿到旧版本。加 ?t=<mtime> query 强制每次文件变动后重新加载。
  //
  // 别名兜底：Bun.plugin 的 onResolve 在 dynamic import 后续静态 import 链上
  // 不一定生效。所以加载前读文件，把 `@autopilot/...` 字符串替换为绝对路径
  // 再写到 cache 临时文件 import，确保 examples cp 到 ~/.autopilot/workflows/
  // 后能直接跑。
  let tsModule: Record<string, unknown> | null = null;
  if (existsSync(tsPath)) {
    try {
      const { statSync, readFileSync, writeFileSync, mkdirSync } = await import("fs");
      const { join: joinPath, dirname: dirnamePath, basename: basenamePath, relative: relativePath } = await import("path");
      const { getAutopilotSrcPath } = await import("../autopilot-resolver");

      const mtime = statSync(tsPath).mtimeMs;
      let importPath = tsPath;

      const content = readFileSync(tsPath, "utf-8");
      if (/(["'])@autopilot\//.test(content)) {
        const srcPath = getAutopilotSrcPath();
        const cacheDir = joinPath(getAutopilotHomeDynamic(), "runtime", "cache", "workflows");
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        const wfDirName = basenamePath(dirnamePath(tsPath));
        const cachedPath = joinPath(cacheDir, `${wfDirName}.${mtime}.ts`);
        // 用相对路径 import 框架代码：避免绝对路径与 daemon 主进程相对路径
        // 解析到不同的 module instance（导致 registry 状态丢失）
        const relSrc = relativePath(cacheDir, srcPath).replace(/\\/g, "/");
        const resolved = content.replace(
          /(["'])@autopilot\//g,
          (_m, q) => `${q}${relSrc}/`,
        );
        writeFileSync(cachedPath, resolved, "utf-8");
        importPath = cachedPath;
      }

      tsModule = await import(`${importPath}?t=${mtime}`) as Record<string, unknown>;
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

  // 声明式安全闸门（spec 2026-06-14 砖 3）：declarative:true → 硬拒任何用户 TS 代码。
  // 保证工作流没有任意 spawn / 文件 IO，能力上界由框架原语 + tools 授权钉死，可安全跨人运行。
  const declarative = wfDef["declarative"] === true;
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

  if (tsModule && typeof tsModule[funcName] === "function") {
    phase.func = tsModule[funcName] as (taskId: string) => Promise<void>;
    return;
  }

  // ts 函数缺失：如果 phase 声明了 prompt 字段，用框架内置的 prompt-runner 替代。
  // 这是"零代码工作流"路径——用户只在 yaml 写 prompt，无需写 ts。
  if (workflowName) {
    const promptRunner = tryMakePromptRunnerForPhase(phase, workflowName);
    if (promptRunner) {
      phase.func = promptRunner;
      log.info("阶段 %s 使用 prompt-runner（无 ts 函数，yaml 里有 prompt 字段）", phase.name);
      return;
    }
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
 * 由 DB 工作流的 yaml 派生出一个完整 WorkflowDefinition：
 * - 解析 yaml 拿 phases / 元信息
 * - 校验 phase name 必须 ⊆ base 的 phase 集合
 * - 复用 base 的 phase 函数引用（不重新加载 TS）
 *
 * W1 限制：DB 工作流不支持 parallel 子句（W3 视情况扩）。
 */
function composeDbWorkflow(
  name: string,
  description: string,
  yamlContent: string,
  base: WorkflowDefinition,
): WorkflowDefinition {
  const parsed = parseYaml(yamlContent) as { phases?: unknown[] } | null;
  if (!parsed || !Array.isArray(parsed.phases)) {
    throw new Error(`DB 工作流 ${name} yaml 缺少 phases 字段`);
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
 * Discover 多源加载（W1）：
 *   1. 扫文件系统 ~/.autopilot/workflows/（沿用 loadYamlWorkflow 加载 yaml + ts）
 *   2. 把扫到的文件工作流同步到 workflows 表（source=file 镜像）
 *   3. 扫 workflows 表所有行：
 *      - source=file：用 step 1 的内存 def 注册
 *      - source=db：解析 yaml，校验 phase name ⊆ derives_from 的 phase 集合，
 *        从 base 复制 phase 函数引用，注册
 */
export async function discover(): Promise<void> {
  const userWfDir = join(getAutopilotHomeDynamic(), "workflows");

  // (1) 扫文件系统
  const fileDefs = new Map<string, WorkflowDefinition>();
  const scanInputs: FileWorkflowScan[] = [];
  if (existsSync(userWfDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(userWfDir).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith("_")) continue;
      const subDir = join(userWfDir, entry);
      const yamlPath = join(subDir, "workflow.yaml");
      if (!existsSync(yamlPath)) continue;
      try {
        const wf = await loadYamlWorkflow(subDir);
        if (!wf) continue;
        // 目录名 vs yaml 顶层 name 不一致警告——这通常是用户手工拷贝/移动了目录
        // 但忘了改 yaml 里的 name，会导致跟源工作流同名互相覆盖、其中一个不可见
        if (wf.name !== entry) {
          log.warn(
            "工作流目录名 (%s) 与 workflow.yaml name 字段 (%s) 不一致；推荐改 yaml 让两者一致，否则同名会被覆盖",
            entry, wf.name,
          );
        }
        if (fileDefs.has(wf.name)) {
          log.warn(
            "检测到重名工作流：%s 已被加载，目录 %s 的 yaml 也声明 name=%s，将覆盖前者",
            wf.name, subDir, wf.name,
          );
        }
        fileDefs.set(wf.name, wf);
        const yaml_content = readFileSync(yamlPath, "utf-8");
        scanInputs.push({
          name: wf.name,
          description: wf.description ?? "",
          yaml_content,
          file_path: subDir,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log.warn("加载 YAML 工作流 %s 失败：%s", subDir, message);
      }
    }
  }

  // (2) 同步到 DB
  let syncOk = true;
  try {
    syncFileWorkflowsToDb(scanInputs);
  } catch (e: unknown) {
    syncOk = false;
    log.error(
      "同步文件工作流到 DB 失败：%s",
      e instanceof Error ? e.message : String(e)
    );
  }

  // (3) 从 DB 读所有行注册；DB 不可用时回退为仅注册文件
  let rows: ReturnType<typeof listWorkflowsInDb> = [];
  if (syncOk) {
    try {
      rows = listWorkflowsInDb();
    } catch (e: unknown) {
      log.error(
        "读取 workflows 表失败：%s",
        e instanceof Error ? e.message : String(e)
      );
    }
  }
  if (rows.length === 0 && fileDefs.size > 0) {
    // DB 不可用 / 表不存在 / 同步失败 — 至少把文件工作流注册进去
    for (const def of fileDefs.values()) {
      register(def);
      log.debug("注册 file 工作流（仅文件，DB 同步未就绪）：%s", def.name);
    }
    return;
  }
  for (const row of rows) {
    if (row.source === "file") {
      const def = fileDefs.get(row.name);
      if (!def) {
        log.error("DB workflow %s source=file 但内存没有对应 def，跳过", row.name);
        continue;
      }
      register(def);
      log.debug("注册 file 工作流：%s（来自 %s）", row.name, row.file_path);
    } else {
      const base = fileDefs.get(row.derives_from!);
      if (!base) {
        log.error(
          "DB 工作流 %s derives_from %s 不存在或未加载成功，跳过",
          row.name,
          row.derives_from
        );
        continue;
      }
      try {
        const wf = composeDbWorkflow(row.name, row.description, row.yaml_content, base);
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
  /** 声明层（v2 R5）：git 输入要求（含缺省派生），客户端据此调整代码库确认 UI */
  requires_git: boolean | "optional";
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
 * 读取工作流 YAML 原文
 */
export function getWorkflowYaml(workflowName: string): string | null {
  const yamlPath = join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.yaml");
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

  const yamlPath = join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.yaml");
  if (!existsSync(join(getAutopilotHomeDynamic(), "workflows", workflowName))) {
    throw new Error(`工作流目录不存在：${workflowName}`);
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

  const wfRoot = join(getAutopilotHomeDynamic(), "workflows");
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
    throw new Error(`工作流名称 "${workflowName}" 非法（只允许字母/数字/._-）`);
  }
  const wfRoot = join(getAutopilotHomeDynamic(), "workflows");
  const dir = join(wfRoot, workflowName);
  // 安全校验：最终路径必须仍在 wfRoot 下（防 path traversal）。
  // 必须用平台 sep —— 硬编码 "/" 在 Windows 上（join 产出反斜杠）永不匹配，
  // 会把所有合法删除误杀成「非法路径」（2026-06-12 事故：工作流全部无法删除）
  if (!dir.startsWith(wfRoot + sep) && dir !== wfRoot) {
    throw new Error(`非法路径：${dir}（必须在 ${wfRoot} 下）`);
  }
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

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
      if ("git" in r && r.git !== undefined && r.git !== true && r.git !== false && r.git !== "optional") {
        log.warn("workflow.yaml %s：`requires.git` 应为 true/false/\"optional\"，当前 %o 已忽略（回退派生自 sandbox.git）",
          yamlPath, r.git);
        delete r.git;
      }
    }
  }
  if ("delivers" in wfDef && wfDef.delivers !== undefined && typeof wfDef.delivers !== "string") {
    log.warn("workflow.yaml %s：`delivers:` 应为字符串，当前 %o 已忽略（回退事实推断）", yamlPath, wfDef.delivers);
    delete wfDef.delivers;
  }
  const requiresGit = (wfDef.requires as WorkflowRequiresSpec | undefined)?.git;
  const sandboxGit = (wfDef.sandbox as WorkflowSandboxSpec | undefined)?.git;
  if (requiresGit === true && sandboxGit !== true) {
    log.warn("workflow.yaml %s：requires.git=true 但 sandbox.git 缺失——任务不会建代码沙盒，请补 `sandbox: {git: true}`",
      yamlPath);
  }
}

/**
 * 工作流的 git 输入要求（声明层缺省派生，纯形状推导无业务语义）：
 * requires.git 显式声明优先；缺省派生 = sandbox.git ?? false（老工作流零感知）。
 */
export function getWorkflowGitRequirement(wf: WorkflowDefinition): boolean | "optional" {
  const g = wf.requires?.git;
  if (g === true || g === false || g === "optional") return g;
  return wf.sandbox?.git === true;
}

function renderWorkflowYamlTemplate(name: string, description: string | undefined, firstPhase: string): string {
  const desc = description?.trim() ? description.trim() : "请补充描述";
  return `name: ${name}
description: ${desc}

# 可选：每个任务自动创建一个独立的 sandbox 沙盒（路径经 getTaskSandbox 解析，
# 新任务落 runtime/requirements/<req-id>/runs/<task-id>/workspace/），阶段函数在这里工作
# sandbox:
#   template: workspace_template   # 工作流目录下的模板文件夹，任务启动时 cp -r 到 sandbox

# 工作流阶段列表。最简写法：只写 name 和 timeout，状态机将自动推导：
#   pending_<name> / running_<name> / start_<name> / complete_<name>
# 更多写法（并行、reject 跳转、自定义状态）见 docs/workflow-development.md
phases:
  - name: ${firstPhase}
    timeout: 900
    # 可选：为该 phase 内联配置 agent（省略则用 DEFAULT_AGENT 兜底）
    # agent:
    #   provider: anthropic
    #   model: claude-sonnet-4-6
    #   system_prompt: "特化提示词..."
`;
}

// 脚手架模板：sandbox 路径必须走 @autopilot/core/sandbox 的 getTaskSandbox（双根解析）——
// v2 R2 起新任务文件落 runtime/requirements/<reqId>/runs/<taskId>/，手写拼接
// runtime/tasks/<taskId> 的旧写法对新任务定位不到目录。
function renderWorkflowTsTemplate(firstPhase: string): string {
  const fn = `run_${firstPhase}`;
  return `// 每个 phase 函数接收 taskId: string 参数；抛错则该阶段失败，
// 可被状态机重试或驳回。详见 docs/workflow-development.md
//
// 每次任务自动获得一个独立的 sandbox 目录（路径经 getTaskSandbox 解析，勿手写拼接）。
// 阶段函数应把所有产出 / 读写都放在这里，保持任务之间隔离。
// 如需把 sandbox 传给 agent，调用 agent.run(prompt, { cwd: wsPath })。
//
// 常见 import（按需启用）：
//   import { getTask } from "@autopilot/core/db";             // 取任务对象
//   import { agentForPhase } from "@autopilot/agents/registry"; // 按 phase 取内联配置 agent
//   import { listTaskRepos } from "@autopilot/core/sandbox";  // git 工作流取各仓库 clone 布局

import { getTaskSandbox } from "@autopilot/core/sandbox";

export async function ${fn}(taskId: string): Promise<void> {
  const ws = getTaskSandbox(taskId);
  console.log(\`[\${taskId}] 执行阶段 ${firstPhase}，sandbox=\${ws}\`);
  // TODO: 在这里实现阶段业务逻辑。例如：
  //   const agent = agentForPhase("<工作流名>", "${firstPhase}");
  //   await agent.run("修改 src/index.ts 添加 hello 函数", { cwd: ws });
}
`;
}

// ──────────────────────────────────────────────
// 阶段级结构化编辑（保留 YAML 其他段）
// ──────────────────────────────────────────────

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

/** @internal 导出供 registry-authoring.ts 兄弟模块用。 */
export function isParallelInput(p: PhaseEntryInput): p is ParallelPhaseInput {
  return "parallel" in p && p.parallel !== null && typeof p.parallel === "object";
}

/** @internal 导出供 registry-authoring.ts 兄弟模块用。 */
export function getWorkflowYamlPath(workflowName: string): string {
  return join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.yaml");
}

/** @internal 导出供 workflow-ts-authoring.ts 兄弟模块用（workflow.ts 源码改写）。 */
export function getWorkflowTsPath(workflowName: string): string {
  return join(getAutopilotHomeDynamic(), "workflows", workflowName, "workflow.ts");
}
