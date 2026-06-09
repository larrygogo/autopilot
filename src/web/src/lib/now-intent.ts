import type { NowActionIntent } from "./now-types";

// /now 卡片 intent 的 Web 翻译层 —— 内核只出语义 intent，这里翻成 Web 落点 + 中文文案。
// 这是「内核出语义、客户端翻译」红线的对侧资产，内核零 UI 知识。
export interface ResolvedAction {
  label: string;
  /** 跳转类：渲染 <Link to={href}> */
  href?: string;
  /** 副作用类：点击调 requestRpc(method, params) */
  rpc?: { method: string; params: Record<string, unknown> };
}

export function resolveIntent(intent: NowActionIntent): ResolvedAction {
  switch (intent.kind) {
    case "view_task":
      return { label: "查看", href: `/tasks/${intent.taskId}` };
    case "view_requirement":
      return { label: "查看", href: `/requirements/${intent.requirementId}` };
    case "configure_providers":
      return { label: "去配置", href: "/settings?tab=providers" };
    case "create_project":
      return { label: "新建项目", href: "/library?tab=projects" };
    case "add_workspace":
      return { label: "去添加", href: "/library" };
    case "new_requirement":
      return { label: "提需求", href: "/start" };
    case "reject_review":
      // 暂保留带参跳转（落地页处理 reject），与旧 ?action=reject 行为一致；
      // 改走 tasks.decide RPC 的参数映射另议（设计稿 §6）。
      return { label: "驳回", href: `/tasks/${intent.taskId}?action=reject` };
    case "retry_clarify":
      return { label: "重试", rpc: { method: "requirements.retryClarify", params: { id: intent.requirementId } } };
    case "dismiss":
      return { label: "关闭", rpc: { method: "now.dismissCard", params: { id: intent.cardId } } };
    default: {
      // 新增 intent kind 忘了在此登记 → 编译失败（exhaustive 兜底）
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
