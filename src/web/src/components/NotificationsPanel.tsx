import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { X, Loader2, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NotificationItem } from "@/components/NotificationItem";
import { NowEmptyGuide } from "@/components/NowEmptyGuide";
import { ProviderHealthBanner } from "@/components/ProviderHealthBanner";
import type { UseNotificationsResult } from "@/hooks/useNotifications";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";

// 分类 = 内核 severity 的业务标签（叠加显示：chip hover 露出内核名）。
// error=异常（失败/触顶类）、action=待处理（等审批/评审/提问）、info=动态（完成/取消/恢复）
const FILTERS = [
  { key: "all", label: "全部" },
  { key: "action", label: "待处理" },
  { key: "error", label: "异常" },
  { key: "info", label: "动态" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/**
 * 「通知」面板 —— 事件型通知流（daemon notifications 表为权威源）。
 *
 * 数据由 AppInner 的 useNotifications 单例传入（顶栏 badge 与面板共用一份订阅）。
 * 持续状态走顶部 banner（setup / provider 健康），不混入通知流。
 */
export function NotificationsPanel({
  notifications,
  onClose,
}: {
  notifications: UseNotificationsResult;
  onClose: () => void;
}) {
  const { items, unread, loading, error, hasMore, loadMore, markRead, markAllRead, dismiss } =
    notifications;
  const [now, setNow] = useState(Date.now());
  const [setupReport, setSetupReport] = useState<DoctorReportWithDismiss | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const countBySeverity = useMemo(() => {
    const c: Record<string, number> = { action: 0, error: 0, info: 0 };
    for (const n of items) c[n.severity] = (c[n.severity] ?? 0) + 1;
    return c;
  }, [items]);
  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((n) => n.severity === filter)),
    [items, filter],
  );

  // 每 30s 刷新相对时间（通知不需要秒级滚动）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.setupStatus().then(setSetupReport).catch(() => {});
  }, []);

  const showSetupBanner =
    !!setupReport && setupReport.status === "error" && !setupReport.setupDismissed;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-bold">通知</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {loading ? "…" : unread > 0 ? `${unread} 条未读` : "全部已读"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
              onClick={() => void markAllRead().catch(() => {})}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              全部已读
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="收起面板"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 分类筛选：内核 severity 的业务标签（hover 露出内核名） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        {FILTERS.map((f) => {
          const count = f.key === "all" ? items.length : countBySeverity[f.key] ?? 0;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              title={f.key === "all" ? "全部通知" : `severity: ${f.key}`}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                filter === f.key
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {f.label}
              {count > 0 && <span className="ml-1 font-mono text-[10px] opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
        {showSetupBanner && (
          <div className="mb-3 rounded-md border border-border p-3 text-sm">
            ⚠ 未完成首跑配置
            <Link to="/setup" className="ml-2 underline">开始 ▸</Link>
          </div>
        )}

        {/* 持续状态 banner：provider 不健康（恢复自动消失，不进通知流） */}
        <ProviderHealthBanner />

        {error && (
          <div className="mb-3 rounded-lg border border-border bg-card px-4 py-3">
            <p className="mb-1 text-[10px] text-destructive">ERROR</p>
            <p className="text-sm text-foreground">{error}</p>
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="mt-12 flex flex-col items-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="mt-2 text-xs">加载通知...</p>
          </div>
        )}

        {!loading && !error && items.length === 0 && <NowEmptyGuide />}

        {!loading && !error && items.length > 0 && visible.length === 0 && (
          <p className="mt-8 text-center text-xs text-muted-foreground">
            该分类下暂无通知（已加载范围内）
          </p>
        )}

        <div className="flex flex-col gap-2">
          {visible.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              now={now}
              onRead={(id) => void markRead([id]).catch(() => {})}
              onDismiss={(id) => void dismiss(id).catch(() => {})}
            />
          ))}
        </div>

        {hasMore && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              className="text-[11px]"
              onClick={() => void loadMore().catch(() => {})}
            >
              加载更早的通知
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
