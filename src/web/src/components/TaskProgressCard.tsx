import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Loader2, AlertCircle, CheckCircle2, XCircle, RotateCw } from "lucide-react";
import { api } from "@/hooks/useApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useToast } from "@/components/Toast";
import { pickPhaseLabel } from "@/lib/workflow-labels";

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

interface TaskInfo {
  id: string;
  status: string;
  workflow: string;
  title: string;
  updated_at: string;
  started_at: string | null;
  pr_url?: string | null;
  dangling?: boolean;
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

export function TaskProgressCard({
  taskId,
  showDetailLink = true,
  showActions = true,
}: {
  taskId: string;
  /** 是否显示「查看完整日志」链接，TaskDetail 页面内嵌时关闭 */
  showDetailLink?: boolean;
  /** 是否显示「取消任务」「从当前阶段重试」按钮，TaskDetail 顶部已有时关闭 */
  showActions?: boolean;
}) {
  const { subscribe } = useWebSocket();
  const toast = useToast();
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [now, setNow] = useState(Date.now());
  // 当前任务所属工作流的 phase 定义（按 name 索引），用于显示 phase.label
  const [phasesByName, setPhasesByName] = useState<Map<string, { name: string; label?: string }>>(new Map());

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

  // task.workflow 拿到后拉一次工作流定义，索引 phases 给 label 显示用
  useEffect(() => {
    if (!task?.workflow) return;
    let cancelled = false;
    api.getWorkflow(task.workflow)
      .then((wf) => {
        if (cancelled) return;
        const map = new Map<string, { name: string; label?: string }>();
        const walk = (list: unknown[]): void => {
          for (const p of list) {
            if (!p || typeof p !== "object") continue;
            const obj = p as Record<string, unknown>;
            if (obj.parallel && typeof obj.parallel === "object") {
              const par = obj.parallel as Record<string, unknown>;
              if (Array.isArray(par.phases)) walk(par.phases);
            } else if (typeof obj.name === "string") {
              map.set(obj.name, {
                name: obj.name,
                label: typeof obj.label === "string" ? obj.label : undefined,
              });
            }
          }
        };
        walk(Array.isArray(wf.phases) ? wf.phases : []);
        setPhasesByName(map);
      })
      .catch(() => { /* 静默：fallback 到原 name 显示 */ });
    return () => { cancelled = true; };
  }, [task?.workflow]);

  if (!task) return null;

  const parsed = parsePhaseFromStatus(task.status);
  const phaseName = parsed.phase;
  // 从工作流定义里查当前 phase 的 label；没拿到就显示原 name
  const phaseDef = phaseName ? (phasesByName.get(phaseName) ?? null) : null;
  const phaseLabel = phaseName
    ? pickPhaseLabel({ name: phaseName, label: phaseDef?.label })
    : null;
  const isDangling = !!task.dangling;
  const isFailed = task.status.startsWith("failed_") || (task.status === "cancelled" && recentError);
  const isCancelled = task.status === "cancelled" && !recentError;
  const isDone = task.status === "done";
  const isRunning = task.status.startsWith("running_") && !isDangling;

  const startedMs = task.started_at ? new Date(task.started_at).getTime() : null;
  const elapsedMs = startedMs ? now - startedMs : 0;

  async function cancelTask() {
    if (!confirm("确认取消任务？已生成的产物会保留。")) return;
    // optimistic：立刻显示 cancelled，不等服务端
    const prev = task;
    if (task) setTask({ ...task, status: "cancelled" });
    setCancelling(true);
    try {
      await api.cancelTask(taskId);
      toast.success("任务已取消");
    } catch (e: unknown) {
      if (prev) setTask(prev);
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setCancelling(false);
    }
  }

  async function restartTask() {
    // optimistic：从原 status 提取 phase 名，立刻显示 pending_<phase>
    const prev = task;
    if (task) {
      const m = task.status.match(/^(?:running_|pending_|awaiting_|failed_)(.+)$/);
      const phase = m ? m[1] : null;
      if (phase) setTask({ ...task, status: `pending_${phase}`, dangling: false });
    }
    setRestarting(true);
    try {
      await api.restartTask(taskId);
      toast.success("任务已重启");
    } catch (e: unknown) {
      if (prev) setTask(prev);
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between gap-2 border-b border-dashed border-foreground/25 px-5 py-3">
        <div className="flex items-center gap-2.5">
          {isRunning && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
          {isDone && <CheckCircle2 className="h-4 w-4 text-success" />}
          {(isFailed || isDangling) && <AlertCircle className="h-4 w-4 text-destructive" />}
          {isCancelled && <XCircle className="h-4 w-4 text-muted-foreground" />}
          <h2 className="font-display text-sm font-bold uppercase tracking-wider">任务进度</h2>
          {phaseLabel && (
            <Badge variant={(isFailed || isDangling) ? "destructive" : isRunning ? "default" : "secondary"}>
              {phaseLabel}
            </Badge>
          )}
        </div>
        {showDetailLink && (
          // 把"看实时日志"从小字 link 升级为可见的 small button，
          // 任务运行时这就是用户最想点的目标，避免被边角弱视觉藏起来
          <Button
            asChild
            variant={isRunning ? "default" : "outline"}
            size="sm"
            className="rounded-none font-mono text-[10px] uppercase tracking-[0.14em]"
          >
            <Link to={`/tasks/${taskId}`}>
              <ExternalLink className="mr-1 h-3 w-3" />
              {isRunning ? "看实时日志" : "看任务详情"}
            </Link>
          </Button>
        )}
      </div>

      <div className="space-y-3 p-5">
        {isDangling && (
          <div className="border-[1.5px] border-destructive bg-destructive/10 p-3 text-xs text-destructive">
            <div className="mb-1 font-display font-bold uppercase tracking-wider">⚠ 任务已失联</div>
            <p className="leading-relaxed opacity-90">
              daemon 在该任务执行 <span className="font-semibold">{phaseLabel ?? task.status}</span> 阶段时被重启，
              内存中的执行流已丢失。task 的产出（如已完成的方案设计 / 部分代码）仍保留，
              但当前阶段不会自动继续。请选择「从当前阶段重试」让任务接着跑，或「取消任务」放弃。
            </p>
          </div>
        )}

        {isRunning && (
          <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            正在执行 <span className="font-semibold text-foreground">{phaseLabel}</span> 阶段
            {startedMs && <span className="ml-1">· 已耗时 {formatElapsed(elapsedMs)}</span>}
          </div>
        )}

        {parsed.kind === "pending" && phaseLabel && (
          <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            准备进入 <span className="font-semibold text-foreground">{phaseLabel}</span> 阶段…
          </div>
        )}

        {isDone && (
          <div className="font-mono text-[11px] uppercase tracking-wider text-success">
            ✓ 任务已完成
          </div>
        )}

        {isCancelled && (
          <div className="border-[1.5px] border-foreground/30 bg-muted/40 p-3 font-mono text-xs tracking-wider text-muted-foreground">
            任务已取消
          </div>
        )}

        {isFailed && recentError && (
          <div className="border-[1.5px] border-destructive bg-destructive/10 p-3 text-xs text-destructive">
            <div className="mb-1 font-display font-bold uppercase tracking-wider">执行失败</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed opacity-90">
              {recentError.length > 400 ? recentError.slice(0, 400) + "…" : recentError}
            </pre>
          </div>
        )}

        {/* 操作按钮 */}
        {showActions && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(isRunning || parsed.kind === "pending") && (
              <Button variant="outline" size="sm" onClick={() => void cancelTask()} disabled={cancelling}>
                {cancelling ? "取消中…" : "取消任务"}
              </Button>
            )}
            {(isFailed || isCancelled || isDangling) && (
              <>
                <Button variant="outline" size="sm" onClick={() => void restartTask()} disabled={restarting}>
                  <RotateCw className="mr-1 h-3 w-3" />
                  {restarting ? "重启中…" : "从当前阶段重试"}
                </Button>
                {isDangling && (
                  <Button variant="outline" size="sm" onClick={() => void cancelTask()} disabled={cancelling}>
                    {cancelling ? "取消中…" : "取消任务"}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
