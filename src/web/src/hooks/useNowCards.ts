import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./useApi";
import { useWebSocket } from "./useWebSocket";
import type {
  NowCard,
  NowCardPriority,
  NowEvent,
} from "../lib/now-types";

const PRIORITY_ORDER: Record<NowCardPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function sortCards(cards: NowCard[]): NowCard[] {
  return [...cards].sort((a, b) => {
    const dp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (dp !== 0) return dp;
    return a.created_at - b.created_at;
  });
}

export interface UseNowCardsResult {
  cards: NowCard[];
  loading: boolean;
  error: string | null;
  /** 客户端 dismiss：先调后端，本地先 optimistic remove */
  dismiss: (cardId: string) => Promise<void>;
  /** 强制重拉（用于错误恢复或手动刷新） */
  refresh: () => Promise<void>;
}

export function useNowCards(): UseNowCardsResult {
  const [cards, setCards] = useState<NowCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { state: wsState, subscribe } = useWebSocket();
  const cardsRef = useRef<NowCard[]>([]);

  // 保持 ref 与 state 同步，让事件 handler 拿到最新快照
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await api.listNowCards();
      setCards(sortCards(fresh));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载 + WS 重连 时拉全量
  useEffect(() => {
    if (wsState === "connected") {
      void refresh();
    }
  }, [wsState, refresh]);

  // 订阅 WS 增量
  useEffect(() => {
    const unsub = subscribe("now:*", (event: NowEvent) => {
      if (event.type === "now:card_added") {
        const card = event.payload.card;
        // upsert by id
        const next = [...cardsRef.current.filter((c) => c.id !== card.id), card];
        setCards(sortCards(next));
      } else if (event.type === "now:card_updated") {
        const { id, patch } = event.payload;
        const next = cardsRef.current.map((c) =>
          c.id === id ? ({ ...c, ...patch } as NowCard) : c,
        );
        setCards(sortCards(next));
      } else if (event.type === "now:card_removed") {
        const { id } = event.payload;
        setCards(cardsRef.current.filter((c) => c.id !== id));
      } else if (event.type === "now:snapshot") {
        setCards(sortCards(event.payload.cards));
      }
    });
    return unsub;
  }, [subscribe]);

  const dismiss = useCallback(async (cardId: string) => {
    // optimistic: 先本地移除
    const prev = cardsRef.current;
    setCards(prev.filter((c) => c.id !== cardId));
    try {
      await api.dismissNowCard(cardId);
    } catch (e: unknown) {
      // rollback
      setCards(prev);
      throw e;
    }
  }, []);

  return { cards, loading, error, dismiss, refresh };
}
