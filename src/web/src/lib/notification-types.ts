// 与 src/core/notification-types.ts 保持一致（手动同步——前后端独立 ts project，不共享路径）

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
  | "watcher_recovery";

export type NotificationSeverity = "error" | "action" | "info";

export type NotificationActionIntent =
  | { kind: "view_task"; taskId: string }
  | { kind: "view_requirement"; requirementId: string }
  | { kind: "reject_review"; taskId: string }
  | { kind: "retry_clarify"; requirementId: string };

export interface NotificationAction {
  intent: NotificationActionIntent;
  kind: "primary" | "secondary" | "danger";
}

export interface NotificationContext {
  requirement_id?: string;
  requirement_title?: string;
  project_name?: string;
  workspace_alias?: string;
  branch?: string;
}

export interface Notification {
  id: number;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  related_type: "task" | "requirement" | "system" | null;
  related_id: string | null;
  context: NotificationContext | null;
  actions: NotificationAction[];
  read_at: number | null;
  dismissed_at: number | null;
  created_at: number; // epoch ms
}

// WS event payloads（频道 notification:*）
export type NotificationEvent =
  | { type: "notification:created"; payload: { notification: Notification } }
  | { type: "notification:read"; payload: { ids: number[] } }
  | { type: "notification:all_read"; payload: Record<string, never> }
  | { type: "notification:dismissed"; payload: { id: number } };
