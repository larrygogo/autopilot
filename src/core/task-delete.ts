import { getTask, getSubTasks, deleteTaskRecords, type Task } from "./db";
import { getWorkflow } from "./registry";
import { deleteTaskRuntimeDir } from "./workspace";
import { releaseLock } from "./infra";
import { forgetTaskRecoveryState } from "./watcher";
import { clearScheduleTaskRefs } from "./schedules";
import { emit } from "../daemon/event-bus";
import { log } from "./logger";

export class DeleteTaskError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = "DeleteTaskError";
  }
}

function terminalStatesFor(task: Task): Set<string> {
  const set = new Set<string>(["done", "cancelled"]);
  const wf = getWorkflow(task.workflow);
  for (const s of wf?.terminal_states ?? []) set.add(s);
  return set;
}

/** 收集 task 及其所有后代（DFS）；保证顺序先孩子后父亲也无所谓，DB 删除用 IN 一次性处理。 */
function collectDescendants(rootId: string, out: Task[]): void {
  const root = getTask(rootId);
  if (!root) return;
  out.push(root);
  for (const child of getSubTasks(rootId)) {
    collectDescendants(child.id, out);
  }
}

/**
 * 彻底删除一个任务（及其所有子任务）：DB 记录、运行时目录（含 workspace/logs/manifest）、
 * 文件锁、watcher 内存态一并清理；schedules.last_task_id 置 NULL。
 *
 * 前置约束：
 *   - 只能从"根任务"调用（有父任务的子任务必须随父任务一起删）
 *   - 任务树上的**所有**节点都必须处于终态
 */
export function cascadeDeleteTask(taskId: string): { deleted: string[] } {
  const root = getTask(taskId);
  if (!root) throw new DeleteTaskError("任务不存在", 404);
  if (root.parent_task_id) {
    throw new DeleteTaskError("无法单独删除子任务；请删除父任务", 400);
  }

  const tree: Task[] = [];
  collectDescendants(taskId, tree);

  const terminals = terminalStatesFor(root);
  for (const t of tree) {
    if (!terminals.has(t.status)) {
      throw new DeleteTaskError(
        `任务 ${t.id} 非终态（status=${t.status}），无法删除；请先取消或等其跑完`,
        409
      );
    }
  }

  const ids = tree.map((t) => t.id);

  // 文件/锁/内存清理（best-effort，单条失败不阻塞 DB 删除 —— 宁可留孤儿文件也不留孤儿 DB 记录）
  for (const id of ids) {
    try {
      releaseLock(id);
    } catch (e: unknown) {
      log.warn("删除任务时释放锁失败 [task=%s]：%s", id, e instanceof Error ? e.message : String(e));
    }
    forgetTaskRecoveryState(id);
    try {
      deleteTaskRuntimeDir(id);
    } catch (e: unknown) {
      log.warn(
        "删除任务时清理 runtime 目录失败 [task=%s]：%s",
        id,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  clearScheduleTaskRefs(ids);
  deleteTaskRecords(ids);

  for (const id of ids) {
    emit({ type: "task:deleted", payload: { taskId: id, parentTaskId: taskId === id ? null : taskId } });
  }

  return { deleted: ids };
}
