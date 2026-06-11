import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements, setRequirementStatus, updateRequirement, getRequirementById } from "../core/requirements";
import { getWorkspaceById } from "../core/workspaces";
import { listSubmodules } from "../core/submodules";
import { listComments } from "../core/requirement-comments";
import { getTask } from "../core/db";
import { startTaskFromTemplate, resetTaskForRerun } from "../core/task-factory";
import { createLogger } from "../core/logger";
import { loadSchedulerConfig } from "../core/config";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/** 同组串行锁：防并发 tickRepo（同组两个事件）双双越过 active 检测各起一个 task（SC-3 TOCTOU）。 */
const _inflightGroups = new Set<string>();

/**
 * 全局调度互斥锁：防止跨组并发 tick 出现 TOCTOU。
 *
 * 原理（JS 单线程保证）：
 *   此变量在首个 await 前同步赋值，不会被其他协程打断。
 *   两个并发 tick 中，第一个同步置 true，第二个看到 true 后进入 _pendingTicks。
 *   待第一个 tick 完成，finally 中释放锁并触发 drain，串行处理等待队列。
 *
 * 与 _inflightGroups（skip-and-forget）不同：_pendingTicks 确保不丢失。
 */
let _globalSchedulerLock = false;
/** 等待全局锁释放后重试的 workspace id（Set 自动去重，同一 workspace 不重复入队）。 */
const _pendingTicks = new Set<string>();

/**
 * 从 _pendingTicks 取一个 workspace 重试调度。
 * 每次只取一个（串行），通过微任务（Promise.resolve().then）触发，
 * 在下一个 I/O 事件（宏任务）前执行，防止宏任务抢先重获锁。
 */
function _drainPendingTicks(): void {
  if (_pendingTicks.size === 0) return;
  const [next] = _pendingTicks;
  _pendingTicks.delete(next);
  Promise.resolve().then(() =>
    tickRepo(next).catch((e: unknown) =>
      log.error("_drainPendingTicks: 重试失败 workspace=%s: %s", next, (e as Error).message),
    ),
  );
}

/**
 * 单组 tick 入口：父 workspace + 所有关联子模块视为一个调度组。
 *
 * 算法（spec §4.3 组级扩展，Rev2 全局限速）：
 *   - groupId = workspace.parent_workspace_id ?? workspace.id
 *   - 全局 active = listRequirements({}) 中 workspace_id IS NOT NULL 且 status ∈ {running, fix_revision}
 *   - 若 global_active ≥ max_concurrent_tasks（默认 1）：do nothing
 *   - 否则取主仓库（父 groupId）上最老 queued requirement → startTaskFromTemplate
 *
 * 失败时回滚 status: queued → ready
 *
 * ⚠️ 行为变更（Rev2）：从「组内串行」改为「全局总上限」。
 *   N=1 时，多 workspace 用户从「每组最多 1 个」变为「全局最多 1 个」（更严格）。
 *   这是需求澄清 Q1 答案（全局总上限）的有意调整，非 bug。
 */
export async function tickRepo(workspaceId: string): Promise<void> {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) {
    log.error("tickRepo: workspace %s 不存在", workspaceId);
    return;
  }
  const groupId = workspace.parent_workspace_id ?? workspace.id;

  // 同组串行守卫（SC-3 TOCTOU）：同组两个事件并发时，跳过是安全的——
  // in-progress tick 完成后释放 _inflightGroups，下次事件再触发。
  if (_inflightGroups.has(groupId)) {
    log.info("tickRepo: group %s 已有调度在执行，本次跳过（同仓库串行）", groupId);
    return;
  }

  // 全局调度互斥锁（Rev2 TOCTOU 修复）：
  //   此赋值在首个 await 前同步完成（JS 单线程），其他协程无法在此窗口内插入。
  //   被阻塞的 tick 进入 _pendingTicks，锁释放后由 _drainPendingTicks 串行触发。
  if (_globalSchedulerLock) {
    log.info("tickRepo: 全局调度锁占用，入队等待 workspace=%s group=%s", workspaceId, groupId);
    _pendingTicks.add(workspaceId);
    return;
  }

  _globalSchedulerLock = true;
  _inflightGroups.add(groupId);
  try {
    await tickGroup(groupId);
  } finally {
    _inflightGroups.delete(groupId);
    _globalSchedulerLock = false;
    // 锁释放后串行处理等待队列
    _drainPendingTicks();
  }
}

