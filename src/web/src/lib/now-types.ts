// 与 src/core/now-types.ts 保持一致（手动同步——前后端独立 ts project，不共享路径）
export type NowCardPriority = "P0" | "P1" | "P2" | "P3";
export type NowCardCategory = "error" | "decision" | "running" | "completed";
export type NowCardActionKind = "primary" | "secondary" | "danger";

// 与 src/core/now-types.ts NowActionIntent 保持一致（手动同步）
export type NowActionIntent =
  | { kind: "view_task"; taskId: string }
  | { kind: "view_requirement"; requirementId: string }
  | { kind: "configure_providers"; provider?: string }
  | { kind: "create_project" }
  | { kind: "add_workspace" }
  | { kind: "new_requirement" }
  | { kind: "reject_review"; taskId: string }
  | { kind: "retry_clarify"; requirementId: string }
  | { kind: "dismiss"; cardId: string };

export interface NowCardAction {
  /** 语义动作 —— 内核只出这个；落点/文案由 now-intent.ts 翻译 */
  intent: NowActionIntent;
  /** 视觉重要性（中性语义） */
  kind: NowCardActionKind;
}

export interface NowCardRelated {
  type: "task" | "requirement" | "provider" | "system";
  id: string;
}

/** 卡片归属上下文（需求/项目/仓库），内核构卡时填充 */
export interface NowCardContext {
  requirement_id?: string;
  requirement_title?: string;
  project_name?: string;
  workspace_alias?: string;
  /** workspace 默认分支 */
  branch?: string;
}

export interface NowCard {
  id: string;
  priority: NowCardPriority;
  category: NowCardCategory;
  title: string;
  subtitle: string;
  detail?: string;
  related?: NowCardRelated;
  context?: NowCardContext;
  actions: NowCardAction[];
  waited_seconds?: number;
  dismissable: boolean;
  created_at: number; // epoch seconds
}

// WS event payloads
export interface NowCardAddedEvent {
  type: "now:card_added";
  payload: { card: NowCard };
}

export interface NowCardUpdatedEvent {
  type: "now:card_updated";
  payload: { id: string; patch: Partial<NowCard> };
}

export interface NowCardRemovedEvent {
  type: "now:card_removed";
  payload: { id: string; reason: "resolved" | "dismissed" };
}

export interface NowSnapshotEvent {
  type: "now:snapshot";
  payload: { cards: NowCard[] };
}

export type NowEvent =
  | NowCardAddedEvent
  | NowCardUpdatedEvent
  | NowCardRemovedEvent
  | NowSnapshotEvent;
