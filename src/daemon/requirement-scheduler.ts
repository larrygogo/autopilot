import { onEvent, offEvent } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements, setRequirementStatus, updateRequirement, getRequirementById } from "../core/requirements";
import { getRepoById } from "../core/repos";
import { listSubmodules } from "../core/submodules";
import { startTaskFromTemplate } from "../core/task-factory";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/**
 * 单组 tick：父 repo + 所有关联子模块视为一个调度组。
 *
 * 算法（spec §4.3 组级扩展）：
 *   - groupId = repo.parent_repo_id ?? repo.id（即便传子模块 id 也归一化到父）
 *   - groupRepoIds = [groupId, ...listSubmodules(groupId).map(r => r.id)]
 *   - active = listRequirements({}) 中 repo_id ∈ groupRepoIds 且 status ∈ {running, fix_revision}
 *   - 若 active 非空：do nothing
 *   - 否则取主仓库（父 groupId）上最老 queued requirement → startTaskFromTemplate
 *   - 子模块上的 queued（极端情况，正常 chat 流程不会发生）忽略
 *
 * 失败时回滚 status: queued → ready
 */
export async function tickRepo(repoId: string): Promise<void> {
  const repo = getRepoById(repoId);
  if (!repo) {
    log.error("tickRepo: repo %s 不存在", repoId);
    return;
  }
  const groupId = repo.parent_repo_id ?? repo.id;
  const submodules = listSubmodules(groupId);
  const groupRepoIds = new Set<string>([groupId, ...submodules.map((r) => r.id)]);

  // active 检测扩到整组
  const all = listRequirements({});
  const active = all.filter(
    (r) => groupRepoIds.has(r.repo_id) && (r.status === "running" || r.status === "fix_revision"),
  );
  if (active.length > 0) return;

  // candidate 仅从主仓库拉（用户在 chat 提需求只会选父）
  const queued = all
    .filter((r) => r.repo_id === groupId && r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  const candidateRepo = getRepoById(candidate.repo_id);
  if (!candidateRepo) {
    log.error("tickRepo: candidate repo %s 不存在", candidate.repo_id);
    return;
  }

  let task;
  try {
    task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: candidate.title,
      requirement: candidate.spec_md,
      repo_id: candidateRepo.id,
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
    log.info(
      "tickRepo: 启动 requirement %s → task %s on repo %s (group=%s, submodules=%d)",
      candidate.id,
      task.id,
      candidateRepo.alias,
      groupId,
      submodules.length,
    );
  } catch (e: unknown) {
    log.error("tickRepo: 写回 task_id 或 setStatus running 失败 %s: %s", candidate.id, (e as Error).message);
  }
}

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
