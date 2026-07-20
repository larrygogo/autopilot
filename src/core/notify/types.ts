// ──────────────────────────────────────────────
// 通知协议（纯数据类型，不依赖事件总线）
//
// 与旧 NowCard（派生快照）的本质差异：通知是 append-only 事件流，
// 领域事件发生时写入 notifications 表，状态后续变化不抹历史；
// 读/未读（read_at）与删除（dismissed_at）双状态独立。
// ──────────────────────────────────────────────

export type NotificationType =
  | "task_done"
  | "task_failed"
  | "task_cancelled"
  | "task_await_review"
  | "requirement_awaiting_approval"
  | "requirement_awaiting_review"
  | "agent_question"
  | "clarifier_error"
  | "schedule_error"
  | "ci_fix_limit"
  | "watcher_recovery"
  | "supervisor_crash_loop";

export type NotificationSeverity = "error" | "action" | "info";

/** type → severity 固定映射（recorder 写入时落库，客户端只读） */
export const SEVERITY_OF: Record<NotificationType, NotificationSeverity> = {
  task_failed: "error",
  clarifier_error: "error",
  schedule_error: "error",
  ci_fix_limit: "error",
  supervisor_crash_loop: "error",
  task_await_review: "action",
  requirement_awaiting_approval: "action",
  requirement_awaiting_review: "action",
  agent_question: "action",
  task_done: "info",
  task_cancelled: "info",
  watcher_recovery: "info",
};

// 语义化动作 intent：内核只出「要做什么」+ 关联实体引用，不出 href/HTTP path/UI 文案。
// 客户端（Web/CLI/TUI）各自把 intent 翻译成跳转/RPC/只读标签。
// （相比旧 NowActionIntent 删掉了 dismiss / configure_providers / create_project /
//   add_workspace / new_requirement —— 持续状态与空态引导已不进通知流。）
export type NotificationActionIntent =
  | { kind: "view_task"; taskId: string }
  | { kind: "view_requirement"; requirementId: string }
  | { kind: "reject_review"; taskId: string }
  | { kind: "retry_clarify"; requirementId: string };

export interface NotificationAction {
  intent: NotificationActionIntent;
  /** 视觉重要性（中性语义，非 UI 实现） */
  kind: "primary" | "secondary" | "danger";
}

export type NotificationRelatedType = "task" | "requirement" | "system";

/** 归属上下文（需求/项目/仓库），recorder 写入时 JOIN 快照；客户端只读展示 */
export interface NotificationContext {
  requirement_id?: string;
  requirement_title?: string;
  project_name?: string;
  workspace_alias?: string;
  /** workspace 默认分支 */
  branch?: string;
}

export interface Notification {
  id: number;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  related_type: NotificationRelatedType | null;
  related_id: string | null;
  context: NotificationContext | null;
  actions: NotificationAction[];
  /** epoch ms；NULL = 未读 */
  read_at: number | null;
  /** epoch ms；NULL = 未删；独立于 read */
  dismissed_at: number | null;
  /** epoch ms */
  created_at: number;
}
