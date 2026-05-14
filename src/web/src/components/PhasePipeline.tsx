import React from "react";
import { ArrowRight, RotateCcw, Loader2, CheckCircle2, AlertCircle, Clock, Hand } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pickPhaseLabel } from "@/lib/workflow-labels";

// ──────────────────────────────────────────────
// 流水线视图 — 横向显示工作流阶段，并行块以分叉展示
// ──────────────────────────────────────────────

export type PhasePipelineRunStatus = "pending" | "running" | "done" | "failed" | "skipped" | "awaiting" | "idle";

type PhaseItem = {
  name: string;
  label?: string;
  timeout?: number;
  reject?: string | null;
};

type Entry =
  | { kind: "phase"; phase: PhaseItem }
  | { kind: "parallel"; name: string; label?: string; fail_strategy?: string; phases: PhaseItem[] };

interface Props {
  /** 工作流详情中的 phases 原始数组 */
  phases: any[];
  /** 当前高亮的阶段名（受 hover 或 current state 控制） */
  highlight?: string | null;
  onHoverPhase?: (name: string | null) => void;
  /** 任务当前状态（仅显示，用于标记 current） */
  currentState?: string;
  /** 点击节点回调；提供时节点变可点击 */
  onPhaseClick?: (name: string) => void;
  /**
   * 每个阶段的运行状态映射；提供时节点角标显示状态。
   * 不提供时仅按 currentState 推导当前节点。
   */
  phaseStatuses?: Record<string, PhasePipelineRunStatus>;
}

function normalize(raw: any[]): Entry[] {
  return raw.map((p) => {
    if (p && p.parallel) {
      return {
        kind: "parallel" as const,
        name: p.parallel.name,
        label: typeof p.parallel.label === "string" ? p.parallel.label : undefined,
        fail_strategy: p.parallel.fail_strategy,
        phases: (p.parallel.phases ?? []).map((sub: any) => ({
          name: sub.name,
          label: typeof sub.label === "string" ? sub.label : undefined,
          timeout: sub.timeout,
        })),
      };
    }
    return {
      kind: "phase" as const,
      phase: {
        name: p.name,
        label: typeof p.label === "string" ? p.label : undefined,
        timeout: p.timeout,
        reject: p.reject ?? null,
      },
    };
  });
}

// 从 current state 猜对应的 phase name：pending_x / running_x / complete_x → x
function phaseFromState(s?: string): string | null {
  if (!s) return null;
  const m = s.match(/^(?:pending|running|complete|start|reject)_(.+)$/);
  return m ? m[1] : null;
}

function fmtTimeout(t?: number): string {
  if (!t) return "";
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  return `${(t / 3600).toFixed(1)}h`;
}

