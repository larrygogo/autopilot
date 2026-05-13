import { useState, useEffect, useCallback, useRef } from "react";
import type { AutopilotClient, AutopilotEvent } from "../../client/index";
import type { NowCard, NowCardPriority } from "../../core/now-types";

const PRIORITY_ORDER: Record<NowCardPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function sortCards(cards: NowCard[]): NowCard[] {
  return [...cards].sort((a, b) => {
    const dp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (dp !== 0) return dp;
    return a.created_at - b.created_at;
  });
}

export function useNowCards(client: AutopilotClient) {
  const [cards, setCards] = useState<NowCard[]>([]);
  const [loading, setLoading] = useState(true);
  const cardsRef = useRef<NowCard[]>([]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await client.listNowCards();
      setCards(sortCards(fresh));
    } catch {
      // daemon 断线时忽略
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = client.subscribe("now:*", (event: AutopilotEvent) => {
      if (event.type === "now:card_added") {
        const card = event.payload.card;
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
  }, [client]);

  return { cards, loading, refresh };
}
