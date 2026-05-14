import { useEffect, useRef } from "react";
import type { NowCard } from "../lib/now-types";
import { activeCardIds, isActiveCard } from "../lib/active-cards";

/**
 * 在 tab 不可见时，对新增的 active 卡片弹桌面通知。
 *
 * 触发条件：
 *  - `Notification.permission === "granted"`（未授权 silent skip）
 *  - `document.hidden === true`（用户没看着页面）
 *  - cards 集合里出现**新的** active id（不算之前已存在的）
 *
 * 文案：单条用卡片 title；多条合并为 "autopilot: N 件新事需要处理"。
 */
export function useDesktopNotify(cards: NowCard[]): void {
  const prevIdsRef = useRef<Set<string>>(new Set());
  // 首次 mount 时不弹（避免页面打开瞬间把全部已存在 active 都弹一遍）
  const initializedRef = useRef(false);

  useEffect(() => {
    const currentIds = activeCardIds(cards);

    if (!initializedRef.current) {
      prevIdsRef.current = currentIds;
      initializedRef.current = true;
      return;
    }

    // 找新增 active 卡片
    const newCards: NowCard[] = [];
    for (const c of cards) {
      if (isActiveCard(c) && !prevIdsRef.current.has(c.id)) {
        newCards.push(c);
      }
    }
    prevIdsRef.current = currentIds;

    if (newCards.length === 0) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && !document.hidden) return;

    try {
      const title = newCards.length === 1
        ? `autopilot · ${newCards[0]!.title}`
        : `autopilot · ${newCards.length} 件新事需要处理`;
      const body = newCards.length === 1
        ? newCards[0]!.subtitle
        : newCards.slice(0, 3).map((c) => `· ${c.title}`).join("\n");
      const n = new Notification(title, { body, tag: "autopilot-now-active" });
      // 点击通知聚焦窗口
      n.onclick = () => {
        try {
          window.focus();
          n.close();
        } catch {}
      };
    } catch {
      // 静默忽略：通知失败不应影响主流程
    }
  }, [cards]);
}