export function PhasePipeline({ phases, highlight, onHoverPhase, currentState, onPhaseClick, phaseStatuses }: Props) {
  const entries = React.useMemo(() => normalize(phases), [phases]);
  const currentPhase = phaseFromState(currentState);
  // 状态机若停留在 awaiting_<phase>，把当前 phase 视作 awaiting
  const awaitingPhase = currentState?.startsWith("awaiting_")
    ? currentState.slice("awaiting_".length)
    : null;

  // 状态从外部映射优先；否则按 currentState 推导
  const statusFor = (name: string): PhasePipelineRunStatus => {
    if (phaseStatuses?.[name]) return phaseStatuses[name];
    if (currentState === "failed" && currentPhase === name) return "failed";
    if (currentState?.startsWith("failed_") && currentState.slice("failed_".length) === name) return "failed";
    if (awaitingPhase === name) return "awaiting";
    if (currentPhase === name) {
      if (currentState?.startsWith("running_")) return "running";
      if (currentState?.startsWith("pending_")) return "pending";
    }
    return "idle";
  };

  const rejects = entries.flatMap((e, i) =>
    e.kind === "phase" && e.phase.reject
      ? [{ from: e.phase.name, fromIdx: i, to: e.phase.reject }]
      : [],
  );

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">尚无阶段，添加一个阶段以查看流水线</p>;
  }

  return (
    <div className="space-y-3">
      <div className="scrollbar-thin flex items-stretch gap-2 overflow-x-auto pb-1">
        {entries.map((entry, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <ArrowRight
                className="h-4 w-4 shrink-0 self-center text-muted-foreground"
                aria-hidden="true"
              />
            )}
            {entry.kind === "phase" ? (
              <PhaseNode
                phase={entry.phase}
                highlight={highlight === entry.phase.name}
                current={currentPhase === entry.phase.name}
                runStatus={statusFor(entry.phase.name)}
                onHover={onHoverPhase}
                onClick={onPhaseClick}
              />
            ) : (
              <ParallelNode
                name={entry.name}
                label={entry.label}
                failStrategy={entry.fail_strategy}
                phases={entry.phases}
                highlight={highlight}
                currentPhase={currentPhase}
                statusFor={statusFor}
                onHover={onHoverPhase}
                onClick={onPhaseClick}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {rejects.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-dashed border-foreground/25 pt-3">
          <span className="bp-label">驳回规则 · REJECT</span>
          {rejects.map((r, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-none border-[1.5px] border-warning bg-warning/10 px-2 py-0.5 font-mono text-[11px]"
            >
              <code className="font-mono text-foreground">{r.from}</code>
              <RotateCcw className="h-3 w-3 text-warning" aria-hidden="true" />
              <code className="font-mono text-foreground">{r.to}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseNode({
  phase, highlight, current, runStatus, onHover, onClick,
}: {
  phase: PhaseItem;
  highlight?: boolean;
  current?: boolean;
  runStatus?: PhasePipelineRunStatus;
  onHover?: (name: string | null) => void;
  onClick?: (name: string) => void;
}) {
  const clickable = !!onClick;
  const statusBorder = runStatus === "failed"
    ? "border-destructive"
    : runStatus === "done"
    ? "border-success"
    : runStatus === "awaiting"
    ? "border-warning"
    : null;

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={cn(
        "group relative flex min-w-[7rem] shrink-0 flex-col items-center justify-center gap-1 rounded-none border-[1.5px] border-foreground/30 bg-card px-3 py-2 text-center transition-all",
        clickable ? "cursor-pointer hover:border-foreground hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-accent" : "cursor-default hover:border-foreground hover:bg-secondary",
        highlight && "border-foreground bg-secondary",
        current && "border-accent bg-accent/12 shadow-[3px_3px_0_0_var(--color-accent)]",
        statusBorder,
      )}
      onMouseEnter={() => onHover?.(phase.name)}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => onClick?.(phase.name)}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.(phase.name);
        }
      }}
    >
      <PhaseStatusBadge status={runStatus} />
      <div
        className={cn(
          "max-w-[10rem] truncate font-display text-xs font-bold uppercase tracking-wider",
          current ? "text-accent" : runStatus === "failed" ? "text-destructive" : "text-foreground",
        )}
      >
        {pickPhaseLabel(phase)}
      </div>
      <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
        {pickPhaseLabel(phase) !== phase.name && (
          <code className="font-mono opacity-70">{phase.name}</code>
        )}
        {phase.timeout && <span>· {fmtTimeout(phase.timeout)}</span>}
      </div>
    </div>
  );
}

/**
 * 阶段节点右上角的状态角标：仅在 running / done / failed / awaiting 时显示，
 * idle/pending/skipped 不画图标（避免节点视觉过载）。
 */
function PhaseStatusBadge({ status }: { status?: PhasePipelineRunStatus }) {
  if (!status || status === "idle" || status === "pending" || status === "skipped") return null;
  const map = {
    running: { Icon: Loader2, cls: "text-accent animate-spin", title: "执行中" },
    done: { Icon: CheckCircle2, cls: "text-success", title: "已完成" },
    failed: { Icon: AlertCircle, cls: "text-destructive", title: "失败" },
    awaiting: { Icon: Hand, cls: "text-warning", title: "等待人工" },
  } as const;
  const { Icon, cls, title } = map[status];
  return (
    <Icon
      className={cn("absolute -right-1.5 -top-1.5 h-4 w-4 bg-background", cls)}
      aria-label={title}
    />
  );
}

function ParallelNode({
  name, label, failStrategy, phases, highlight, currentPhase, statusFor, onHover, onClick,
}: {
  name: string;
  label?: string;
  failStrategy?: string;
  phases: PhaseItem[];
  highlight?: string | null;
  currentPhase: string | null;
  statusFor?: (name: string) => PhasePipelineRunStatus;
  onHover?: (name: string | null) => void;
  onClick?: (name: string) => void;
}) {
  const headHighlight = highlight === name;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-none border border-dashed border-foreground/40 bg-muted/30 p-2">
      <div
        className={cn(
          "flex cursor-default items-center gap-1.5 rounded-none px-1.5 py-0.5 transition-colors",
          headHighlight && "bg-secondary",
        )}
        onMouseEnter={() => onHover?.(name)}
        onMouseLeave={() => onHover?.(null)}
      >
        <Badge variant="info">并行</Badge>
        <span className="font-display text-xs font-bold uppercase tracking-wider">
          {pickPhaseLabel({ name, label })}
        </span>
        {failStrategy && (
          <span className="font-mono text-[10px] text-muted-foreground">
            · {failStrategy === "cancel_all" ? "失败时全部取消" : failStrategy === "continue" ? "失败时继续" : failStrategy}
          </span>
        )}
      </div>
      <div className="flex items-stretch gap-1.5">
        {phases.map((p) => (
          <PhaseNode
            key={p.name}
            phase={p}
            highlight={highlight === p.name}
            current={currentPhase === p.name}
            runStatus={statusFor?.(p.name)}
            onHover={onHover}
            onClick={onClick}
          />
        ))}
      </div>
    </div>
  );
}
