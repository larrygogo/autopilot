import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X, Loader2, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationItem } from "@/components/NotificationItem";
import { NowEmptyGuide } from "@/components/NowEmptyGuide";
import { ProviderHealthBanner } from "@/components/ProviderHealthBanner";
import type { UseNotificationsResult } from "@/hooks/useNotifications";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";

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

        <div className="flex flex-col gap-2">
          {items.map((n) => (
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
