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
import { listRepos, getRepoByAlias, getRepoById } from "../core/repos";
import { startTaskFromTemplate } from "../core/task-factory";
import {
  listRequirements,
  getRequirementById,
  createRequirement,
  updateRequirement,
  setRequirementStatus,
  nextRequirementId,
} from "../core/requirements";
import { appendFeedback } from "../core/requirement-feedbacks";

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

    // ── 需求队列：仓库 ──
    tool(
      "list_repos",
      "列出 autopilot 已注册的仓库（alias / 路径 / 默认分支）。用户提需求前需要选哪个仓库。",
      {},
      async () => {
        return ok(
          listRepos().map((r) => ({
            alias: r.alias,
            id: r.id,
            path: r.path,
            default_branch: r.default_branch,
          })),
        );
      },
    ),

    // ── 需求队列：草稿 + 澄清 ──
    tool(
      "create_requirement_draft",
      "创建一个新需求草稿（关联到某仓库）。状态从 drafting 开始，后续多轮澄清调 update_requirement_spec 写入 spec_md。仓库需先在 /repos 注册并通过健康检查。",
      {
        repo_alias: z.string().describe("仓库 alias（来自 list_repos）"),
        title: z.string().describe("需求标题（简短）"),
        initial_text: z.string().optional().describe("可选：用户初始描述，写入 spec_md"),
      },
      async (args) => {
        const repo = getRepoByAlias(args.repo_alias);
        if (!repo) return err(`repo_alias 不存在：${args.repo_alias}（先在 /repos 注册）`);
        const id = nextRequirementId();
        try {
          const r = createRequirement({
            id,
            repo_id: repo.id,
            title: args.title.trim(),
            spec_md: args.initial_text ?? "",
          });
          return ok({ id: r.id, status: r.status, repo_alias: args.repo_alias });
        } catch (e: unknown) {
          return err((e as Error).message);
        }
      },
    ),

    tool(
      "update_requirement_spec",
      "更新需求规约 spec_md（覆盖写）。如果当前 status=drafting，自动转 clarifying（表示已经有初版规约）。澄清完成、用户明确确认 spec 完整后调 mark_requirement_ready。",
      {
        req_id: z.string().describe("需求 ID（来自 create_requirement_draft 或 list_requirements）"),
        spec_md: z.string().describe("完整 markdown 规约"),
      },
      async (args) => {
        const r = getRequirementById(args.req_id);
        if (!r) return err(`需求不存在：${args.req_id}`);
        updateRequirement(args.req_id, { spec_md: args.spec_md });
        if (r.status === "drafting") {
          try {
            setRequirementStatus(args.req_id, "clarifying");
          } catch (e: unknown) {
            // 状态转换失败不阻塞 spec 写入
          }
        }
        const after = getRequirementById(args.req_id);
        return ok({ id: args.req_id, status: after?.status });
      },
    ),

    tool(
      "mark_requirement_ready",
      "把需求标记为「已澄清，待入队」（status=ready）。仅在用户明确确认 spec 完整时调用。可从 drafting / clarifying 转入。",
      {
        req_id: z.string(),
      },
      async (args) => {
        try {
          const r = setRequirementStatus(args.req_id, "ready");
          return ok({ id: r.id, status: r.status });
        } catch (e: unknown) {
          return err((e as Error).message);
        }
      },
    ),

    // ── 需求队列：入队执行 ──
    tool(
      "enqueue_requirement",
      "把已 ready 的需求推入执行队列并立即创建 req_dev task 开始执行（P2 临时直接创建；P3 调度器接管后改为仅入队）。返回新 task_id，可在 /tasks 看进度。",
      {
        req_id: z.string(),
      },
      async (args) => {
        const r = getRequirementById(args.req_id);
        if (!r) return err(`需求不存在：${args.req_id}`);
        const repo = getRepoById(r.repo_id);
        if (!repo) return err(`requirement 关联的 repo 不存在：${r.repo_id}`);

        try {
          setRequirementStatus(args.req_id, "queued");
        } catch (e: unknown) {
          return err((e as Error).message);
        }

        let task;
        try {
          task = await startTaskFromTemplate({
            workflow: "req_dev",
            title: r.title,
            requirement: r.spec_md,
            repo_id: repo.id,
          });
        } catch (e: unknown) {
          try { setRequirementStatus(args.req_id, "ready"); } catch { /* ignore */ }
          return err(`创建 task 失败：${(e as Error).message}`);
        }

        updateRequirement(args.req_id, { task_id: task.id });
        try { setRequirementStatus(args.req_id, "running"); } catch { /* ignore */ }

        return ok({
          id: args.req_id,
          status: "running",
          task_id: task.id,
        });
      },
    ),

    // ── 需求队列：查询 ──
    tool(
      "list_requirements",
      "列出需求。可按 repo_alias 或 status 过滤。状态枚举：drafting / clarifying / ready / queued / running / awaiting_review / fix_revision / done / cancelled / failed。",
      {
        repo_alias: z.string().optional(),
        status: z.string().optional(),
      },
      async (args) => {
        let repoId: string | undefined;
        if (args.repo_alias) {
          const repo = getRepoByAlias(args.repo_alias);
          if (!repo) return err(`repo_alias 不存在：${args.repo_alias}`);
          repoId = repo.id;
        }
        const list = listRequirements({ repo_id: repoId, status: args.status });
        return ok(
          list.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            repo_id: r.repo_id,
            pr_url: r.pr_url,
            task_id: r.task_id,
          })),
        );
      },
    ),

    // ── 需求队列：反馈 ──
    tool(
      "inject_feedback",
      "为正在 awaiting_review 的需求注入反馈（如 PR review 意见）。P3 起会自动触发 fix_revision 阶段；P2 仅追加记录到 requirement_feedbacks 表，状态不变。",
      {
        req_id: z.string(),
        body: z.string().describe("反馈正文（用户希望对 PR 做哪些修改）"),
      },
      async (args) => {
        const r = getRequirementById(args.req_id);
        if (!r) return err(`需求不存在：${args.req_id}`);
        appendFeedback({
          requirement_id: args.req_id,
          source: "manual",
          body: args.body,
        });
        return ok({ id: args.req_id, feedback_added: true });
      },
    ),

    // ── 需求队列：取消 ──
    tool(
      "cancel_requirement",
      "取消需求（任意非终态 → cancelled）。已经 done / cancelled / failed 的需求无法再次取消。",
      {
        req_id: z.string(),
      },
      async (args) => {
        try {
          const r = setRequirementStatus(args.req_id, "cancelled");
          return ok({ id: r.id, status: r.status });
        } catch (e: unknown) {
          return err((e as Error).message);
        }
      },
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
  "list_repos",
  "create_requirement_draft",
  "update_requirement_spec",
  "mark_requirement_ready",
  "enqueue_requirement",
  "list_requirements",
  "inject_feedback",
  "cancel_requirement",
] as const;

