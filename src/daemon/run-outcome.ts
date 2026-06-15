/**
 * run-outcome：run（task）终结向需求做宏观汇报的**唯一单口**（需求中心架构 v2 §1，R1）。
 *
 * 关系铁律：信息流单向——需求驱动 run 创建（向下委托），run 终结汇报 outcome（向上报告）。
 * run 永不直接改需求状态；所有「run 终结 → 需求状态转移」必须经过 reportRunOutcome：
 *   - delivered      → 有交付 PR 进 awaiting_review（验收交 pr-poller），无 PR 直通 done
 *   - fixed          → awaiting_review（fix run 修复完成回验收，v2 R3）
 *   - awaiting_human → awaiting_review（带 await_review phase 的旧 workflow 兼容路径）
 *   - fixing         → fix_revision（旧 workflow 的 running_fix_revision 兼容路径）
 *   - failed / cancelled → 对应终态，落 status_reason / status_reason_source，
 *     并把 task 侧 rejection_reason 沉淀为需求评论（防撞墙-失忆-重撞）
 *
 * 当前调用方：requirement-task-bridge（从 task:transition 事件翻译而来；
 * v2 R3 起 fix run（task.kind=fix）的 done 也由 bridge 翻译为 fixed 经此单口汇报）。
 *
 * 放 daemon 层而非 core：它要读 sub_prs / 写需求状态，是服务编排逻辑。
 */

import { getRequirementById, setRequirementStatus, canTransitionStatus } from "../core/requirements";
import { createComment, nextCommentId } from "../core/requirements/comments";
import { listSubPrs } from "../core/requirements/sub-prs";
import { hasDeliveries } from "../core/requirements/deliveries";
import { getTask } from "../core/db";
import { createLogger } from "../core/logger";

const log = createLogger("run-outcome");

/**
 * Run 终结 outcome（v2 架构 §1：run→需求的唯一汇报口；当前由 bridge 从 task:transition
 * 翻译而来，R3 后 fix-runner 等执行器直接调用）。
 *
 * 终态 outcome 的 `note` = task 侧原始 transition note（评审沉淀的评论标题用，
 * 与 `reason`（已做过 user/task 来源映射的需求侧展示文案）分工不同）。
 */
export type RunOutcome =
  | { kind: "delivered" }                 // 执行完成；交付物有无由本模块查（hasPr）决定验收/直通
  | { kind: "fixed" }                     // fix run（kind=fix）完成：修复已 push 回交付分支 → 回验收（v2 R3）
  | { kind: "awaiting_human" }            // 带 await_review phase 的旧 workflow 挂起（pending_await_review 兼容路径）
  | { kind: "fixing" }                    // 旧 workflow 的 running_fix_revision 兼容路径
  | { kind: "failed"; reason?: string; reasonSource?: "user" | "task"; note?: string }
  | { kind: "cancelled"; reason?: string; reasonSource?: "user" | "task"; note?: string };

/** outcome → 需求目标状态。delivered 的去向取决于有无交付 PR（主 PR 或 sub_prs）。 */
function targetReqStatus(outcome: RunOutcome, req: { id: string; pr_number: number | null }): string {
  switch (outcome.kind) {
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "awaiting_human":
      return "awaiting_review";
    case "fixed":
      // fix run 修完 push 回同一交付分支 → 回验收，pr-poller 继续盯 merge / CI / 新一轮 review
      return "awaiting_review";
    case "fixing":
      return "fix_revision";
    case "delivered": {
      // run 干完了；需求是否「完成」取决于交付物（事实推断，声明 delivers 只管预检/UI 预告）：
      // 1. 有交付 PR（主 PR 或 sub_prs）→ 进验收 awaiting_review，由 pr-poller 在
      //    全部 PR merge 后才转 done（poller 只扫 awaiting_review，这里直通 done 会
      //    让验收/CI/review 回路整体死路 —— req-018 事故，PR 还 OPEN 需求就「完成」了）。
      //    **hasPr 优先**——混合交付不支持，PR 赢（v2 R5 红线）。
      // 2. 无 PR 但有 deliveries（artifacts 交付，v2 R5）→ awaiting_review，
      //    验收信号 = Web/CLI 人工通过/驳回（poller 对此静默 skip）。
      // 3. 都无（纯 adhoc 无交付）→ done。
      const hasPr = (req.pr_number ?? 0) > 0 || listSubPrs(req.id).some((sp) => sp.pr_number > 0);
      if (hasPr) return "awaiting_review";
      return hasDeliveries(req.id) ? "awaiting_review" : "done";
    }
  }
}

/**
 * run 终结的唯一汇报口：翻译 outcome → 需求宏观状态并写入。
 * 幂等/防御：需求不存在、目标状态相同、非法转换均静默跳过（warn 日志），不抛出。
 */
export function reportRunOutcome(reqId: string, runId: string, outcome: RunOutcome): void {
  const req = getRequirementById(reqId);
  if (!req) return;
  const reqStatus = targetReqStatus(outcome, req);
  if (req.status === reqStatus) return;
  if (!canTransitionStatus(req.status, reqStatus)) {
    log.warn("run-outcome: 跳过非法转换 req=%s %s → %s（run=%s outcome=%s）",
      req.id, req.status, reqStatus, runId, outcome.kind);
    return;
  }

  try {
    // 终态汇报时把「为什么」带给需求，让需求页直接可见（reason/reasonSource 由
    // 调用方在翻译层算好——如「API cancel → user 来源」是 task 侧契约知识）。
    const isTerminal = outcome.kind === "cancelled" || outcome.kind === "failed";
    setRequirementStatus(req.id, reqStatus, isTerminal ? {
      reason: outcome.reason,
      reason_source: outcome.reasonSource ?? "task",
    } : undefined);
    log.info("run-outcome: req=%s %s → %s（run=%s outcome=%s）",
      req.id, req.status, reqStatus, runId, outcome.kind);

    // 评审知识沉淀（防撞墙-失忆-重撞）：终态时把 run 侧最后一轮评审驳回原话写成需求
    // 评论（kind=feedback, from_role=agent），scheduler 重跑拼 requirement 文本时会带上，
    // 让新一轮 design v1 即带着上轮发现的架构约束。沉淀失败不阻塞状态同步。
    // ⚠ body 前缀「【执行评审遗留」是 Web 区分「历史遗留 vs Agent 修复」的判别标记
    //   （src/web/src/hooks/useApi.ts classifyFeedback FEEDBACK_RESIDUE_PREFIX）——改前缀须同步。
    if (isTerminal) {
      try {
        const task = getTask(runId);
        const rejection = task?.["rejection_reason"];
        if (typeof rejection === "string" && rejection.trim()) {
          createComment({
            id: nextCommentId(),
            requirement_id: req.id,
            kind: "feedback",
            from_role: "agent",
            body: `【执行评审遗留 · task ${runId}】${outcome.note ?? task?.["status"] ?? reqStatus}\n\n最后一轮评审驳回理由（重跑时方案必须规避）：\n\n${rejection.slice(0, 4000)}`,
          });
          log.info("run-outcome: 已沉淀评审遗留为需求评论 req=%s run=%s", req.id, runId);
        }
      } catch (e: unknown) {
        log.warn("run-outcome: 沉淀评审遗留失败 req=%s: %s", req.id, (e as Error).message);
      }
    }
  } catch (e: unknown) {
    log.error("run-outcome: 同步 requirement 状态失败 req=%s: %s", req.id, (e as Error).message);
  }
}
