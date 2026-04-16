import React from "react";

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
}

const NODE_COLORS: Record<string, { fill: string; stroke: string }> = {
  initial: { fill: "#1e2030", stroke: "#6366f1" },
  pending: { fill: "#1e2030", stroke: "#60a5fa" },
  running: { fill: "#1e2030", stroke: "#fbbf24" },
  terminal: { fill: "#1e2030", stroke: "#34d399" },
  other: { fill: "#1e2030", stroke: "#636882" },
};

export function StateMachineGraph({ nodes, edges, currentState }: Props) {
  if (nodes.length === 0) return null;

  // 简单布局：按类型分层
  const layers: Record<string, GraphNode[]> = { initial: [], pending: [], running: [], terminal: [], other: [] };
  for (const node of nodes) {
    (layers[node.type] ?? layers.other).push(node);
  }

  const layerOrder = ["initial", "pending", "running", "other", "terminal"];
  const positions = new Map<string, { x: number; y: number }>();
  let y = 60;

  for (const layer of layerOrder) {
    const layerNodes = layers[layer] ?? [];
    if (layerNodes.length === 0) continue;
    const startX = (800 - layerNodes.length * 180) / 2;
    for (let i = 0; i < layerNodes.length; i++) {
      positions.set(layerNodes[i].id, { x: startX + i * 180 + 80, y });
    }
    y += 100;
  }

  const height = y + 20;

  return (
    <svg width="800" height={height} style={{ fontFamily: "monospace" }}>
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#636882" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return null;

        // 缩短到节点边缘
        const r = 30;
        const x1 = from.x + (dx / len) * r;
        const y1 = from.y + (dy / len) * r;
        const x2 = to.x - (dx / len) * r;
        const y2 = to.y - (dy / len) * r;

        return (
          <g key={i}>
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#636882" strokeWidth={1.5}
              markerEnd="url(#arrowhead)"
            />
            <text
              x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}
              fill="#636882" fontSize={9} textAnchor="middle"
            >
              {edge.trigger}
            </text>
          </g>
        );
      })}

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const colors = NODE_COLORS[node.type] ?? NODE_COLORS.other;
        const isCurrent = node.id === currentState;

        return (
          <g key={node.id}>
            <circle
              cx={pos.x} cy={pos.y} r={28}
              fill={colors.fill}
              stroke={isCurrent ? "#22d3ee" : colors.stroke}
              strokeWidth={isCurrent ? 3 : 1.5}
            />
            {isCurrent && (
              <circle
                cx={pos.x} cy={pos.y} r={32}
                fill="none"
                stroke="#22d3ee"
                strokeWidth={1}
                opacity={0.3}
              />
            )}
            <text
              x={pos.x} y={pos.y + 3}
              fill="#e2e4ea" fontSize={8} textAnchor="middle"
              dominantBaseline="middle"
            >
              {node.label.length > 16 ? node.label.slice(0, 15) + "…" : node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
