// ──────────────────────────────────────────────
// Autopilot 对话工具集
//
// 给 chat agent 暴露的"能做 autopilot 事情"的工具。第一版只实现最稳的：
//   只读：list/get tasks、workflows、sessions、daemon status
//   写：  start_task、cancel_task（可回滚、最常用）
//
// 更危险的（create_workflow / update_config / restart_daemon / delete）
// 留到后续 PR，需要先设计"确认"机制。
//
// SDK 约定：tool handler 返回 { content: [{ type: 'text', text }] }。
// ──────────────────────────────────────────────

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listTasks, getTask, getTaskLogs } from "../core/db";
import { listWorkflows, getWorkflow, isParallelPhase } from "../core/registry";
import { listSessions, readManifest as readSessionManifest } from "../core/sessions";
import { VERSION } from "../index";
import { transition, canTransition } from "../core/state-machine";
import { buildTransitions } from "../core/registry";
import { ensureTaskWorkspace } from "../core/workspace";
import { createTask } from "../core/db";
import { snapshotWorkflow } from "../core/manifest";
import { executePhase } from "../core/runner";
import { randomUUID } from "crypto";
import { log } from "../core/logger";

type ToolContent = { content: Array<{ type: "text"; text: string }> };

function ok(data: unknown): ToolContent {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function err(msg: string): ToolContent {
  return { content: [{ type: "text", text: `错误：${msg}` }] };
}

/**
 * 构造全部 autopilot tools。用 dynamic import 的 SDK.tool() 包装，
 * 避免 SDK 缺失时影响 autopilot 主干。
 */
export async function buildAutopilotTools(): Promise<SdkMcpToolDefinition<any>[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const tool = sdk.tool;

  return [
    // ── 只读：任务 ──
    tool(
      "list_tasks",
      "列出 autopilot 任务。可选按 status / workflow 过滤，默认返回最近 50 个。",
      {
        status: z.string().optional().describe("按状态过滤（如 done / cancelled / running_plan）"),
        workflow: z.string().optional().describe("按工作流名过滤"),
        limit: z.number().int().positive().optional().describe("返回条数，默认 50"),
      },
      async (args) => {
        try {
          const tasks = listTasks({
            status: args.status,
            workflow: args.workflow,
            limit: args.limit ?? 50,
          });
          return ok(tasks.map((t) => ({
            id: t.id,
            title: t.title,
            workflow: t.workflow,
            status: t.status,
            failure_count: t.failure_count,
            created_at: t.created_at,
            updated_at: t.updated_at,
          })));
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    tool(
      "get_task",
      "查看单个任务的完整信息（含 extra 字段、时间戳）。",
      { id: z.string().describe("任务 id") },
      async (args) => {
        try {
          const t = getTask(args.id);
          if (!t) return err(`任务不存在：${args.id}`);
          return ok(t);
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    tool(
      "get_task_logs",
      "查看任务的状态转换历史（最近 N 条）。",
      {
        id: z.string().describe("任务 id"),
        limit: z.number().int().positive().optional().describe("条数，默认 50"),
      },
      async (args) => {
        try {
          const rows = getTaskLogs(args.id, args.limit ?? 50);
          return ok(rows);
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    // ── 只读：工作流 ──
    tool(
      "list_workflows",
      "列出已注册的工作流（name + description）。",
      {},
      async () => {
        try {
          return ok(listWorkflows());
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    tool(
      "get_workflow",
      "查看工作流结构（阶段列表、初始/终态、chat_agent）。",
      { name: z.string().describe("工作流名") },
      async (args) => {
        try {
          const wf = getWorkflow(args.name);
          if (!wf) return err(`工作流不存在：${args.name}`);
          const phases = wf.phases.map((p) => {
            if (isParallelPhase(p)) {
              return {
                parallel: p.parallel.name,
                fail_strategy: p.parallel.fail_strategy,
                subs: p.parallel.phases.map((s) => s.name),
              };
            }
            return { name: p.name, label: p.label, timeout: p.timeout, agent: p.agent };
          });
          return ok({
            name: wf.name,
            description: wf.description,
            initial_state: wf.initial_state,
            terminal_states: wf.terminal_states,
            chat_agent: wf.chat_agent,
            phases,
          });
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    // ── 只读：会话 ──
    tool(
      "list_sessions",
      "列出所有对话 session（含自己这个）。",
      {},
      async () => {
        try {
          return ok(listSessions().map((s) => ({
            id: s.id,
            title: s.title,
            agent: s.agent,
            workflow: s.workflow,
            message_count: s.message_count,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })));
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    tool(
      "get_session",
      "查看 session 的元数据。",
      { id: z.string().describe("session id") },
      async (args) => {
        try {
          const m = readSessionManifest(args.id);
          if (!m) return err(`session 不存在：${args.id}`);
          return ok(m);
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    // ── 只读：daemon ──
    tool(
      "get_daemon_status",
      "查看 daemon 版本、运行时间、任务计数。",
      {},
      async () => {
        try {
          const allTasks = listTasks({ limit: 1000 });
          const counts: Record<string, number> = {};
          for (const t of allTasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
          return ok({
            version: VERSION,
            pid: process.pid,
            uptime_s: Math.floor(process.uptime()),
            task_counts: counts,
          });
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    // ── 写：任务生命周期（可回滚） ──
    tool(
      "start_task",
      "启动一个新的 autopilot 任务。需要 reqId 和 workflow（若省略 workflow，要求系统只有一个工作流）。",
      {
        reqId: z.string().describe("需求 id，作为任务的前缀标识"),
        workflow: z.string().optional().describe("工作流名；省略时系统自动选择（仅有一个工作流时）"),
        title: z.string().optional().describe("任务标题，默认 reqId"),
      },
      async (args) => {
        try {
          const workflows = listWorkflows();
          let workflowName = args.workflow;
          if (!workflowName) {
            if (workflows.length !== 1) {
              return err(`系统有 ${workflows.length} 个工作流，请显式指定 workflow 参数（可选：${workflows.map((w) => w.name).join(", ")}）`);
            }
            workflowName = workflows[0]!.name;
          }
          const wf = getWorkflow(workflowName);
          if (!wf) return err(`工作流不存在：${workflowName}`);
          const firstPhaseEntry = wf.phases[0];
          if (!firstPhaseEntry) return err("工作流没有阶段");
          const firstPhaseName = isParallelPhase(firstPhaseEntry)
            ? firstPhaseEntry.parallel.name
            : firstPhaseEntry.name;

          const taskId = args.reqId.slice(0, 8);
          const title = args.title ?? args.reqId;

          let extra: Record<string, unknown> = {};
          if (typeof wf.setup_func === "function") {
            try {
              extra = wf.setup_func({ reqId: args.reqId, title, taskId }) ?? {};
            } catch (e: unknown) {
              return err(`setup_func 失败：${e instanceof Error ? e.message : String(e)}`);
            }
          }

          createTask({
            id: taskId,
            title,
            workflow: workflowName,
            initialStatus: wf.initial_state,
            extra,
            workflowSnapshot: snapshotWorkflow(wf),
          });
          try {
            ensureTaskWorkspace(taskId, workflowName, wf.workspace);
          } catch (e: unknown) {
            log.warn("start_task: ensureTaskWorkspace 失败 [task=%s]: %s",
              taskId, e instanceof Error ? e.message : String(e));
          }
          // 异步执行第一阶段
          executePhase(taskId, firstPhaseName).catch(() => {});

          const created = getTask(taskId);
          return ok({
            id: taskId,
            workflow: workflowName,
            status: created?.status,
            message: "任务已创建并启动",
          });
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),

    tool(
      "cancel_task",
      "取消一个 autopilot 任务（转入 cancelled 状态）。仅在任务未处于终态时有效。",
      {
        id: z.string().describe("任务 id"),
        note: z.string().optional().describe("取消原因，会记录到日志"),
      },
      async (args) => {
        try {
          const t = getTask(args.id);
          if (!t) return err(`任务不存在：${args.id}`);
          const wf = getWorkflow(t.workflow);
          if (!wf) return err(`工作流已不存在：${t.workflow}`);
          const transitions = buildTransitions(wf);
          if (!canTransition(args.id, "cancel", { transitions })) {
            return err(`任务当前状态 "${t.status}" 不能触发 cancel`);
          }
          const [from, to] = transition(args.id, "cancel", {
            transitions,
            note: args.note ?? "cancelled via chat",
          });
          return ok({ id: args.id, from, to, message: "任务已取消" });
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
    ),
  ];
}

export const TOOL_NAMES = [
  "list_tasks",
  "get_task",
  "get_task_logs",
  "list_workflows",
  "get_workflow",
  "list_sessions",
  "get_session",
  "get_daemon_status",
  "start_task",
  "cancel_task",
] as const;
