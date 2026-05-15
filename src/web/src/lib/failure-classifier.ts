/**
 * 失败画像分类（best-effort heuristics）。
 *
 * 解决的产品断点：
 * 任务失败时，TaskOutcomeCard 只显示一行 `failure_reason`（可能是 "phase exited with
 * code 1" / 一段 stack trace / API 错误码）。用户**无法判断**这是 prompt 问题、
 * 凭证问题还是临时网络抖动，于是在"重跑"和"去工作流修复"之间盲选——通常是先
 * 盲目重跑一次，浪费 token 和时间。
 *
 * 这里用纯前端 keyword match 给失败原因打一个轻量画像 tag：
 *   credential / network / prompt / phase_crash / unknown
 *
 * 每个 tag 配一句话 hint + 推荐主操作，让 TaskOutcomeCard 据此重排按钮 variant，
 * 引导用户先做对的那一步。
 *
 * 这不是完整诊断系统，只是"比啥都不说"好一档。后续 daemon 侧拿到结构化错误后
 * 可以从后端给出更准的 tag。
 */

export type FailureKind = "credential" | "network" | "prompt" | "phase_crash" | "unknown";

/** 推荐主操作（决定哪个按钮变 default variant） */
export type FailurePrimaryAction = "retry" | "fix_prompt" | "check_config" | "view_logs";

export interface FailureProfile {
  kind: FailureKind;
  /** 中文短标签，显示为 tag */
  label: string;
  /** 一句话解释 + 建议（含"为什么"和"该先做什么"） */
  hint: string;
  /** 推荐主操作 */
  primary: FailurePrimaryAction;
}

const PATTERNS: Array<{ kind: FailureKind; rx: RegExp }> = [
  // 凭证 / 认证 — 改 prompt 没用，需要先调 provider/agent 配置
  {
    kind: "credential",
    rx: /(401|403|unauthorized|forbidden|invalid[\s_-]?api[\s_-]?key|invalid token|expired token|authentication failed|not authenticated|missing api key|api key.*invalid)/i,
  },
  // 网络 / 超时 — 临时性问题，直接重跑通常即可
  {
    kind: "network",
    rx: /(timeout|timed out|etimedout|econnreset|enotfound|eai_again|fetch failed|socket hang up|aborted|connection refused|econnrefused|network)/i,
  },
  // Prompt / 输出格式 — Agent 输出不符合预期，改 prompt 让输出更稳定
  {
    kind: "prompt",
    rx: /(invalid output|invalid json|json parse|parse error|unexpected token|missing field|schema|format error|no response|empty response|invalid response|cannot parse)/i,
  },
  // 阶段函数崩溃 — exit code 非 0 / 异常，需要看完整日志定位
  {
    kind: "phase_crash",
    rx: /(exit code|exited with|exception|crashed|killed|sigkill|sigterm|unhandled|typeerror|referenceerror|cannot read|undefined is not)/i,
  },
];

const PROFILES: Record<FailureKind, FailureProfile> = {
  credential: {
    kind: "credential",
    label: "凭证 / Token",
    hint: "看起来是 API 凭证或 Token 问题。直接重跑大概率还会失败，建议先去 Setup 检查 provider 配置和 CLI 登录状态。",
    primary: "check_config",
  },
  network: {
    kind: "network",
    label: "网络 / 超时",
    hint: "网络或超时类错误，跟代码 / prompt 无关。直接重跑通常就能恢复。",
    primary: "retry",
  },
  prompt: {
    kind: "prompt",
    label: "Prompt 输出格式",
    hint: "Agent 输出不符合预期（格式 / 字段不对）。建议去工作流改对应阶段的 prompt 让输出更稳定，再重跑。",
    primary: "fix_prompt",
  },
  phase_crash: {
    kind: "phase_crash",
    label: "阶段崩溃",
    hint: "阶段函数运行时崩溃（exit code 非 0 / 未捕获异常）。看下方完整日志定位代码问题。",
    primary: "view_logs",
  },
  unknown: {
    kind: "unknown",
    label: "未分类",
    hint: "无法自动判断失败类型。看下方完整日志确定问题，或直接重跑试试。",
    primary: "view_logs",
  },
};

export function classifyFailure(reason: string | null | undefined): FailureProfile {
  if (!reason || !reason.trim()) return PROFILES.unknown;
  for (const p of PATTERNS) {
    if (p.rx.test(reason)) return PROFILES[p.kind];
  }
  return PROFILES.unknown;
}
