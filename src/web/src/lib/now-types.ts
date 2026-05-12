// 与 src/core/now-types.ts 保持一致（手动同步——前后端独立 ts project，不共享路径）
export type NowCardPriority = "P0" | "P1" | "P2" | "P3";
export type NowCardCategory = "error" | "decision" | "running" | "completed";
export type NowCardActionKind = "primary" | "secondary" | "danger";

export type NowCardAction =
  | {
      label: string;
      kind: NowCardActionKind;
      href: string;
      invoke?: never;
    }
  | {
      label: string;
      kind: NowCardActionKind;
      invoke: {
        method: "POST" | "PATCH";
        path: string;
        body?: unknown;
      };
      href?: never;
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
