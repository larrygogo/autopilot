/**
 * 需求 feedback 子类分类（纯逻辑）。
 *
 * 区分三类长得一样（kind=feedback）但语义不同的评论，避免「上一次失败 run 沉淀的历史评审
 * 遗留」被误标成「Agent 修复」、混进当前 PR 的审查线程读成对当前 PR 的结论：
 *   - residue：历史失败 run 的评审遗留（from_role=agent + body 带遗留前缀），非本 PR 评审
 *   - fix    ：Agent 修复总结（from_role=agent，其余）
 *   - review ：用户 / GitHub 的评审意见（from_role 非 agent）
 *
 * ⚠ residue 前缀须与后端 createComment body 约定同步：
 *   src/daemon/run-outcome.ts 沉淀评审遗留时以「【执行评审遗留」开头。改前缀须同步两端。
 */

export const FEEDBACK_RESIDUE_PREFIX = "【执行评审遗留";

export type FeedbackSubtype = "residue" | "fix" | "review";

export function classifyFeedback(fromRole: string, body: string): FeedbackSubtype {
  if (fromRole === "agent") {
    return body.startsWith(FEEDBACK_RESIDUE_PREFIX) ? "residue" : "fix";
  }
  return "review";
}
