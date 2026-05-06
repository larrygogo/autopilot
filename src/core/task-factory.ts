import { getTask, createTask } from "./db";
import type { Task } from "./db";
import { discover, getWorkflow, listWorkflows, isParallelPhase } from "./registry";
import { snapshotWorkflow } from "./manifest";
import { ensureTaskWorkspace } from "./workspace";
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
  /** 兼容老接口：可选传入 reqId，不传则生成 */
  reqId?: string;
  /** 额外工作流参数（如 repo_id），转发给 setup_func */
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
      // 添加所有额外参数（如 repo_id）
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
  if (requirement && extra["requirement"] === undefined) {
    extra["requirement"] = requirement;
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
    workflowSnapshot: snapshotWorkflow(wf),
  });

  try {
    ensureTaskWorkspace(taskId, workflowName, wf.workspace);
  } catch (e: unknown) {
    console.warn("ensureTaskWorkspace 失败：", e instanceof Error ? e.message : e);
  }

  executePhase(taskId, firstPhaseName).catch(() => {});

  const task = getTask(taskId);
  if (!task) throw new StartTaskError("任务创建后读取失败", 500);
  return task;
}
