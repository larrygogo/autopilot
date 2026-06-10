// 需求 4 段 tab 的状态映射（被 ProjectDetail 页和新 Requirements 全局页共用）。
//
// 状态映射规则（与流水线 tab 对齐，需求页无 task 行，需求自己覆盖全生命周期）：
//   等待人工：clarifying（等用户回复）、awaiting_approval（等审批）
//   运行中：drafting、queued、running、awaiting_review、fix_revision 及任意其他活跃状态
//   归档：done、cancelled、failed

export type ReqTab = "human" | "running" | "archived";

/** ProjectDetail 页内部使用（旧名保持向后兼容，代理到新函数）。 */
export type ProjectReqTab = ReqTab;

/**
 * 需求状态 → 4 段 tab 分桶。
 * 新页面（全局 /requirements）与 ProjectDetail 页共用此函数。
 */
export function requirementTab(status: string): ReqTab {
  // 等待人工：球在用户那边
  if (status === "clarifying" || status === "awaiting_approval") return "human";
  // 归档：终态
  if (status === "done" || status === "cancelled" || status === "failed") return "archived";
  // 其余（drafting / queued / running / awaiting_review / fix_revision / ready / 未知状态）→ 运行中
  return "running";
}

/** 向后兼容：ProjectDetail.tsx 现用 projectReqTab，迁移期保留别名。 */
export const projectReqTab = requirementTab;
