// 项目详情页需求列表的 4 段 tab 分桶。
// 与流水线页不同：项目页没有 task 行，需求自己代表全生命周期，
// 所以 running/awaiting_review 等后段状态也要进桶（不能 task_id 去重跳过）。

export type ProjectReqTab = "human" | "running" | "archived";

export function projectReqTab(status: string): ProjectReqTab {
  if (status === "queued" || status === "running" || status === "fix_revision") return "running";
  if (status === "done" || status === "cancelled") return "archived";
  // drafting / clarifying / ready / awaiting_approval / awaiting_review / failed
  // 及任何未知新状态 → 等待人工（宁可误报不漏报）
  return "human";
}
