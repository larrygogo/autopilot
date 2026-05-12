import { getDb } from "./db";

/**
 * /now 卡片 dismiss 持久化。card_id 由各 CardSource 生成，形如 "completed:task-5"。
 * dismiss 只影响是否在 /now 显示，对应实体（Task/Requirement）状态不变。
 * 当对应实体状态发生显著变化时（如 task 从 failed 转出），aggregator 应清掉对应 dismiss 记录。
 */

export function dismissCard(cardId: string): void {
  getDb().run(
    "INSERT OR REPLACE INTO now_dismissed_cards (card_id, dismissed_at) VALUES (?, ?)",
    [cardId, Date.now()],
  );
}

export function clearDismissedCard(cardId: string): void {
  getDb().run("DELETE FROM now_dismissed_cards WHERE card_id = ?", [cardId]);
}

export function isCardDismissed(cardId: string): boolean {
  const row = getDb()
    .query<{ card_id: string }, [string]>(
      "SELECT card_id FROM now_dismissed_cards WHERE card_id = ?",
    )
    .get(cardId);
  return row !== null;
}

export function listDismissedCardIds(): string[] {
  const rows = getDb()
    .query<{ card_id: string }, []>("SELECT card_id FROM now_dismissed_cards")
    .all();
  return rows.map((r) => r.card_id);
}
