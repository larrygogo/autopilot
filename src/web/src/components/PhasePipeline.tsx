import React from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PHASE_LABEL } from "@/lib/workflow-labels";

// ──────────────────────────────────────────────
// 流水线视图 — 横向显示工作流阶段，并行块以分叉展示
// ──────────────────────────────────────────────

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

/**
 * 选取阶段显示名：yaml 里写的 label 优先（中文/任意语言）；
 * 没写但命中静态 PHASE_LABEL 映射时回退；都没有就显示原始 name。
 *
 * 注意 registry 在 expandPhaseDefaults 会把缺省 label 填成 name.toUpperCase()，
 * 所以这里要把"全大写形态的 name"识别为"无 label"，不要把它当成用户写的中文。
 */
function pickPhaseLabel(item: { name: string; label?: string }): string {
  const userLabel = item.label && item.label !== item.name.toUpperCase() ? item.label : undefined;
  return userLabel ?? PHASE_LABEL[item.name] ?? item.name;
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
                label={entry.label}
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
        "flex min-w-[7rem] shrink-0 cursor-default flex-col items-center justify-center gap-1 rounded-none border-[1.5px] border-foreground/30 bg-card px-3 py-2 text-center transition-all",
        "hover:border-foreground hover:bg-secondary",
        highlight && "border-foreground bg-secondary",
        current && "border-accent bg-accent/12 shadow-[3px_3px_0_0_var(--color-accent)]",
      )}
      onMouseEnter={() => onHover?.(phase.name)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div
        className={cn(
          "max-w-[10rem] truncate font-display text-xs font-bold uppercase tracking-wider",
          current ? "text-accent" : "text-foreground",
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

function ParallelNode({
  name, label, failStrategy, phases, highlight, currentPhase, onHover,
}: {
  name: string;
  label?: string;
  failStrategy?: string;
  phases: PhaseItem[];
  highlight?: string | null;
  currentPhase: string | null;
  onHover?: (name: string | null) => void;
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
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  );
}
