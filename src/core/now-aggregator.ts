import type { CardSource, CardDelta, NowCard, NowCardPriority } from "./now-types";
import { createAwaitingApprovalSource } from "./card-sources/awaiting-approval";
import { createOpenQuestionSource } from "./card-sources/open-question";
import { createAwaitReviewSource } from "./card-sources/await-review";
import { createRunningSource } from "./card-sources/running";
import { createStuckSource } from "./card-sources/stuck";
import { createCompletedSource } from "./card-sources/completed";
import { createTaskFailedSource } from "./card-sources/task-failed";
import { createEmptyStateSource } from "./card-sources/empty-state";
import { createProviderErrorSource } from "./card-sources/provider-error";
import type { AutopilotEvent } from "../daemon/protocol";
import { onEvent as busOn, offEvent as busOff, emit as busEmit } from "../daemon/event-bus";
import { isCardDismissed, listDismissedCardIds } from "./now-dismiss";

const PRIORITY_ORDER: Record<NowCardPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface AggregatorOptions {
  /** 注入 emit 用于测试；默认走 event-bus.emit */
  emit?: (event: AutopilotEvent) => void;
}

export interface Aggregator {
  /** 调用所有 source.scan() 建立内存快照，然后挂事件订阅 */
  start(): Promise<void>;
  /** 按优先级 + created_at 排序后的快照副本 */
  getCards(): NowCard[];
  /** 取消所有事件订阅，清空快照 */
  dispose(): void;
  /**
   * 把指定卡标记为已 dismiss：写入内存集合并从快照中移除，emit now:card_removed。
   * Task 16 dismiss HTTP 端点调用，保持内存快照与 DB 一致。
   */
  markDismissed(cardId: string): void;
}

export function createAggregator(
  sources: CardSource[],
  opts: AggregatorOptions = {},
): Aggregator {
  const snapshot = new Map<string, NowCard>();
  const dismissedIds = new Set<string>();
  const emit = opts.emit ?? busEmit;
  const handlers: Array<{ type: string; fn: (e: AutopilotEvent) => void }> = [];

  function applyDelta(delta: CardDelta): void {
    if (delta.op === "add") {
      if (dismissedIds.has(delta.card.id)) return;
      snapshot.set(delta.card.id, delta.card);
      emit({ type: "now:card_added", payload: { card: delta.card } });
    } else if (delta.op === "update") {
      // dismissed 卡不会在 snapshot 中，故无需重复 dismissedIds 检查
      const cur = snapshot.get(delta.id);
      if (!cur) return;
      const next = { ...cur, ...delta.patch };
      snapshot.set(delta.id, next);
      emit({ type: "now:card_updated", payload: { id: delta.id, patch: delta.patch } });
    } else if (delta.op === "remove") {
      if (!snapshot.delete(delta.id)) return;
      emit({ type: "now:card_removed", payload: { id: delta.id, reason: delta.reason } });
    }
  }

  async function dispatchEvent(event: AutopilotEvent): Promise<void> {
    for (const src of sources) {
      if (!src.subscribes.includes(event.type)) continue;
      try {
        const deltas = await src.onEvent(event);
        for (const d of deltas) applyDelta(d);
      } catch (e: unknown) {
        console.error(`[now-aggregator] source ${src.name} onEvent 失败:`, e);
      }
    }
  }

  return {
    async start() {
      if (handlers.length > 0) return; // already started

      for (const id of listDismissedCardIds()) dismissedIds.add(id);

      for (const src of sources) {
        try {
          const cards = await src.scan();
          for (const c of cards) {
            if (dismissedIds.has(c.id)) continue;
            snapshot.set(c.id, c);
          }
        } catch (e: unknown) {
          console.error(`[now-aggregator] source ${src.name} scan 失败:`, e);
        }
      }
      const types = new Set(sources.flatMap((s) => s.subscribes));
      for (const type of types) {
        const fn = (event: AutopilotEvent) => {
          dispatchEvent(event).catch((e) =>
            console.error("[now-aggregator] dispatchEvent 异常:", e),
          );
        };
        busOn(type, fn);
        handlers.push({ type, fn });
      }
    },
    getCards() {
      return [...snapshot.values()].sort((a, b) => {
        const dp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (dp !== 0) return dp;
        return a.created_at - b.created_at;
      });
    },
    dispose() {
      for (const { type, fn } of handlers) busOff(type, fn);
      handlers.length = 0;
      snapshot.clear();
      dismissedIds.clear();
    },
    markDismissed(cardId: string) {
      dismissedIds.add(cardId);
      applyDelta({ op: "remove", id: cardId, reason: "dismissed" });
    },
  };
}

/** 装配所有内置 CardSource，返回 ready-to-start 的 aggregator 实例。 */
export function createDefaultAggregator(opts: AggregatorOptions = {}): Aggregator {
  return createAggregator(
    [
      createTaskFailedSource(),       // P0
      createProviderErrorSource(),    // P0 stub
      createAwaitingApprovalSource(), // P1
      createOpenQuestionSource(),     // P1
      createAwaitReviewSource(),      // P1
      createStuckSource(),            // P1
      createRunningSource(),          // P2
      createCompletedSource(),        // P3
      createEmptyStateSource(),       // empty
    ],
    opts,
  );
}
