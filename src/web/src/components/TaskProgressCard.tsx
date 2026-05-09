import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Loader2, AlertCircle, CheckCircle2, XCircle, RotateCw } from "lucide-react";
import { api } from "@/hooks/useApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useToast } from "@/components/Toast";

// task.status 通常是 "running_<phase>" / "pending_<phase>" / "<phase>_complete" / "cancelled" / "done" / "failed_<phase>"
function parsePhaseFromStatus(status: string): { kind: "running" | "pending" | "complete" | "terminal"; phase: string | null } {
  if (status === "done") return { kind: "terminal", phase: null };
  if (status === "cancelled") return { kind: "terminal", phase: null };
  if (status.startsWith("running_")) return { kind: "running", phase: status.slice("running_".length) };
  if (status.startsWith("pending_")) return { kind: "pending", phase: status.slice("pending_".length) };
  if (status.startsWith("failed_")) return { kind: "terminal", phase: status.slice("failed_".length) };
  if (status.endsWith("_complete")) return { kind: "complete", phase: status.slice(0, -"_complete".length) };
  return { kind: "running", phase: null };
}

const PHASE_LABEL: Record<string, string> = {
  design: "方案设计",
  review: "方案评审",
  develop: "代码开发",
  code_review: "代码审查",
  submit_pr: "提交 PR",
  await_review: "等待 PR review",
  fix_revision: "PR 修复",
};

interface TaskInfo {
  id: string;
  status: string;
  workflow: string;
  title: string;
  updated_at: string;
  started_at: string | null;
  pr_url?: string | null;
}

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  phase?: string;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}min`;
}

export function TaskProgressCard({ taskId }: { taskId: string }) {
  const { subscribe } = useWebSocket();
  const toast = useToast();
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const t = await api.getTask(taskId);
      setTask(t as TaskInfo);
      // 拉最近的错误日志（如果有）
      const logs = await api.getTaskLogs(taskId, 50).catch(() => [] as LogEntry[]);
      const lastError = [...(logs ?? [])].reverse().find((l: LogEntry) => l.level === "error" || l.level === "ERROR");
      setRecentError(lastError?.message ?? null);
    } catch {
      // ignore
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // WebSocket 推送：任务/阶段变化时刷新
  useEffect(() => {
    const off1 = subscribe(`task:${taskId}`, () => void refresh());
    const off2 = subscribe(`phase:${taskId}`, () => void refresh());
    return () => { off1(); off2(); };
  }, [taskId, subscribe, refresh]);

  // 每秒刷新已耗时（仅当任务 running）
  useEffect(() => {
    if (!task) return;
    const isRunning = task.status.startsWith("running_") || task.status.startsWith("pending_");
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [task]);

  if (!task) return null;

  const parsed = parsePhaseFromStatus(task.status);
  const phaseName = parsed.phase;
  const phaseLabel = phaseName ? (PHASE_LABEL[phaseName] ?? phaseName) : null;
  const isFailed = task.status.startsWith("failed_") || (task.status === "cancelled" && recentError);
  const isCancelled = task.status === "cancelled" && !recentError;
  const isDone = task.status === "done";
  const isRunning = task.status.startsWith("running_");

  const startedMs = task.started_at ? new Date(task.started_at).getTime() : null;
  const elapsedMs = startedMs ? now - startedMs : 0;

  async function cancelTask() {
    if (!confirm("确认取消任务？已生成的产物会保留。")) return;
    setCancelling(true);
    try {
      await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
      await refresh();
      toast.success("任务已取消");
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setCancelling(false);
    }
  }

  async function restartTask() {
    setRestarting(true);
    try {
      await fetch(`/api/tasks/${taskId}/restart`, { method: "POST" });
      await refresh();
      toast.success("任务已重启");
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isRunning && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {isDone && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {isFailed && <AlertCircle className="h-4 w-4 text-destructive" />}
          {isCancelled && <XCircle className="h-4 w-4 text-muted-foreground" />}
          <h2 className="text-sm font-semibold">任务进度</h2>
          {phaseLabel && (
            <Badge variant={isFailed ? "destructive" : isRunning ? "default" : "secondary"} className="text-[10px]">
              {phaseLabel}
            </Badge>
          )}
        </div>
        <Link
          to={`/tasks/${taskId}`}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          查看完整日志
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {isRunning && (
        <div className="text-xs text-muted-foreground">
          正在执行 <span className="font-medium text-foreground">{phaseLabel}</span> 阶段
          {startedMs && <span className="ml-1">· 已耗时 {formatElapsed(elapsedMs)}</span>}
        </div>
      )}

      {parsed.kind === "pending" && phaseLabel && (
        <div className="text-xs text-muted-foreground">
          准备进入 <span className="font-medium text-foreground">{phaseLabel}</span> 阶段…
        </div>
      )}

      {isDone && (
        <div className="text-xs text-green-700 dark:text-green-400">任务已完成。</div>
      )}

      {isCancelled && (
        <div className="rounded-md border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
          任务已取消。
        </div>
      )}

      {isFailed && recentError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="mb-1 font-medium">执行失败</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed opacity-90">
            {recentError.length > 400 ? recentError.slice(0, 400) + "…" : recentError}
          </pre>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="mt-3 flex flex-wrap gap-2">
        {(isRunning || parsed.kind === "pending") && (
          <Button variant="outline" size="sm" onClick={() => void cancelTask()} disabled={cancelling} className="h-7 text-xs">
            {cancelling ? "取消中…" : "取消任务"}
          </Button>
        )}
        {(isFailed || isCancelled) && (
          <Button variant="outline" size="sm" onClick={() => void restartTask()} disabled={restarting} className="h-7 text-xs">
            <RotateCw className="mr-1 h-3 w-3" />
            {restarting ? "重启中…" : "从当前阶段重试"}
          </Button>
        )}
      </div>
    </Card>
  );
}
