/**
 * Workflow 视图 helper — 从 registry/state-machine 派生出 API 友好的形状。
 * 抽自 routes.ts 的 inline handler，让 HTTP routes 和 WS RPC 共用。
 *
 * 全部纯函数 + 抛 TaskActionError 风格错误（其实是 WorkflowViewError，
 * 这里复用相同模式）。错误透传由 transport 层负责。
 */

import { getWorkflow as registryGetWorkflow, buildTransitions, getTerminalStates } from "../core/registry";
import { getWorkflowFromDb } from "../core/workflows";
import type { GraphData, GraphNode, GraphEdge } from "./protocol";

export class WorkflowViewError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 404) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "WorkflowViewError";
  }
}

/**
 * 返回 API 友好的 workflow 视图（剥 func / setup_func / notify_func + 加 source / derives_from）。
 * 不存在抛 NOT_FOUND。
 */
export function getWorkflowView(name: string): Record<string, unknown> {
  const wf = registryGetWorkflow(name);
  if (!wf) throw new WorkflowViewError("NOT_FOUND", "Workflow not found");

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { setup_func, notify_func, ...safe } = wf;
  const safePhasesArr = safe.phases.map((p: unknown) => {
    if (p && typeof p === "object" && "parallel" in p) {
      const obj = p as { parallel: { phases: unknown[]; [k: string]: unknown } };
      return {
        parallel: {
          ...obj.parallel,
          phases: obj.parallel.phases.map((sub: unknown) => {
            if (sub && typeof sub === "object") {
              const { func: _f, ...rest } = sub as { func?: unknown; [k: string]: unknown };
              return rest;
            }
            return sub;
          }),
        },
      };
    }
    if (p && typeof p === "object") {
      const { func: _f, ...rest } = p as { func?: unknown; [k: string]: unknown };
      return rest;
    }
    return p;
  });
  const row = getWorkflowFromDb(name);
  return {
    ...safe,
    phases: safePhasesArr,
    source: row?.source ?? "file",
    derives_from: row?.derives_from ?? null,
  };
}

/**
 * 从 workflow transition 表构造图数据，供前端可视化。
 * 不存在抛 NOT_FOUND。
 */
export function computeWorkflowGraph(name: string): GraphData {
  const wf = registryGetWorkflow(name);
  if (!wf) throw new WorkflowViewError("NOT_FOUND", "Workflow not found");

  const transitions = buildTransitions(wf);
  const terminalStates = getTerminalStates(name);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const classify = (s: string): GraphNode["type"] => {
    if (s.startsWith("running_")) return "running";
    if (s.startsWith("pending_")) return "pending";
    if (terminalStates.includes(s)) return "terminal";
    return "other";
  };

  nodes.set(wf.initial_state, { id: wf.initial_state, label: wf.initial_state, type: "initial" });

  for (const [fromState, trans] of Object.entries(transitions)) {
    if (!nodes.has(fromState)) {
      nodes.set(fromState, { id: fromState, label: fromState, type: classify(fromState) });
    }
    for (const [trigger, toState] of trans) {
      if (!nodes.has(toState)) {
        nodes.set(toState, { id: toState, label: toState, type: classify(toState) });
      }
      edges.push({ from: fromState, to: toState, trigger });
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    initialState: wf.initial_state,
    terminalStates,
  };
}
