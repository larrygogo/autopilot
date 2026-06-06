import { getTask, createTask } from "./db";
import type { Task } from "./db";
import { discover, getWorkflow, listWorkflows, isParallelPhase } from "./registry";
import { snapshotWorkflow } from "./manifest";
import { ensureTaskSandbox, getTaskSandbox, getTaskWorktreeMeta, type WorkspaceRef } from "./sandbox";
import { getWorkspaceById } from "./workspaces";
import { executePhase } from "./runner";

// ──────────────────────────────────────────────
// Task ID 生成（避开易混字符与数字 4）
// ──────────────────────────────────────────────

const TASK_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23567";

function genTaskId(len = 8): string {
  let id = "";
  for (let i = 0; i < len; i++) {
    id += TASK_ID_ALPHABET[Math.floor(Math.random() * TASK_ID_ALPHABET.length)];
  }
  return id;
}

export function generateUniqueTaskId(): string {
  for (let i = 0; i < 10; i++) {
    const id = genTaskId();
    if (!getTask(id)) return id;
  }
  throw new Error("无法生成唯一 task ID（重试 10 次仍冲突）");
}

// ──────────────────────────────────────────────
// 任务启动（routes POST /api/tasks 与 scheduler tick 共用）
// ──────────────────────────────────────────────

export interface StartTaskOpts {
  workflow?: string;
  title?: string;
  requirement?: string;
  /** 任务必须挂在一个需求下（FK link）。正规路径（scheduler / routes）显式传。 */
  requirement_id?: string;
  /** 兼容老接口：可选传入 reqId（既当 task id 种子，也兜底当 FK link） */
  reqId?: string;
  /** 额外工作流参数（如 workspace_id），转发给 setup_func */
  [key: string]: unknown;
}

export class StartTaskError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = "StartTaskError";
  }
}

export async function startTaskFromTemplate(opts: StartTaskOpts): Promise<Task> {
  await discover();
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    throw new StartTaskError("No workflows found", 500);
  }

  let workflowName: string;
  if (opts.workflow) {
    workflowName = opts.workflow;
  } else if (workflows.length === 1) {
    workflowName = workflows[0].name;
  } else {
    throw new StartTaskError(
      `Multiple workflows found, specify one: ${workflows.map((w) => w.name).join(", ")}`
    );
  }

  const wf = getWorkflow(workflowName);
  if (!wf) throw new StartTaskError(`Workflow "${workflowName}" not found`);

  // FK link 来源：requirement_id 优先（scheduler 传的 key），兜底 reqId。
  // 注意 reqId 还兼任 "task id 种子"（下方 line），两个语义别搞混：
  //   - id 种子：仍用 reqId
  //   - FK link：requirement_id ?? reqId
  const reqLink = (opts.requirement_id as string | undefined) ?? opts.reqId;
  if (!reqLink) {
    throw new StartTaskError("任务必须挂在一个需求下（缺 requirement_id）", 400);
  }

  let taskId: string;
  if (opts.reqId) {
    taskId = opts.reqId.slice(0, 8);
    if (getTask(taskId)) throw new StartTaskError(`Task ID 已存在：${taskId}`, 409);
  } else {
    taskId = generateUniqueTaskId();
  }

  const title = opts.title?.trim() || taskId;
  const requirement = opts.requirement?.trim();

  let extra: Record<string, unknown> = {};
  if (typeof wf.setup_func === "function") {
    try {
      // 构建 setup_func 的参数：合并标准字段 + 额外工作流参数
      const setupArgs: Record<string, unknown> = {
        reqId: opts.reqId ?? taskId,
        title,
        taskId,
        requirement,
      };
      // 添加所有额外参数（如 workspace_id）
      for (const [key, value] of Object.entries(opts)) {
        if (!["workflow", "title", "requirement", "reqId"].includes(key)) {
          setupArgs[key] = value;
        }
      }
      extra = wf.setup_func(setupArgs) ?? {};
    } catch (e: unknown) {
      throw new StartTaskError(
        `setup_func failed: ${e instanceof Error ? e.message : String(e)}`,
        500
      );
    }
  }
  if (extra["requirement"] === undefined) {
    extra["requirement"] = requirement ?? "";
  }

  // sandbox.git=true 时反查 workspace 起 git worktree。必须在 createTask 之前，
  // 这样能把 worktree 的真实路径/分支注入 extra（写进 manifest），供 run 阶段使用。
  let workspace: WorkspaceRef | undefined;
  if (wf.sandbox?.git) {
    // 直接从原始入参 opts 读（scheduler / routes 传的真值）。setup_func 返回的 extra
    // 不一定回传 workspace_id，不能依赖它（这是 worktree 之前从未建成的根因）。
    // 仍兜底看 extra，兼容显式回传 workspace_id/codebase_id 的工作流。
    const workspaceId =
      (typeof opts.workspace_id === "string" ? opts.workspace_id : undefined) ??
      (typeof opts.codebase_id === "string" ? opts.codebase_id : undefined) ??
      (typeof extra["workspace_id"] === "string" ? extra["workspace_id"] : undefined) ??
      (typeof extra["codebase_id"] === "string" ? extra["codebase_id"] : undefined);
    if (workspaceId) {
      const ws = getWorkspaceById(workspaceId);
      if (ws) {
        workspace = { id: ws.id, path: ws.path, default_branch: ws.default_branch };
      }
    }
  }
  try {
    ensureTaskSandbox(taskId, workflowName, wf.sandbox, workspace);
  } catch (e: unknown) {
    console.warn("ensureTaskSandbox 失败：", e instanceof Error ? e.message : e);
  }

  // 框架标准字段注入：worktree 建成功时，把隔离 worktree 的物理路径/分支/base 写进
  // extra，覆盖 setup_func 可能返回的占位值（如 dev 模板旧的 config.repo_path）。
  // workspace→物理路径解析是通用基础设施（注入的是路径事实，非工作流业务概念），
  // 不违反"核心零业务知识"红线。run 阶段统一在这个隔离 worktree 里跑 git。
  const worktreeMeta = getTaskWorktreeMeta(taskId);
  if (worktreeMeta) {
    extra["repo_path"] = getTaskSandbox(taskId);
    extra["default_branch"] = worktreeMeta.base;
    extra["branch"] = worktreeMeta.branch;
    extra["workspace_path"] = worktreeMeta.workspace_path;
  }

  const firstPhaseEntry = wf.phases[0];
  if (!firstPhaseEntry) throw new StartTaskError("Workflow has no phases", 500);
  const firstPhaseName = isParallelPhase(firstPhaseEntry)
    ? firstPhaseEntry.parallel.name
    : firstPhaseEntry.name;

  createTask({
    id: taskId,
    title,
    workflow: workflowName,
    initialStatus: wf.initial_state,
    extra,
    // 双向关联：requirement.task_id 由 requirement-scheduler 写；task.requirement_id 在此写。
    // reqLink 上面已强制非空（任务必有需求）。
    requirementId: reqLink,
    workflowSnapshot: snapshotWorkflow(wf),
  });

  executePhase(taskId, firstPhaseName).catch(() => {});

  const task = getTask(taskId);
  if (!task) throw new StartTaskError("任务创建后读取失败", 500);
  return task;
}
