import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, RotateCcw, Wrench } from "lucide-react";
import { api, type TaskOutcome } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { statusVisual, toneToTextClass } from "@/lib/status-style";

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface TaskOutcomeCardProps {
  taskId: string;
  /** 用户在终态切换时强制重拉 */
  reloadKey?: unknown;
  /** task → requirement 关系（用于"重跑"） */
  requirementId: string | null;
  workflow: string;
  /** task.status；失败时用于解析失败 phase 名（如 failed_design → design） */
  taskStatus?: string;
}

/** 从 task.status 解析失败的 phase 名（failed_design → design）；非失败状态返回 null */
function parseFailedPhase(status: string | undefined): string | null {
  if (!status) return null;
  if (status.startsWith("failed_")) return status.slice("failed_".length);
  return null;
}

export function TaskOutcomeCard({ taskId, reloadKey, requirementId, workflow, taskStatus }: TaskOutcomeCardProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getTaskOutcome(taskId)
      .then(setOutcome)
      .catch(() => setOutcome(null))
      .finally(() => setLoading(false));
  }, [taskId, reloadKey]);

  if (loading || !outcome) return null;

  const vis = statusVisual(outcome.status);
  const statusIcon = vis.glyph;
  const statusLabel = vis.label;
  const statusColor = toneToTextClass(vis.tone);

  async function handleRetry() {
    if (!requirementId) {
      toast.error("无法重跑", "任务未关联需求");
      return;
    }
    setRetrying(true);
    try {
      const t = await api.startTask({ requirement: requirementId, workflow });
      navigate(`/tasks/${t.id}`);
    } catch (e: unknown) {
      toast.error("重跑失败", (e as Error)?.message ?? String(e));
      setRetrying(false);
    }
  }

  return (
    <section className="mb-4 border-[1.5px] border-foreground/30 bg-card">
      <header className="border-b-[1.5px] border-foreground/30 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">产出物</span>
      </header>
      <div className="space-y-3 px-3 py-3 text-sm">
        <div className={"flex items-center gap-2 font-mono " + statusColor}>
          <span className="text-base">{statusIcon}</span>
          <span className="font-bold">{statusLabel}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">总耗时 {formatDuration(outcome.total_duration_ms)}</span>
        </div>

        {outcome.status === "failed" && (
          <div className="border-[1.5px] border-destructive/40 bg-destructive/5 px-2 py-1.5 font-mono text-xs text-destructive">
            {outcome.failure_reason ?? "任务失败，查看下方日志"}
          </div>
        )}

        {outcome.pr_url && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">PR</div>
            <a href={outcome.pr_url} target="_blank" rel="noreferrer" className="text-accent underline break-all">
              #{outcome.pr_number ?? "?"} {outcome.pr_url}
            </a>
          </div>
        )}

        {outcome.diff_stat && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">改动统计</div>
            <div className="font-mono">
              {outcome.diff_stat.files} files changed · <span className="text-success">+{outcome.diff_stat.insertions}</span> / <span className="text-destructive">-{outcome.diff_stat.deletions}</span>
            </div>
          </div>
        )}

        {outcome.top_phases.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">耗时分布（top 3）</div>
            <ul className="font-mono">
              {outcome.top_phases.map((p) => (
                <li key={p.phase} className="flex justify-between">
                  <span>{p.phase}</span>
                  <span className="tabular-nums text-muted-foreground">{formatDuration(p.duration_ms)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {outcome.pr_url && (
            <Button variant="outline" size="sm" onClick={() => window.open(outcome.pr_url!, "_blank")} className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> 看 PR
            </Button>
          )}
          {/* 失败时给"去工作流修复"出口：跳到 /workflows?wf=&phase=，自动选中并展开该 phase drawer */}
          {outcome.status === "failed" && parseFailedPhase(taskStatus) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const phase = parseFailedPhase(taskStatus);
                navigate(`/workflows?wf=${encodeURIComponent(workflow)}&phase=${encodeURIComponent(phase!)}&fromTask=${encodeURIComponent(taskId)}`);
              }}
              className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
            >
              <Wrench className="mr-1 h-3.5 w-3.5" /> 去工作流修复
            </Button>
          )}
          {requirementId && (
            <Button variant="default" size="sm" disabled={retrying} onClick={handleRetry} className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> {retrying ? "重跑中..." : "重跑"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
