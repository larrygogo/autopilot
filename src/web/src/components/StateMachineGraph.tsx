import React, { useMemo } from "react";
import dagre from "dagre";
import { cn } from "@/lib/utils";

interface GraphNode {
  id: string;
  label: string;
  type: "initial" | "pending" | "running" | "terminal" | "other";
}

interface GraphEdge {
  from: string;
  to: string;
  trigger: string;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  currentState?: string;
  /** 阶段名：pending_X / running_X / complete_X 都视作高亮 */
  highlightPhase?: string | null;
  onHoverPhase?: (name: string | null) => void;
}

/** 从节点 id 推断阶段名：pending_foo / running_foo / complete_foo → foo */
function nodePhase(id: string): string | null {
  const m = id.match(/^(?:pending|running|complete|start|reject)_(.+)$/);
  return m ? m[1] : null;
}

/** 把状态机里的 trigger 名缩成可读短名 */
function shortTrigger(t: string): string {
  // start_X / X_complete / X_fail / X_reject → 关键动词
  if (t.startsWith("start_")) return "start";
  if (t.endsWith("_complete")) return "✓";
  if (t.endsWith("_fail")) return "✗";
  if (t.endsWith("_reject")) return "reject";
  if (t === "cancel") return "cancel";
  if (t.startsWith("retry_")) return "retry";
  return t;
}

const NODE_TONE: Record<GraphNode["type"], string> = {
  initial: "text-primary",
  pending: "text-info",
  running: "text-warning",
  terminal: "text-success",
  other: "text-muted-foreground",
};

const NODE_W = 130;
const NODE_H = 38;

