import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import type { NowCard as NowCardType, NowCardPriority } from "@/lib/now-types";
import { resolveIntent } from "@/lib/now-intent";
import { requestRpc } from "@/hooks/useApi";

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

/** 归属上下文行：需求标题 · 项目名 · 仓库:分支（标题/副标题已含需求名时不重复） */
function contextLine(card: NowCardType): string | null {
  const ctx = card.context;
  if (!ctx) return null;
  const showTitle =
    ctx.requirement_title &&
    !card.title.includes(ctx.requirement_title) &&
    !card.subtitle.includes(ctx.requirement_title);
  const repo = ctx.workspace_alias
    ? ctx.branch ? `${ctx.workspace_alias}:${ctx.branch}` : ctx.workspace_alias
    : null;
  const parts = [showTitle ? ctx.requirement_title : null, ctx.project_name, repo].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

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
  const ctxLine = contextLine(card);

  const handleInvoke = async (
    rpc: { method: string; params: Record<string, unknown> },
    label: string,
    idx: number,
  ) => {
    setInvoking(idx);
    try {
      // 走 WS RPC（dismiss → now.dismissCard / retry → requirements.retryClarify）。
      // 旧实现 fetch(/api/now/cards/.../dismiss) 会撞 410（该 REST 已退役）—— 这步修复。
      await requestRpc(rpc.method, rpc.params);
      toast.success(`已${label}`);
      // dismiss 成功后端 emit now:card_removed → useNowCards 自动移除卡片，无需手动改本地 state。
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
        "px-4 py-3 flex flex-col gap-3 sm:flex-row sm:gap-4",
      )}
      data-card-id={card.id}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
          <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
            {card.priority} · {PRIORITY_LABEL[card.priority]}
          </span>
          {card.related && (
            <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
              {card.related.type} · {card.related.id}
            </span>
          )}
          <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-muted-foreground">
            等候 {formatWaited(waitedSec)}
          </span>
        </div>
        <h3 className="text-sm font-bold text-foreground truncate">
          {card.title}
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5 truncate">{card.subtitle}</p>
        {ctxLine && (
          <p className="text-[11px] text-muted-foreground/80 mt-0.5 truncate">
            {ctxLine}
          </p>
        )}
        {card.detail && (
          <p className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">{card.detail}</p>
        )}
      </div>

      <div className="flex flex-row sm:flex-col gap-1.5 shrink-0 items-stretch">
        {card.actions.map((action, idx) => {
          const resolved = resolveIntent(action.intent);
          const variant =
            action.kind === "primary"
              ? "default"
              : action.kind === "danger"
                ? "destructive"
                : "outline";
          if (resolved.href) {
            return (
              <Button
                key={idx}
                asChild
                variant={variant}
                size="sm"
                className="rounded-md text-[11px] min-w-[80px]"
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
              className="rounded-md text-[11px] min-w-[80px]"
              disabled={invoking === idx}
              onClick={() => void handleInvoke(resolved.rpc!, resolved.label, idx)}
            >
              {invoking === idx ? "..." : resolved.label}
            </Button>
          );
        })}
      </div>
    </article>
  );
}
