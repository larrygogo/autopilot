import type { NowCard, NowCardCategory } from "./now-types";

/**
 * 需要人工动作的卡片分类：
 * - error：provider 出错、task 失败、clarifier 出错等
 * - decision：clarifier 问问题、方案待评审、需求待审批等
 *
 * 其余 (running / completed) 是观察类，不计入"需要你处理"。
 */
const ACTIVE_CATEGORIES = new Set<NowCardCategory>(["error", "decision"]);

export function isActiveCard(card: NowCard): boolean {
  return ACTIVE_CATEGORIES.has(card.category);
}

export function countActiveCards(cards: NowCard[]): number {
  return cards.reduce((n, c) => n + (isActiveCard(c) ? 1 : 0), 0);
}

export function activeCardIds(cards: NowCard[]): Set<string> {
  const ids = new Set<string>();
  for (const c of cards) if (isActiveCard(c)) ids.add(c.id);
  return ids;
}
