import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";

/** WS 断开多久后认定"显示中的任务状态可能已过期"（毫秒） */
const STALE_AFTER_MS = 10_000;

interface RunningTask {
  id: string;
  title: string;
  workflow: string;
  status: string;
}

/**
 * Header 全局任务运行状态条。
 *
 * 解决 PM 报告里的"我离开页面任务还在跑吗"痛点：
 * 用户合电脑去吃饭、回来 web，header 一眼看到「⚙ 3 个任务在跑」；
 * 点击直达任务看板（多个）或任务详情（单个）。
 *
 * 数据来源：
 * - 启动时拉一次 listTasks
 * - WebSocket task:* 频道有任务状态变化 → 重拉
 * - 兜底每 60s 自动刷新（防 WebSocket 漏推）
 */
export function RunningTasksIndicator() {
  const navigate = useNavigate();
  const { state: wsState, subscribe } = useWebSocket();
  const [running, setRunning] = useState<RunningTask[]>([]);
  // WS 断线超过 STALE_AFTER_MS 时进入 stale 状态：UI 灰化 + tooltip 提示
  const [stale, setStale] = useState(false);

  const refresh = useCallback(() => {
    api.listTasks()
      .then((list) => {
        const arr = (list as RunningTask[]).filter((t) => t.status?.startsWith("running_"));
        setRunning(arr);
      })
      .catch(() => { /* 静默 */ });
  }, []);

  useEffect(() => {
    refresh();
    // WebSocket: 任意 task 状态变化 → 重拉
    const off = subscribe("task:*", () => refresh());
    // 兜底定时刷新
    const t = setInterval(refresh, 60_000);
    return () => { off(); clearInterval(t); };
  }, [refresh, subscribe]);

  // WS 断开 > STALE_AFTER_MS 时把状态条灰化（别再骗用户"正在跑"），重连成功立刻还原
  useEffect(() => {
    if (wsState === "connected") {
      setStale(false);
      return;
    }
    const timer = setTimeout(() => setStale(true), STALE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [wsState]);

  if (running.length === 0) return null;

  const handleClick = () => {
    if (running.length === 1) {
      navigate(`/tasks/${running[0]!.id}`);
    } else {
      navigate("/tasks");
    }
  };

  // 单任务：显示 task id + phase；多个：显示数量
  const single = running.length === 1 ? running[0]! : null;
  const phase = single ? parsePhase(single.status) : null;

  const baseTitle = single
    ? `任务 ${single.id} 在 ${phase ?? "running"} 阶段，点击查看`
    : `${running.length} 个任务在跑，点击查看看板`;
  const title = stale ? `${baseTitle}（与 daemon 失联，状态可能已过期）` : baseTitle;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        stale
          ? "hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60"
          : "hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/8 px-2.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent/15"
      }
      title={title}
    >
      {stale ? (
        <AlertTriangle className="h-3 w-3" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {single ? (
        <span className="truncate max-w-[14rem]">
          {single.id}
          {phase && <span className="ml-1 opacity-75">· {phase}</span>}
        </span>
      ) : (
        <span>{stale ? `${running.length} 个任务（状态未知）` : `${running.length} 个任务在跑`}</span>
      )}
    </button>
  );
}

function parsePhase(status: string): string | null {
  const m = status.match(/^running_(.+)$/);
  return m ? m[1] : null;
}
