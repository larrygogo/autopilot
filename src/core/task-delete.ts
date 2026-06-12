import { getTask, getSubTasks, deleteTaskRecords, listRootTasksByRequirementIds, type Task } from "./db";
import { listRequirements, deleteRequirement } from "./requirements";
import { getWorkflow } from "./registry";
import { deleteTaskRuntimeDir } from "./sandbox";
import { releaseLock } from "./infra";
import { forgetTaskRecoveryState } from "./watcher";
import { emit } from "./event-bus";
import { log } from "./logger";

export class DeleteTaskError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = "DeleteTaskError";
  }
}

function terminalStatesFor(task: Task): Set<string> {
  // failed 是 runner/watcher 普遍写入的执行失败终态，必须并入基础集（RERUN-04）：否则自定义
  // 工作流显式声明 terminal_states 漏掉 failed 时，删 failed 任务会被 cascadeDeleteTask 误拒。
  const set = new Set<string>(["done", "cancelled", "failed"]);
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
 * 对一组已收集好的 task（完整树）执行文件/锁/内存/DB 清理。
 * best-effort：单条文件/锁失败只 warn，不阻塞 DB 删除（宁可留孤儿文件也不留孤儿 DB 记录）。
 *
 * 调用方须保证：tree 已含全部子孙、已通过各自场景的前置校验（终态 / 强删）。
 * 必须在 SQL 事务之外调用 —— 内部有文件 IO。
 *
 * @param emitRootId emit task:deleted 时用于区分根/子（保持 cascadeDeleteTask 原语义）；
 *                   项目级强删无单一根，传 null。
 */
function purgeTaskTree(tree: Task[], emitRootId: string | null): string[] {
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

  deleteTaskRecords(ids);

  for (const id of ids) {
    emit({ type: "task:deleted", payload: { taskId: id, parentTaskId: emitRootId === id ? null : emitRootId } });
  }

  return ids;
}

/**
 * 彻底删除一个任务（及其所有子任务）：DB 记录、运行时目录（含 workspace/logs/manifest）、
 * 文件锁、watcher 内存态一并清理。
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

  return { deleted: purgeTaskTree(tree, taskId) };
}

/**
 * 强删某需求名下的全部任务树（含非终态）：跳过 cascadeDeleteTask 的终态校验，
 * best-effort 清理 runtime / 锁 / watcher / scheduler 引用。
 *
 * 是「删除一件工作」与「删除项目」级联清任务的共同底座：单需求删除直接调它，
 * 删项目对每个需求调一遍（见 forceDeleteTasksForProject）。
 *
 * 分层说明：
 *   - core 只负责删记录 + 清文件，不负责停 agent 子进程（core 不依赖 daemon）。
 *   - 「停运行中 agent」由 daemon 层在调用本函数前先对非终态根任务 cancelTaskAction 完成。
 *   - 必须在 SQL 事务之外调用（内部有文件 IO）。
 */
export function forceDeleteTasksForRequirement(requirementId: string): { deleted: string[] } {
  const roots = listRootTasksByRequirementIds([requirementId]);
  if (roots.length === 0) return { deleted: [] };

  const tree: Task[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const sub: Task[] = [];
    collectDescendants(root.id, sub);
    for (const t of sub) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        tree.push(t);
      }
    }
  }

  return { deleted: purgeTaskTree(tree, null) };
}

/**
 * 强删某项目下的全部任务树（含非终态）。专供「删除项目」级联清除。
 * 委托给 forceDeleteTasksForRequirement 逐需求清理 —— 不同需求的任务树不共享节点，
 * 无需跨需求去重；逐需求各 purge 一次（删项目低频，开销无所谓）。
 */
export function forceDeleteTasksForProject(projectId: string): { deleted: string[] } {
  const reqs = listRequirements({ project_id: projectId });
  const deleted: string[] = [];
  for (const r of reqs) {
    deleted.push(...forceDeleteTasksForRequirement(r.id).deleted);
  }
  return { deleted };
}

/**
 * 删除「一件工作」= 一个需求 + 其名下全部任务树（force，无终态校验）。
 * 这是「删除需求」与「删除任务」的**统一原语**：需求+任务=一件工作，删一个就连根删另一个，
 * 不留孤儿任务。Web「删除此工作」、CLI/REST 删需求都走这条路。
 *
 * 顺序：先 force purge 任务（事务外，含文件 IO）→ 再 deleteRequirement（自带事务）。
 * 必须先删任务再删需求 —— 任务经 requirement_id 关联，先删需求就回查不到任务了。
 *
 * 「停运行中 agent 子进程」由 daemon 层在调用本函数前先 cancelTaskAction 负责（core 不依赖 daemon）。
 * 必须在 SQL 事务之外调用。
 */
export function deleteRequirementWithTasks(requirementId: string): { deletedTasks: string[] } {
  const { deleted } = forceDeleteTasksForRequirement(requirementId);
  deleteRequirement(requirementId);
  return { deletedTasks: deleted };
}
