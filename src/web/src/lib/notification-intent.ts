import type { NotificationActionIntent, NotificationContext } from "./notification-types";

// 通知 intent 的 Web 翻译层 —— 内核只出语义 intent，这里翻成 Web 落点 + 中文文案。
// 这是「内核出语义、客户端翻译」红线的对侧资产，内核零 UI 知识。
export interface ResolvedNotificationAction {
  label: string;
  /** 跳转类：渲染 <Link to={href}> */
  href?: string;
  /** 副作用类：点击调 requestRpc(method, params) */
  rpc?: { method: string; params: Record<string, unknown> };
}

/**
 * @param context 通知归属上下文（含 requirement_id 快照）。用于把「任务类」通知统一落到
 *   需求详情页——产品方向：Web 用户只关心需求，不该被通知甩进独立任务页。缺 context（极旧
 *   通知 / 游离任务）才回退到 /tasks/:id。
 */
export function resolveNotificationIntent(
  intent: NotificationActionIntent,
  context?: NotificationContext | null,
): ResolvedNotificationAction {
  const reqId = context?.requirement_id;
  switch (intent.kind) {
    case "view_task":
      return { label: "查看", href: reqId ? `/requirements/${reqId}` : `/tasks/${intent.taskId}` };
    case "view_requirement":
      return { label: "查看", href: `/requirements/${intent.requirementId}` };
    case "reject_review":
      // 任务通知统一落需求页（驳回在需求页「审查与修复」卡完成）；缺 context 回退旧落点。
      return { label: "驳回", href: reqId ? `/requirements/${reqId}` : `/tasks/${intent.taskId}?action=reject` };
    case "retry_clarify":
      return {
        label: "重试",
        rpc: { method: "requirements.retryClarify", params: { id: intent.requirementId } },
      };
    default: {
      // 新增 intent kind 忘了在此登记 → 编译失败（exhaustive 兜底）
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
