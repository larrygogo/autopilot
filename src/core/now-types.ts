import type { AutopilotEvent } from "../daemon/protocol";

// ──────────────────────────────────────────────
// NowCard 协议
// ──────────────────────────────────────────────

export type NowCardPriority = "P0" | "P1" | "P2" | "P3";
export type NowCardCategory = "error" | "decision" | "running" | "completed";
export type NowCardActionKind = "primary" | "secondary" | "danger";

export type NowCardAction =
  | {
      label: string;
      kind: NowCardActionKind;
      /** 客户端路由跳转 */
      href: string;
      invoke?: never;
    }
  | {
      label: string;
      kind: NowCardActionKind;
      /** 触发后端动作 */
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
  /** 稳定 ID，形如 "<source-name>:<entity-id>"，例 "completed:task-5" */
  id: string;
  priority: NowCardPriority;
  category: NowCardCategory;
  title: string;
  subtitle: string;
  detail?: string;
  related?: NowCardRelated;
  actions: NowCardAction[];
  /** 由前端基于 created_at 实时计算，后端不推秒级更新 */
  waited_seconds?: number;
  dismissable: boolean;
  /** epoch seconds */
  created_at: number;
}

// ──────────────────────────────────────────────
// CardSource 抽象
// ──────────────────────────────────────────────

export type CardDelta =
  | { op: "add"; card: NowCard }
  | { op: "update"; id: string; patch: Partial<NowCard> }
  | { op: "remove"; id: string; reason: "resolved" | "dismissed" }
  | { op: "clear-dismiss"; id: string };

export interface CardSource {
  /** 唯一名，作为卡片 id 前缀，例 "completed"、"task-failed" */
  name: string;
  /** 订阅的 event-bus 事件类型；空数组表示纯 scan-only */
  subscribes: string[];
  /** 启动时全扫，返回当前应该展示的所有卡 */
  scan(): Promise<NowCard[]>;
  /** 事件来时计算增量。若与本 source 无关返回 [] */
  onEvent(event: AutopilotEvent): Promise<CardDelta[]>;
}
