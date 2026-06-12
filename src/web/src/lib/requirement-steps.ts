// 需求生命周期的 6 个步骤。status（细粒度状态机）→ step（步骤）的归并是这一页
// 信息架构的核心。真理来源：src/core/requirements.ts ALLOWED_TRANSITIONS。
export type ReqStep = "clarify" | "approve" | "queue" | "execute" | "review" | "done";

export const STEPS: { key: ReqStep; label: string }[] = [
  { key: "clarify", label: "澄清" },
  { key: "approve", label: "审批" },
  { key: "queue", label: "排队" },
  { key: "execute", label: "执行" },
  { key: "review", label: "验收" },
  { key: "done", label: "完成" },
];

export const STEP_ORDER: ReqStep[] = STEPS.map((s) => s.key);

/** 细粒度 status → 6 步骤。 */
export function statusToStep(status: string): ReqStep {
  switch (status) {
    case "drafting":
    case "clarifying":
    case "investigating":
      return "clarify";
    case "ready":
    case "awaiting_approval":
      return "approve";
    case "queued":
      return "queue";
    case "running":
      return "execute";
    // fix_revision 属于验收阶段的循环（验收 ⇄ 修复）：用户在验收页发审查意见，
    // 修复进度与结果也回到验收页 —— 当前步留在「验收」，不跳回「执行」
    case "awaiting_review":
    case "fix_revision":
      return "review";
    case "done":
    case "failed":
    case "cancelled":
    default:
      return "done";
  }
}

/**
 * 当前步解析：终态（cancelled/failed）时定位到「死亡步」（转终态前的状态对应的步），
 * 让 ✗ 画在实际失败处而不是固定画在「完成」步。无 status_before_terminal（历史数据 /
 * 执行前取消无从推断）时兜底回「完成」步（旧行为）。
 */
export function resolveCurrentStep(status: string, statusBeforeTerminal?: string | null): ReqStep {
  if ((status === "cancelled" || status === "failed") && statusBeforeTerminal) {
    return statusToStep(statusBeforeTerminal);
  }
  return statusToStep(status);
}

/**
 * 需求内容（title / spec / workspace）是否可编辑：审批通过即冻结——审批是用户对这份
 * spec 的签字，之后修改会让页面内容与 agent 执行快照脱节。failed 例外（补约束重试）。
 * 与 daemon RPC requirements.update 的闸门同规则（那边是权威，这里只管入口显隐）。
 */
export function canEditRequirementContent(status: string): boolean {
  return ["drafting", "clarifying", "ready", "awaiting_approval", "failed"].includes(status);
}

export type StepPosition = "past" | "current" | "future";

/** selected 相对 current 的时间位置，决定只读 / 可操作 / 占位。 */
export function stepPosition(selected: ReqStep, current: ReqStep): StepPosition {
  const si = STEP_ORDER.indexOf(selected);
  const ci = STEP_ORDER.indexOf(current);
  if (si < ci) return "past";
  if (si > ci) return "future";
  return "current";
}
