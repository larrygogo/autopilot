import { onEvent, offEvent } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements, setRequirementStatus, updateRequirement, getRequirementById } from "../core/requirements";
import { getRepoById } from "../core/repos";
import { startTaskFromTemplate } from "../core/task-factory";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/**
 * 单仓库 tick：检查该 repo 的活跃任务，若无则拉最老的 queued 创建 task。
 *
 * 算法（spec §6）：
 *   - active = listRequirements({ repo_id }).filter(s ∈ {running, fix_revision})
 *   - 若 active 非空：do nothing
 *   - 否则取最老 queued requirement，调 startTaskFromTemplate({ workflow:"req_dev", ..., requirement_id })
 *   - 写回 task_id；setRequirementStatus(id, "running")
 *
 * 失败时回滚 status: queued → ready（状态表已支持该转换）
 */
export async function tickRepo(repoId: string): Promise<void> {
  const all = listRequirements({ repo_id: repoId });
  const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
  if (active.length > 0) return;

  const queued = all
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  const repo = getRepoById(candidate.repo_id);
  if (!repo) {
    log.error("tickRepo: repo %s 不存在，跳过 candidate %s", candidate.repo_id, candidate.id);
    return;
  }

  let task;
  try {
    task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: candidate.title,
      requirement: candidate.spec_md,
      repo_id: repo.id,
      requirement_id: candidate.id,
    });
  } catch (e: unknown) {
    log.error("tickRepo: 创建 task 失败 candidate=%s: %s", candidate.id, (e as Error).message);
    try {
      setRequirementStatus(candidate.id, "ready");
    } catch (rollbackErr: unknown) {
      log.error("tickRepo: 回滚 status 失败 %s: %s", candidate.id, (rollbackErr as Error).message);
    }
    return;
  }

  try {
    updateRequirement(candidate.id, { task_id: task.id });
    setRequirementStatus(candidate.id, "running");
    log.info("tickRepo: 启动 requirement %s → task %s on repo %s", candidate.id, task.id, repo.alias);
  } catch (e: unknown) {
    log.error("tickRepo: 写回 task_id 或 setStatus running 失败 %s: %s", candidate.id, (e as Error).message);
    // 不回滚（task 已创建运行）
  }
}

/**
 * 启动调度器：订阅 event-bus 上的 requirement:status-changed 事件。
 *
 * 触发条件：
 *   - to=queued（新需求入队）
 *   - from ∈ {running, fix_revision} 且 to ∈ {awaiting_review, done, cancelled, failed}（活跃任务释放槽位）
 */
export function initRequirementScheduler(): void {
  if (_handler) return;

  const handler = async (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, from, to } = event.payload;

    const enqueued = to === "queued";
    const releasingSlot =
      (from === "running" || from === "fix_revision") &&
      ["awaiting_review", "done", "cancelled", "failed"].includes(to);

    if (!enqueued && !releasingSlot) return;

    const req = getRequirementById(id);
    if (!req) return;

    try {
      await tickRepo(req.repo_id);
    } catch (e: unknown) {
      log.error("requirement-scheduler: tickRepo 异常 repo=%s: %s", req.repo_id, (e as Error).message);
    }
  };

  onEvent("requirement:status-changed", handler);
  _handler = handler;

  log.info("requirement-scheduler 已启动（订阅 requirement:status-changed）");
}

export function disposeRequirementScheduler(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
