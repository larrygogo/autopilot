import React from "react";

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
    return <p className="muted">尚无阶段，添加一个阶段以查看流水线</p>;
  }

  return (
    <div className="pipeline-wrap">
      <div className="pipeline">
        {entries.map((entry, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="pipeline-arrow">→</span>}
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
        <div className="pipeline-rejects">
          <span className="muted" style={{ fontSize: "0.76rem" }}>驳回规则：</span>
          {rejects.map((r, i) => (
            <span key={i} className="pipeline-reject">
              <code className="mono">{r.from}</code>
              <span style={{ color: "var(--yellow)" }}>↺</span>
              <code className="mono">{r.to}</code>
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
      className={`pipeline-node ${current ? "current" : ""} ${highlight ? "highlight" : ""}`}
      onMouseEnter={() => onHover?.(phase.name)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="pipeline-node-name mono">{phase.name}</div>
      {phase.timeout && (
        <div className="pipeline-node-meta muted">{fmtTimeout(phase.timeout)}</div>
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
    <div className="pipeline-parallel">
      <div
        className={`pipeline-parallel-head ${headHighlight ? "highlight" : ""}`}
        onMouseEnter={() => onHover?.(name)}
        onMouseLeave={() => onHover?.(null)}
      >
        <span className="pill pill-accent" style={{ fontSize: "0.7rem" }}>并行</span>
        <span className="mono" style={{ fontSize: "0.85rem" }}>{name}</span>
        {failStrategy && (
          <span className="muted" style={{ fontSize: "0.7rem" }}>· {failStrategy}</span>
        )}
      </div>
      <div className="pipeline-parallel-body">
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
