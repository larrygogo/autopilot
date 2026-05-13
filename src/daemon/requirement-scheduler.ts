import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements, setRequirementStatus, updateRequirement, getRequirementById } from "../core/requirements";
import { getCodebaseById } from "../core/codebases";
import { listSubmodules } from "../core/submodules";
import { listQuestionsByRequirement } from "../core/requirement-questions";
import { startTaskFromTemplate } from "../core/task-factory";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/**
 * 单组 tick：父 codebase + 所有关联子模块视为一个调度组。
 *
 * 算法（spec §4.3 组级扩展）：
 *   - groupId = codebase.parent_codebase_id ?? codebase.id（即便传子模块 id 也归一化到父）
 *   - groupCodebaseIds = [groupId, ...listSubmodules(groupId).map(r => r.id)]
 *   - active = listRequirements({}) 中 codebase_id ∈ groupCodebaseIds 且 status ∈ {running, fix_revision}
 *   - 若 active 非空：do nothing
 *   - 否则取主仓库（父 groupId）上最老 queued requirement → startTaskFromTemplate
 *   - 子模块上的 queued（极端情况，正常 chat 流程不会发生）忽略
 *
 * 失败时回滚 status: queued → ready
 */
export async function tickRepo(codebaseId: string): Promise<void> {
  const codebase = getCodebaseById(codebaseId);
  if (!codebase) {
    log.error("tickRepo: codebase %s 不存在", codebaseId);
    return;
  }
  const groupId = codebase.parent_codebase_id ?? codebase.id;
  const submodules = listSubmodules(groupId);
  const groupCodebaseIds = new Set<string>([groupId, ...submodules.map((r) => r.id)]);

  // active 检测扩到整组
  const all = listRequirements({});
  const active = all.filter(
    (r) =>
      r.codebase_id !== null &&
      groupCodebaseIds.has(r.codebase_id) &&
      (r.status === "running" || r.status === "fix_revision"),
  );
  if (active.length > 0) return;

  // candidate 仅从主仓库拉（用户在 chat 提需求只会选父）
  const queued = all
    .filter((r) => r.codebase_id === groupId && r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  if (!candidate.codebase_id) {
    log.error("tickRepo: candidate %s 缺 codebase_id（不应发生）", candidate.id);
    return;
  }
  const candidateCodebase = getCodebaseById(candidate.codebase_id);
  if (!candidateCodebase) {
    log.error("tickRepo: candidate codebase %s 不存在", candidate.codebase_id);
    return;
  }

  // 将已解决的澄清问答拼入 requirement，让 Agent 知晓用户的补充说明
  const questions = listQuestionsByRequirement(candidate.id).filter(q => q.status === "resolved");
  let requirement = candidate.spec_md ?? "";
  if (questions.length > 0) {
    const qa = questions.map((q, i) => {
      const userReply = (q.replies ?? []).find(r => r.author_role === "user")?.text ?? "(未回复)";
      return `**问题 ${i + 1}：** ${q.agent_text}\n**回答：** ${userReply}`;
    }).join("\n\n");
    requirement = requirement
      ? `${requirement}\n\n## 需求澄清记录\n\n${qa}`
      : `## 需求澄清记录\n\n${qa}`;
  }

  let task;
  try {
    task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: candidate.title,
      requirement,
      // setup_func 仍按 repo_id 命名传参（runtime 透传字段，保持兼容）
      repo_id: candidateCodebase.id,
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
      "tickRepo: 启动 requirement %s → task %s on codebase %s (group=%s, submodules=%d)",
      candidate.id,
      task.id,
      candidateCodebase.alias,
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
    if (!req.codebase_id) {
      // 高层需求（无 codebase 绑定）不参与调度组逻辑
      return;
    }

    try {
      await tickRepo(req.codebase_id);
    } catch (e: unknown) {
      log.error("requirement-scheduler: tickRepo 异常 codebase=%s: %s", req.codebase_id, (e as Error).message);
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
