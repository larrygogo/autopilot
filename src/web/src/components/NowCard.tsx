import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import type { NowCard as NowCardType, NowCardAction, NowCardPriority } from "@/lib/now-types";

interface Props {
  card: NowCardType;
  /** 当前 epoch ms，用于计算等待时长（由父组件每秒更新） */
  now: number;
}

const PRIORITY_BAR: Record<NowCardPriority, string> = {
  P0: "border-l-destructive",
  P1: "border-l-warning",
  P2: "border-l-success",
  P3: "border-l-muted-foreground/60",
};

const PRIORITY_LABEL: Record<NowCardPriority, string> = {
  P0: "异常",
  P1: "决策",
  P2: "进行",
  P3: "完成",
};

function formatWaited(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}min` : ""}`;
}

export function NowCard({ card, now }: Props) {
  const toast = useToast();
  const [invoking, setInvoking] = useState<number | null>(null);

  const waitedSec = Math.max(0, Math.floor(now / 1000) - card.created_at);

  const handleInvoke = async (
    action: Extract<NowCardAction, { invoke: object }>,
    idx: number,
  ) => {
    setInvoking(idx);
    try {
      const res = await fetch(action.invoke.path, {
        method: action.invoke.method,
        headers: { "Content-Type": "application/json" },
        body: action.invoke.body ? JSON.stringify(action.invoke.body) : undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      toast.success(`已${action.label}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInvoking(null);
    }
  };

  return (
    <article
      className={cn(
        "border border-l-4 rounded-lg",
        "border-border bg-card",
        PRIORITY_BAR[card.priority],
        "px-4 py-3 flex gap-4",
      )}
      data-card-id={card.id}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-mono text-[10px] text-muted-foreground">
            {card.priority} · {PRIORITY_LABEL[card.priority]}
          </span>
          {card.related && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {card.related.type} · {card.related.id}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            等候 {formatWaited(waitedSec)}
          </span>
        </div>
        <h3 className="text-sm font-bold tracking-wide text-foreground truncate">
          {card.title}
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5 truncate">{card.subtitle}</p>
        {card.detail && (
          <p className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">{card.detail}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 shrink-0 items-stretch">
        {card.actions.map((action, idx) => {
          const variant =
            action.kind === "primary"
              ? "default"
              : action.kind === "danger"
                ? "destructive"
                : "outline";
          if (action.href) {
            return (
              <Button
                key={idx}
                asChild
                variant={variant}
                size="sm"
                className="rounded-md text-[11px] min-w-[80px]"
              >
                <Link to={action.href}>{action.label}</Link>
              </Button>
            );
          }
          return (
            <Button
              key={idx}
              variant={variant}
              size="sm"
              className="rounded-md text-[11px] min-w-[80px]"
              disabled={invoking === idx}
              onClick={() =>
                void handleInvoke(
                  action as Extract<NowCardAction, { invoke: object }>,
                  idx,
                )
              }
            >
              {invoking === idx ? "..." : action.label}
            </Button>
          );
        })}
      </div>
    </article>
  );
}