/** tickRepo 的实际调度体（调用时已持全局锁 _globalSchedulerLock 和同组锁 _inflightGroups）。 */
async function tickGroup(groupId: string): Promise<void> {
  // 保留 submodules 供日志输出（不再用于 active 过滤，active 已改为全局）
  const submodules = listSubmodules(groupId);

  // 全局 active 检测（不区分 workspace 组）：
  //   - workspace_id IS NOT NULL：排除高层需求（无工作区绑定），防止其错误占用槽位
  //   - status ∈ {running, fix_revision}：占用槽位的两种状态
  const all = listRequirements({});
  const maxConcurrent = loadSchedulerConfig().max_concurrent_tasks ?? 1;
  const globalActive = all.filter(
    (r) => r.workspace_id !== null && (r.status === "running" || r.status === "fix_revision"),
  );
  if (globalActive.length >= maxConcurrent) return;

  // candidate 仅从主仓库拉（用户在 chat 提需求只会选父）
  const queued = all
    .filter((r) => r.workspace_id === groupId && r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  if (!candidate.workspace_id) {
    log.error("tickRepo: candidate %s 缺 workspace_id（不应发生）", candidate.id);
    return;
  }
  const candidateWorkspace = getWorkspaceById(candidate.workspace_id);
  if (!candidateWorkspace) {
    log.error("tickRepo: candidate workspace %s 不存在", candidate.workspace_id);
    return;
  }

  // 将已解决的澄清问答拼入 requirement，让 Agent 知晓用户的补充说明
  const questions = listComments(candidate.id, { kind: "question", status: "resolved", parent_id: null });
  let requirement = candidate.spec_md ?? "";
  if (questions.length > 0) {
    const qa = questions.map((q, i) => {
      const userReply = listComments(candidate.id, { kind: "question", parent_id: q.id })
        .find(r => r.from_role === "user")?.body ?? "(未回复)";
      return `**问题 ${i + 1}：** ${q.body}\n**回答：** ${userReply}`;
    }).join("\n\n");
    requirement = requirement
      ? `${requirement}\n\n## 需求澄清记录\n\n${qa}`
      : `## 需求澄清记录\n\n${qa}`;
  }

  // 历史执行评审遗留（bridge 在任务终态时沉淀的 agent feedback）：拼进需求文本让
  // 重跑的 design v1 即带上轮架构约束，打破「撞墙-失忆-重撞」循环。
  // 只取 agent 来源（不混入用户 feedback / GitHub review），上限 3 条防多轮失败堆积爆 prompt。
  const residues = listComments(candidate.id, { kind: "feedback" })
    .filter((c) => c.from_role === "agent")
    .slice(-3);
  if (residues.length > 0) {
    const txt = residues.map((c, i) => `### 遗留 ${i + 1}\n${c.body.slice(0, 2000)}`).join("\n\n");
    requirement += `\n\n## 历史执行评审遗留（前序执行被评审驳回的根因，本轮方案必须规避）\n\n${txt}`;
  }

  // req:task 1:1：需求已有存活 task → 复用它重置重跑，不新建第二个（避免一 req 堆多 task）。
  // 首次执行 task_id 为 null 走下面新建；failed/重新入队时 task_id 已写 → 复用重跑。
  // 需求选定的工作流（NULL = 未显式选择，回退默认 dev）
  const reqWorkflow = candidate.workflow ?? "dev";

  const existing = candidate.task_id ? getTask(candidate.task_id) : null;
  if (existing) {
    try {
      resetTaskForRerun(existing.id, {
        requirement,
        title: candidate.title,
        // failed 后用户可换工作流再重试：重跑时把 task 迁到新工作流（reset 本来就重置到
        // initial_state + 清历史 + 重 clone，换流程是干净的）
        workflow: reqWorkflow !== existing.workflow ? reqWorkflow : undefined,
      });
      updateRequirement(candidate.id, { schedule_error: null });
      setRequirementStatus(candidate.id, "running");
      log.info("tickRepo: 重跑 requirement %s → 复用 task %s on workspace %s",
        candidate.id, existing.id, candidateWorkspace.alias);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      log.error("tickRepo: 重跑失败 candidate=%s: %s", candidate.id, msg);
      try {
        updateRequirement(candidate.id, { schedule_error: `重跑失败：${msg}` });
        setRequirementStatus(candidate.id, "ready");
      } catch (rollbackErr: unknown) {
        log.error("tickRepo: 重跑回滚失败 %s: %s", candidate.id, (rollbackErr as Error).message);
      }
    }
    return;
  }

  let task;
  try {
    task = await startTaskFromTemplate({
      workflow: reqWorkflow,
      title: candidate.title,
      requirement,
      workspace_id: candidateWorkspace.id,
      requirement_id: candidate.id,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    log.error("tickRepo: 创建 task 失败 candidate=%s: %s", candidate.id, msg);
    try {
      // 把失败原因写进需求，让用户在需求页直接看到「为什么退回 ready / 没开跑」，
      // 不必翻 daemon.log（静默回滚是这类问题极难排查的根源）。
      updateRequirement(candidate.id, { schedule_error: `起任务失败：${msg}` });
      setRequirementStatus(candidate.id, "ready");
    } catch (rollbackErr: unknown) {
      log.error("tickRepo: 回滚 status 失败 %s: %s", candidate.id, (rollbackErr as Error).message);
    }
    return;
  }

  try {
    // 起 task 成功：清掉上次可能残留的调度失败原因
    updateRequirement(candidate.id, { task_id: task.id, schedule_error: null });
    setRequirementStatus(candidate.id, "running");
    log.info(
      "tickRepo: 启动 requirement %s → task %s on workspace %s (group=%s, submodules=%d)",
      candidate.id,
      task.id,
      candidateWorkspace.alias,
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
    if (!req.workspace_id) {
      // 高层需求（无 workspace 绑定）不参与调度组逻辑
      return;
    }

    try {
      await tickRepo(req.workspace_id);
    } catch (e: unknown) {
      log.error("requirement-scheduler: tickRepo 异常 workspace=%s: %s", req.workspace_id, (e as Error).message);
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
  // 清除全局状态，防止 daemon 重启后残留脏状态
  _globalSchedulerLock = false;
  _pendingTicks.clear();
}
