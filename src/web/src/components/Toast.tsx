import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type ToastLevel = "success" | "info" | "warning" | "error";

interface ToastItem {
  id: number;
  level: ToastLevel;
  message: string;
  /** 错误信息展开时显示的详情/堆栈 */
  detail?: string;
  /** 持久 toast（不自动消失）。error 默认持久 */
  persistent?: boolean;
}

interface ToastApi {
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  /** 错误默认持久，必须手动关闭；可传 detail 显示展开区 */
  error: (message: string, detail?: string) => void;
  /** 底层 API */
  show: (item: Omit<ToastItem, "id">) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

/** 没 provider 时的空实现，用于尚未接入的遗留代码；避免组件崩溃 */
export function useToastSafe(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? {
    success: () => {}, info: () => {}, warning: () => {}, error: () => {},
    show: () => 0, dismiss: () => {},
  };
}

const AUTO_DISMISS_MS = 3500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const idRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const show = useCallback((item: Omit<ToastItem, "id">): number => {
    const id = idRef.current++;
    const full: ToastItem = { ...item, id };
    setToasts((prev) => [...prev, full]);
    const persistent = item.persistent ?? item.level === "error";
    if (!persistent) {
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    return () => { for (const t of timers.current.values()) clearTimeout(t); };
  }, []);

  const api: ToastApi = {
    success: (m) => show({ level: "success", message: m }),
    info: (m) => show({ level: "info", message: m }),
    warning: (m) => show({ level: "warning", message: m }),
    error: (m, detail) => show({ level: "error", message: m, detail }),
    show,
    dismiss,
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => <ToastView key={t.id} item={t} onClose={() => dismiss(t.id)} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = item.detail ? `${item.message}\n\n${item.detail}` : item.message;
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  };

  return (
    <div className={`toast-item toast-${item.level}`}>
      <div className="toast-row">
        <span className="toast-msg">{item.message}</span>
        <div className="toast-row-actions">
          {item.detail && (
            <button type="button" className="toast-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "收起" : "详情"}
            </button>
          )}
          {(item.level === "error" || item.detail) && (
            <button type="button" className="toast-btn" onClick={copy}>复制</button>
          )}
          <button type="button" className="toast-btn toast-close" aria-label="关闭" onClick={onClose}>×</button>
        </div>
      </div>
      {expanded && item.detail && (
        <pre className="toast-detail">{item.detail}</pre>
      )}
    </div>
  );
}
