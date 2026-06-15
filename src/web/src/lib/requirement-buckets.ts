// 需求 4 段 tab 的状态映射（被 ProjectDetail 页和新 Requirements 全局页共用）。
//
// 分桶原则 = 「球在谁手里」，与流水线页（Tasks.tsx 的需求分桶）语义一致：
//   等待人工：drafting（确认代码库/开始澄清）、clarifying（回答 AI）、ready（提交审批）、
//             awaiting_approval（审批签字）、awaiting_review（去 review/merge PR）、
//             failed（停下报人：决定重试或放弃）—— 没有你的动作工作不会前进
//   运行中：queued、running、fix_revision —— 系统在干活，不需要你
//   归档：done、cancelled —— 真终态（failed 可重试，不算归档）
//
// 历史教训：本函数曾把 awaiting_review/drafting/ready 归「运行中」、failed 归「归档」，
// 与流水线漂移——同一条「待 PR review」的需求在项目页和流水线页分类不同。

export type ReqTab = "human" | "running" | "archived";

/** ProjectDetail 页内部使用（旧名保持向后兼容，代理到新函数）。 */
export type ProjectReqTab = ReqTab;

/**
 * 需求状态 → 4 段 tab 分桶。
 * 新页面（全局 /requirements）与 ProjectDetail 页共用此函数。
 */
export function requirementTab(status: string): ReqTab {
  // 系统在干活
  if (status === "queued" || status === "running" || status === "fix_revision") return "running";
  // 真终态（failed 可重试 → 归「等待人工」停下报人）
  if (status === "done" || status === "cancelled") return "archived";
  // 其余（drafting / clarifying / ready / awaiting_approval / awaiting_review / failed /
  // 未知状态兜底）→ 球在用户：宁可提醒不可漏
  return "human";
}

/** 向后兼容：ProjectDetail.tsx 现用 projectReqTab，迁移期保留别名。 */
export const projectReqTab = requirementTab;
