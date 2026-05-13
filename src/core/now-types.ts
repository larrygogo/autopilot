// ──────────────────────────────────────────────
// NowCard 协议（纯数据类型，不依赖事件总线）
//
// CardSource / CardDelta 接口在 `./card-sources/types.ts`，
// 事件类型 AutopilotEvent 在 `./events.ts`。这样保证：
//   now-types ← card-sources/types ← card-sources/*
//   now-types ← events ← card-sources/types
// 不形成循环。
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

// CardSource / CardDelta 历史 re-export（保持外部 import 路径不破）
export type { CardSource, CardDelta } from "./card-sources/types";