// ──────────────────────────────────────────────
// 工作流内 agent 用的工具集（仅 ask_user）
//
// 跟 buildAutopilotTools 不同：那是 chat agent 用的，能 list/start/cancel；
// 工作流 agent 不该改 task 元数据，只暴露 ask_user 用于人机交互。
// ──────────────────────────────────────────────

export const WORKFLOW_TOOL_NAMES = ["ask_user"] as const;

export async function buildWorkflowAgentTools(): Promise<SdkMcpToolDefinition<any>[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const tool = sdk.tool;

  const { getTaskContext } = await import("../core/task-context");
  const { updateTask } = await import("../core/db");
  const { registerPending } = await import("./pending-questions");
  const { emit } = await import("../daemon/event-bus");

  return [
    tool(
      "ask_user",
      "向用户提问并等待人工回答。用户在 UI 看到问题并提交后 agent 收到答案继续。仅在确实需要人工决断（如二选一无法判断、敏感操作前确认）时使用，不要为了简单细节问。",
      {
        question: z.string().min(1).describe("要问的问题，清晰具体"),
        options: z
          .array(z.string())
          .min(2)
          .max(8)
          .optional()
          .describe("可选项（2-8 个）；用户在 UI 上以按钮选择。不传则纯文本回答"),
      },
      async (args) => {
        const ctx = getTaskContext();
        if (!ctx) return err("ask_user 必须在 phase 上下文中调用");
        const taskId = ctx.taskId;

        const askedAt = new Date().toISOString();
        const meta = {
          question: args.question,
          options: args.options ?? null,
          asked_at: askedAt,
          phase: ctx.phase,
        };

        try {
          updateTask(taskId, { pending_question: JSON.stringify(meta) });
        } catch {
          /* ignore — 即便 db 写失败也继续等 promise */
        }
        emit({ type: "task:asking", payload: { taskId, phase: ctx.phase, question: args.question } });

        const answer = await new Promise<string>((resolve, reject) => {
          registerPending(taskId, {
            resolve,
            reject,
            question: args.question,
            options: args.options ?? null,
            asked_at: askedAt,
            phase: ctx.phase,
          });
        });

        try {
          updateTask(taskId, { pending_question: "" });
        } catch {
          /* ignore */
        }
        emit({ type: "task:answered", payload: { taskId, phase: ctx.phase } });

        return ok({ answer });
      },
    ),
  ];
}
