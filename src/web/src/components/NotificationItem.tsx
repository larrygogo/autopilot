import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import type { Notification, NotificationSeverity } from "@/lib/notification-types";
import { resolveNotificationIntent } from "@/lib/notification-intent";
import { requestRpc } from "@/hooks/useApi";

const SEVERITY_TEXT: Record<NotificationSeverity, string> = {
  error: "text-destructive",
  action: "text-warning",
  info: "text-success",
};

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

/** 归属上下文行：项目名 · 仓库:分支 */
function contextLine(n: Notification): string | null {
  const ctx = n.context;
  if (!ctx) return null;
  const repo = ctx.workspace_alias
    ? ctx.branch ? `${ctx.workspace_alias}:${ctx.branch}` : ctx.workspace_alias
    : null;
  const parts = [ctx.project_name, repo].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function NotificationItem({
  notification: n,
  now,
  onRead,
  onDismiss,
}: {
  notification: Notification;
  /** 当前 epoch ms（父组件统一驱动相对时间刷新） */
  now: number;
  onRead: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const toast = useToast();
  const [invoking, setInvoking] = useState<number | null>(null);
  const unread = n.read_at === null;
  // 主标题用需求名；无上下文（系统类）回退 body 或内核 title
  const heading = n.context?.requirement_title || n.body || n.title;
  const sub = n.body && n.body !== heading ? n.body : null;
  const ctxLine = contextLine(n);

  const handleInvoke = async (
    rpc: { method: string; params: Record<string, unknown> },
    label: string,
    idx: number,
  ) => {
    setInvoking(idx);
    try {
      await requestRpc(rpc.method, rpc.params);
      toast.success(`已${label}`);
      onRead(n.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInvoking(null);
    }
  };

  return (
    <article
      className={cn(
        "group rounded-lg border border-border px-4 py-3",
        unread ? "bg-card" : "bg-card/50 opacity-75",
      )}
      data-notification-id={n.id}
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {unread && <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" aria-label="未读" />}
        <span className={cn("whitespace-nowrap font-mono text-[10px] font-medium", SEVERITY_TEXT[n.severity])}>
          {n.title}
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-muted-foreground">
          {formatAgo(now - n.created_at)}
        </span>
        <button
          type="button"
          aria-label="删除通知"
          onClick={() => onDismiss(n.id)}
          className="text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <h3 className="truncate text-sm font-bold text-foreground">{heading}</h3>
      {sub && <p className="mt-0.5 truncate text-sm text-muted-foreground">{sub}</p>}
      {ctxLine && (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{ctxLine}</p>
      )}

      {n.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {n.actions.map((action, idx) => {
            const resolved = resolveNotificationIntent(action.intent);
            const variant =
              action.kind === "primary" ? "default" : action.kind === "danger" ? "destructive" : "outline";
            if (resolved.href) {
              return (
                <Button
                  key={idx}
                  asChild
                  variant={variant}
                  size="sm"
                  className="rounded-md text-[11px]"
                  onClick={() => onRead(n.id)}
                >
                  <Link to={resolved.href}>{resolved.label}</Link>
                </Button>
              );
            }
            return (
              <Button
                key={idx}
                variant={variant}
                size="sm"
                className="rounded-md text-[11px]"
                disabled={invoking === idx}
                onClick={() => void handleInvoke(resolved.rpc!, resolved.label, idx)}
              >
                {invoking === idx ? "..." : resolved.label}
              </Button>
            );
          })}
        </div>
      )}
    </article>
  );
}
