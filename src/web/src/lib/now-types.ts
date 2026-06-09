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

export type NowCardAction =
  | {
      label: string;
      kind: NowCardActionKind;
      /** @deprecated 阶段 4 删；改用 intent 翻译 */
      href: string;
      invoke?: never;
      intent: NowActionIntent;
    }
  | {
      label: string;
      kind: NowCardActionKind;
      /** @deprecated 阶段 4 删；改用 intent 翻译 */
      invoke: {
        method: "POST" | "PATCH";
        path: string;
        body?: unknown;
      };
      href?: never;
      intent: NowActionIntent;
    };

export interface NowCardRelated {
  type: "task" | "requirement" | "provider" | "system";
  id: string;
}

export interface NowCard {
  id: string;
  priority: NowCardPriority;
  category: NowCardCategory;
  title: string;
  subtitle: string;
  detail?: string;
  related?: NowCardRelated;
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
