import { useEffect, useRef } from "react";
import type { Notification as AppNotification } from "../lib/notification-types";

/**
 * 在 tab 不可见时，对新到达的 error / action 级通知弹桌面通知。
 *
 * 触发条件：
 *  - `Notification.permission === "granted"`（未授权 silent skip）
 *  - `document.hidden === true`（用户没看着页面）
 *  - 通知列表里出现**新的** error/action id（不算之前已存在的）
 *
 * 文案：单条用通知 title + body；多条合并为 "autopilot: N 件新事需要处理"。
 */
export function useDesktopNotify(items: AppNotification[]): void {
  const prevIdsRef = useRef<Set<number>>(new Set());
  // 首次 mount 时不弹（避免页面打开瞬间把全部已存在通知都弹一遍）
  const initializedRef = useRef(false);

  useEffect(() => {
    const important = items.filter((n) => n.severity === "error" || n.severity === "action");
    const currentIds = new Set(important.map((n) => n.id));

    if (!initializedRef.current) {
      prevIdsRef.current = currentIds;
      initializedRef.current = true;
      return;
    }

    const fresh = important.filter((n) => !prevIdsRef.current.has(n.id));
    prevIdsRef.current = currentIds;

    if (fresh.length === 0) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && !document.hidden) return;

    try {
      const title = fresh.length === 1
        ? `autopilot · ${fresh[0]!.title}`
        : `autopilot · ${fresh.length} 件新事需要处理`;
      const body = fresh.length === 1
        ? (fresh[0]!.context?.requirement_title || fresh[0]!.body)
        : fresh.slice(0, 3).map((n) => `· ${n.title}`).join("\n");
      const n = new Notification(title, { body, tag: "autopilot-notifications" });
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
  }, [items]);
}
