import type { NotificationActionIntent } from "../core/notification-types";

// 通知 intent → 终端只读标签（CLI/TUI observer 共享）。
// observer-only 定位：不出落点/不可操作，副作用类标注「去 Web」提示用户去决策台处理。
export function notificationIntentToLabel(intent: NotificationActionIntent): string {
  switch (intent.kind) {
    case "view_task":
      return `task ${intent.taskId}`;
    case "view_requirement":
      return `req ${intent.requirementId}`;
    case "reject_review":
      return "待驳回(去 Web)";
    case "retry_clarify":
      return "待重试(去 Web)";
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
