import { useEffect, useMemo, useState } from "react";
import type { TaskPhaseEvent } from "@/hooks/useApi";
import { cn } from "@/lib/utils";

export interface TaskPhaseTimelineProps {
  /** 工作流 phase 顺序（取自 workflow.yaml） */
  workflowPhases: string[];
  events: TaskPhaseEvent[];
  /** 同 workflow 历史 phase 耗时 P50 — 给"还要多久"参考（可选；缺失时不显示参考线） */
  phaseStats?: Record<string, { count: number; p50_ms: number }>;
}

interface PhaseSummary {
  phase: string;
  totalMs: number;
  latestStatus: "running" | "done" | "awaiting" | "failed" | null;
  runningStartedAt: number | null;
  retryCount: number;
}

function aggregate(events: TaskPhaseEvent[], workflowPhases: string[]): PhaseSummary[] {
  const map = new Map<string, PhaseSummary>();
  for (const phase of workflowPhases) {
    map.set(phase, { phase, totalMs: 0, latestStatus: null, runningStartedAt: null, retryCount: 0 });
  }
  for (const e of events) {
    const s = map.get(e.phase);
    if (!s) continue;
    s.retryCount += 1;
    s.latestStatus = e.status;
    if (e.status === "running") {
      s.runningStartedAt = e.started_at;
    } else if (e.ended_at !== null) {
      s.totalMs += e.ended_at - e.started_at;
    }
  }
  return workflowPhases.map((p) => map.get(p)!);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function StatusIcon({ status }: { status: PhaseSummary["latestStatus"] }) {
  if (status === "done")     return <span className="text-success">✓</span>;
  if (status === "awaiting") return <span className="text-warning">⊙</span>;
  if (status === "running")  return <span className="text-accent">▶</span>;
  if (status === "failed")   return <span className="text-destructive">✗</span>;
  return <span className="text-muted-foreground">□</span>;
}

function StatusText({ status }: { status: PhaseSummary["latestStatus"] }) {
  switch (status) {
    case "done":     return <span>完成</span>;
    case "awaiting": return <span>等待用户决断</span>;
    case "running":  return <span>进行中</span>;
    case "failed":   return <span>失败</span>;
    default:         return <span>待运行</span>;
  }
}

export function TaskPhaseTimeline({ workflowPhases, events, phaseStats }: TaskPhaseTimelineProps) {
  const summaries = useMemo(() => aggregate(events, workflowPhases), [events, workflowPhases]);
  const [now, setNow] = useState(Date.now());

  // 有进行中 phase 时 1Hz 重渲，让 elapsed 滚动
  useEffect(() => {
    const hasRunning = summaries.some((s) => s.runningStartedAt !== null);
    if (!hasRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [summaries]);

  // 当前进行中 phase 在序列里的位置（1-based）；没有进行中时 = 已完成最末位 + 1
  const currentIndex = useMemo(() => {
    const runningIdx = summaries.findIndex((s) => s.runningStartedAt !== null);
    if (runningIdx >= 0) return runningIdx + 1;
    const lastDoneIdx = summaries.map((s) => s.latestStatus).lastIndexOf("done");
    return lastDoneIdx >= 0 ? lastDoneIdx + 1 : 0;
  }, [summaries]);

  if (workflowPhases.length === 0) return null;

  return (
    <section className="mb-4 border-[1.5px] border-foreground/30 bg-card">
      <header className="flex items-center justify-between border-b-[1.5px] border-foreground/30 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          阶段进度
        </span>
        {/* 当前 / 总数 — 让长任务能看到"还差几步" */}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {currentIndex > 0 ? `${currentIndex} / ${workflowPhases.length}` : `${workflowPhases.length} 步`}
        </span>
      </header>
      <ul className="divide-y divide-foreground/10">
        {summaries.map((s, idx) => {
          const runningMs = s.runningStartedAt !== null ? now - s.runningStartedAt : 0;
          const displayMs = s.totalMs + runningMs;
          const isActive = s.runningStartedAt !== null || s.latestStatus === "awaiting";
          const ref = phaseStats?.[s.phase];
          // 仅当历史样本 >= 2 且此 phase 已开跑（有任何事件或正在跑）时显示参考耗时
          const showRef = ref && ref.count >= 2 && (displayMs > 0 || isActive);
          return (
            <li key={s.phase} className={cn("flex items-center gap-3 px-3 py-2 font-mono text-xs", isActive && "bg-accent/5")}>
              <span className="w-6 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                {idx + 1}.
              </span>
              <span className="w-4 shrink-0">
                <StatusIcon status={s.latestStatus} />
              </span>
              <span className="flex-1 truncate">{s.phase}</span>
              {s.retryCount > 1 && (
                <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  ×{s.retryCount}
                </span>
              )}
              {showRef && (
                <span
                  className="hidden md:inline text-[10px] tabular-nums text-muted-foreground"
                  title={`同工作流历史 ${ref!.count} 次完成，中位耗时 ${formatDuration(ref!.p50_ms)}`}
                >
                  P50≈{formatDuration(ref!.p50_ms)}
                </span>
              )}
              <span
                className={cn(
                  "min-w-[3rem] shrink-0 text-right tabular-nums text-muted-foreground",
                  // 当前耗时超过历史 P50 1.5 倍时高亮提示用户"比往常慢"
                  showRef && displayMs > ref!.p50_ms * 1.5 && isActive && "text-warning",
                )}
              >
                {displayMs > 0 ? formatDuration(displayMs) : "—"}
              </span>
              {/* 状态文字在窄屏隐藏（已经有 StatusIcon 一目了然），仅 lg 显示 */}
              <span className="hidden w-28 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground lg:inline-block">
                <StatusText status={s.latestStatus} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
