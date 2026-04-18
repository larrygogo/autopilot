import React from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// 流水线视图 — 横向显示工作流阶段，并行块以分叉展示
// ──────────────────────────────────────────────

type PhaseItem = {
  name: string;
  timeout?: number;
  reject?: string | null;
};

type Entry =
  | { kind: "phase"; phase: PhaseItem }
  | { kind: "parallel"; name: string; fail_strategy?: string; phases: PhaseItem[] };

interface Props {
  /** 工作流详情中的 phases 原始数组 */
  phases: any[];
  /** 当前高亮的阶段名（受 hover 或 current state 控制） */
  highlight?: string | null;
  onHoverPhase?: (name: string | null) => void;
  /** 任务当前状态（仅显示，用于标记 current） */
  currentState?: string;
}

function normalize(raw: any[]): Entry[] {
  return raw.map((p) => {
    if (p && p.parallel) {
      return {
        kind: "parallel" as const,
        name: p.parallel.name,
        fail_strategy: p.parallel.fail_strategy,
        phases: (p.parallel.phases ?? []).map((sub: any) => ({
          name: sub.name,
          timeout: sub.timeout,
        })),
      };
    }
    return { kind: "phase" as const, phase: { name: p.name, timeout: p.timeout, reject: p.reject ?? null } };
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

export function PhasePipeline({ phases, highlight, onHoverPhase, currentState }: Props) {
  const entries = React.useMemo(() => normalize(phases), [phases]);
  const currentPhase = phaseFromState(currentState);
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
                onHover={onHoverPhase}
              />
            ) : (
              <ParallelNode
                name={entry.name}
                failStrategy={entry.fail_strategy}
                phases={entry.phases}
                highlight={highlight}
                currentPhase={currentPhase}
                onHover={onHoverPhase}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {rejects.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-3">
          <span className="text-xs text-muted-foreground">驳回规则：</span>
          {rejects.map((r, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs"
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
  phase, highlight, current, onHover,
}: {
  phase: PhaseItem;
  highlight?: boolean;
  current?: boolean;
  onHover?: (name: string | null) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-[7rem] shrink-0 cursor-default flex-col items-center justify-center gap-1 rounded-md border bg-card px-3 py-2 text-center shadow-sm transition-colors",
        "hover:border-primary/40 hover:bg-accent/40",
        highlight && "border-primary/50 bg-accent/60 ring-1 ring-primary/30",
        current && "border-primary bg-primary/10 ring-2 ring-primary/40",
      )}
      onMouseEnter={() => onHover?.(phase.name)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div
        className={cn(
          "max-w-[10rem] truncate font-mono text-xs font-medium",
          current ? "text-primary" : "text-foreground",
        )}
      >
        {phase.name}
      </div>
      {phase.timeout && (
        <div className="text-[10px] text-muted-foreground">{fmtTimeout(phase.timeout)}</div>
      )}
    </div>
  );
}

function ParallelNode({
  name, failStrategy, phases, highlight, currentPhase, onHover,
}: {
  name: string;
  failStrategy?: string;
  phases: PhaseItem[];
  highlight?: string | null;
  currentPhase: string | null;
  onHover?: (name: string | null) => void;
}) {
  const headHighlight = highlight === name;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-md border border-dashed bg-muted/30 p-2">
      <div
        className={cn(
          "flex cursor-default items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors",
          headHighlight && "bg-accent/60",
        )}
        onMouseEnter={() => onHover?.(name)}
        onMouseLeave={() => onHover?.(null)}
      >
        <Badge variant="info" className="px-1.5 py-0 text-[10px]">并行</Badge>
        <span className="font-mono text-xs">{name}</span>
        {failStrategy && (
          <span className="text-[10px] text-muted-foreground">· {failStrategy}</span>
        )}
      </div>
      <div className="flex items-stretch gap-1.5">
        {phases.map((p) => (
          <PhaseNode
            key={p.name}
            phase={p}
            highlight={highlight === p.name}
            current={currentPhase === p.name}
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  );
}
