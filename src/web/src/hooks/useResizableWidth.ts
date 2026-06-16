import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

// ──────────────────────────────────────────────
// 左缘拖拽调宽（受控 width + localStorage 持久化）。
// 抽自 App.tsx 通知面板的同形态范式：pointerdown 记起点 → window 上挂
// pointermove/pointerup → clamp → 拖拽期间锁 body cursor/userSelect。
// 右侧抽屉「往左拉变宽」，故位移取 startX - clientX。
// max 缺省 = min(900, 0.9 * 视口宽)，避免超出视口。
// ──────────────────────────────────────────────

interface Options {
  storageKey: string;
  defaultWidth: number;
  min: number;
  /** 缺省按视口动态算（min(900, 0.9*innerWidth)） */
  max?: number;
}

export function useResizableWidth({ storageKey, defaultWidth, min, max }: Options) {
  const computeMax = useCallback(
    () => max ?? Math.min(900, Math.round((typeof window !== "undefined" ? window.innerWidth : 1280) * 0.9)),
    [max],
  );
  const clamp = useCallback(
    (w: number) => Math.max(min, Math.min(computeMax(), Math.round(w))),
    [min, computeMax],
  );

  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = parseInt(saved, 10);
        if (Number.isFinite(n)) return clamp(n);
      }
    } catch {
      /* localStorage 不可用时退默认 */
    }
    return clamp(defaultWidth);
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* 持久化失败忽略 */
    }
  }, [storageKey, width]);

  // 视口缩小时重新 clamp 已保存宽度（max 按 innerWidth 动态算），避免抽屉超出新视口。
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = width;
      const handle = e.currentTarget;
      // 捕获指针：拖出窗口/越界也能持续收到事件，避免丢 pointerup 残留 cursor 锁。
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* 不支持则忽略 */
      }
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => setWidth(clamp(startW + (startX - ev.clientX)));
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          /* 已释放则忽略 */
        }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
      };
      // pointercancel / window blur 作兜底：指针被系统接管或窗口失焦也能还原 body 样式。
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
    },
    [width, clamp],
  );

  return { width, startResize };
}
