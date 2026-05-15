import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/hooks/useApi";

interface HistoryTask {
  id: string;
  title: string;
  workflow: string;
  status: string;
  updated_at: string;
}

/**
 * 近期已结束（done / failed）的任务列表。
 *
 * 之前在「库」页有独立 tab，现在归并到「现在」页底部，作为待办之外的"看看刚刚做完了啥"
 * 视图。Now 页焦点仍是顶部 cards（待办），此组件提供低优先级背景信息。
 */
export function RecentHistoryList({ limit = 20 }: { limit?: number }) {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [done, failed] = await Promise.all([
          api.listTasks({ status: "done" }) as Promise<HistoryTask[]>,
          api.listTasks({ status: "failed" }) as Promise<HistoryTask[]>,
        ]);
        if (cancelled) return;
        const merged = [...done, ...failed]
          .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
          .slice(0, limit);
        setTasks(merged);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [limit]);

  if (loading) {
    return (
      <div className="py-6 text-center text-muted-foreground font-mono text-xs uppercase tracking-[0.12em]">
        加载历史...
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-2 border-[1.5px] border-l-4 border-foreground/30 border-l-destructive bg-card px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive mb-1">ERROR</p>
        <p className="text-sm text-foreground">{error}</p>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="py-6 text-center text-muted-foreground">
        <p className="font-mono text-xs uppercase tracking-[0.12em]">暂无已结束的任务</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link
            to={`/tasks/${t.id}`}
            className="flex items-center gap-4 border-[1.5px] border-foreground/30 bg-card px-4 py-2.5 rounded-none hover:border-accent transition-colors"
          >
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.18em] ${
                t.status === "done" ? "text-success" : "text-destructive"
              }`}
            >
              {t.status === "done" ? "DONE" : "FAILED"}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t.id}
            </span>
            <span className="font-display text-sm font-medium truncate flex-1">{t.title}</span>
            <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground shrink-0">
              {t.workflow}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