export function StateMachineGraph({ nodes, edges, currentState, highlightPhase, onHoverPhase }: Props) {
  const layout = useMemo(() => {
    if (nodes.length === 0) return null;

    // cancel 转换从每个非终态都能触发，画进图里会形成大量穿越；
    // 抽出来作为独立"逃生出口"在主图下方说明。
    const cancelTargetId = edges.find((e) => e.trigger === "cancel")?.to;
    const cancelNode = cancelTargetId ? nodes.find((n) => n.id === cancelTargetId) : undefined;

    const layoutNodes = cancelNode ? nodes.filter((n) => n.id !== cancelNode.id) : nodes;
    const layoutEdges = edges.filter((e) => e.trigger !== "cancel");

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      rankdir: "LR",
      nodesep: 28,
      ranksep: 70,
      edgesep: 12,
      marginx: 16,
      marginy: 16,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of layoutNodes) {
      g.setNode(n.id, { width: NODE_W, height: NODE_H });
    }
    for (let i = 0; i < layoutEdges.length; i++) {
      const e = layoutEdges[i];
      g.setEdge(e.from, e.to, { label: shortTrigger(e.trigger), trigger: e.trigger }, `e${i}`);
    }

    dagre.layout(g);

    const width = g.graph().width ?? 0;
    const height = g.graph().height ?? 0;
    return { g, width, height, layoutNodes, cancelNode };
  }, [nodes, edges]);

  if (!layout) return null;

  const { g, width, height, layoutNodes, cancelNode } = layout;

  return (
    <div className="space-y-2">
    <div className="scrollbar-thin overflow-auto rounded-md">
      <svg
        width={Math.max(width, 320)}
        height={Math.max(height, 120)}
        viewBox={`0 0 ${Math.max(width, 320)} ${Math.max(height, 120)}`}
        className="block font-mono text-foreground"
      >
        <defs>
          <marker
            id="sm-arrow"
            markerWidth="9"
            markerHeight="7"
            refX="8.5"
            refY="3.5"
            orient="auto"
            className="text-muted-foreground"
          >
            <polygon points="0 0, 9 3.5, 0 7" fill="currentColor" />
          </marker>
          <marker
            id="sm-arrow-warn"
            markerWidth="9"
            markerHeight="7"
            refX="8.5"
            refY="3.5"
            orient="auto"
            className="text-warning"
          >
            <polygon points="0 0, 9 3.5, 0 7" fill="currentColor" />
          </marker>
        </defs>

        {/* Edges */}
        <g>
          {g.edges().map((eo, i) => {
            const edge = g.edge(eo) as {
              points: { x: number; y: number }[];
              label?: string;
              trigger?: string;
            };
            if (!edge?.points || edge.points.length < 2) return null;

            const path = pointsToPath(edge.points);
            const trigger = edge.trigger ?? "";
            const isReject = trigger === "cancel" || trigger.endsWith("_reject") || trigger.endsWith("_fail");
            const colorClass = isReject ? "text-warning" : "text-muted-foreground";
            const markerId = isReject ? "sm-arrow-warn" : "sm-arrow";

            // label 位置：路径中点
            const mid = edge.points[Math.floor(edge.points.length / 2)];

            return (
              <g key={i} className={colorClass}>
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={isReject ? 0.7 : 0.55}
                  strokeWidth={1.5}
                  strokeDasharray={isReject ? "4 3" : undefined}
                  markerEnd={`url(#${markerId})`}
                />
                {edge.label && (
                  <g>
                    <rect
                      x={mid.x - measureLabel(edge.label) / 2 - 3}
                      y={mid.y - 7}
                      width={measureLabel(edge.label) + 6}
                      height={12}
                      rx={3}
                      ry={3}
                      className="fill-background"
                      opacity={0.9}
                    />
                    <text
                      x={mid.x}
                      y={mid.y + 1}
                      fill="currentColor"
                      fontSize={9}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="select-none"
                    >
                      {edge.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* Nodes */}
        {layoutNodes.map((node) => {
          const pos = g.node(node.id) as { x: number; y: number } | undefined;
          if (!pos) return null;
          const isCurrent = node.id === currentState;
          const phase = nodePhase(node.id);
          const isHighlight = !!highlightPhase && phase === highlightPhase;

          const baseTone = NODE_TONE[node.type] ?? NODE_TONE.other;
          const ringClass = isCurrent || isHighlight ? "text-primary" : baseTone;
          const strokeWidth = isCurrent ? 2.5 : isHighlight ? 2 : 1.25;

          return (
            <g
              key={node.id}
              className={cn(ringClass, onHoverPhase && phase ? "cursor-pointer" : "cursor-default")}
              onMouseEnter={() => phase && onHoverPhase?.(phase)}
              onMouseLeave={() => onHoverPhase?.(null)}
            >
              <rect
                x={pos.x - NODE_W / 2}
                y={pos.y - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                ry={8}
                className={cn("fill-card", isCurrent && "fill-primary/10")}
                stroke="currentColor"
                strokeWidth={strokeWidth}
              />
              {(isCurrent || isHighlight) && (
                <rect
                  x={pos.x - NODE_W / 2 - 3}
                  y={pos.y - NODE_H / 2 - 3}
                  width={NODE_W + 6}
                  height={NODE_H + 6}
                  rx={10}
                  ry={10}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  opacity={isCurrent ? 0.4 : 0.25}
                />
              )}
              <text
                x={pos.x}
                y={pos.y + 1}
                className="fill-foreground"
                fontSize={10}
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                {truncate(node.label, 16)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>

      {cancelNode && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs",
            cancelNode.id === currentState
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-warning/40 bg-warning/5 text-muted-foreground",
          )}
        >
          <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-warning">cancel</span>
          <span>从任意非终态触发，转入</span>
          <span
            className={cn(
              "rounded border bg-card px-2 py-0.5 font-mono",
              cancelNode.id === currentState ? "border-primary text-primary" : "text-success",
            )}
          >
            {cancelNode.label}
          </span>
          {cancelNode.id === currentState && (
            <span className="ml-auto text-[10px] uppercase tracking-wide text-primary">当前状态</span>
          )}
        </div>
      )}
    </div>
  );
}

function pointsToPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  // dagre 给 spline 控制点：起点 + 中段 + 终点。用平滑曲线 (Catmull-Rom 风) 串起来。
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${xc} ${yc}`;
  }
  const last = points[points.length - 1];
  d += ` T ${last.x} ${last.y}`;
  return d;
}

function measureLabel(s: string): number {
  // SVG 文本无法精确测量，按 9px font 估算 ~6px/char，中文按 ~11px
  let w = 0;
  for (const ch of s) {
    w += /[\u4e00-\u9fff]/.test(ch) ? 11 : 6;
  }
  return Math.max(w, 16);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
