import { onEvent, offEvent, emit } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import {
  listRequirements,
  setRequirementStatus,
  updateRequirement,
  getRequirementById,
  listRequirementWorkspaces,
} from "../core/requirements";
import type { Requirement } from "../core/requirements";
import { listComments } from "../core/requirement-comments";
import { getTask } from "../core/db";
import { startTaskFromTemplate, startNewRunForRequirement } from "../core/task-factory";
import { createLogger } from "../core/logger";
import { loadSchedulerConfig } from "../core/config";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

// ──────────────────────────────────────────────
// 测试 seam（_setDbForTest 同款约定）：让调度行为测试不依赖真实工作流注册 /
// 远程仓库（真实 startTaskFromTemplate 会 clone + 跑 agent）。生产路径零开销。
// ──────────────────────────────────────────────
type TaskStarters = {
  startTaskFromTemplate: typeof startTaskFromTemplate;
  startNewRunForRequirement: typeof startNewRunForRequirement;
};
let _starters: TaskStarters = { startTaskFromTemplate, startNewRunForRequirement };

/** 仅测试用：替换起任务 / 重跑实现。传 null 恢复真实实现。 */
export function _setTaskStartersForTest(s: Partial<TaskStarters> | null): void {
  _starters = {
    startTaskFromTemplate: s?.startTaskFromTemplate ?? startTaskFromTemplate,
    startNewRunForRequirement: s?.startNewRunForRequirement ?? startNewRunForRequirement,
  };
}

/**
 * 全局调度互斥锁：防止并发 tick 出现 TOCTOU（两个事件同时触发，双双越过
 * active 检测、超量起任务）。
 *
 * 原理（JS 单线程保证）：
 *   此变量在首个 await 前同步赋值，不会被其他协程打断。
 *   两个并发 tick 中，第一个同步置 true，第二个看到 true 后置 _pendingTick。
 *   待第一个 tick 完成，finally 中释放锁并补跑一次，确保不丢事件。
 */
let _globalSchedulerLock = false;
/** tick 被锁挡住时置位；锁释放后补跑一次 tick（调度是全局的，无需记录具体来源）。 */
let _pendingTick = false;

/**
 * 调度入口：纯全局上限 FIFO（主库 / 仓库分组概念已废除——每任务独立 clone
 * 沙盒，仓库不再是冲突域，调度只看全局并发上限）。
 *
 * 算法：
 *   - active = 全部需求中 status ∈ {running, fix_revision} 计数
 *   - queued 按 created_at 先进先出
 *   - while 循环起任务直到填满空槽（N>1 时一次事件可起多个）
 */
export async function tick(): Promise<void> {
  if (_globalSchedulerLock) {
    log.info("tick: 全局调度锁占用，记 pending 待锁释放后补跑");
    _pendingTick = true;
    return;
  }

  _globalSchedulerLock = true;
  try {
    await tickBody();
  } finally {
    _globalSchedulerLock = false;
    if (_pendingTick) {
      _pendingTick = false;
      // 通过微任务（Promise.resolve().then）触发补跑，在下一个 I/O 事件（宏任务）
      // 前执行，防止宏任务抢先重获锁。
      Promise.resolve().then(() =>
        tick().catch((e: unknown) =>
          log.error("tick: pending 补跑失败: %s", (e as Error).message),
        ),
      );
    }
  }
}

/** tick 的实际调度体（调用时已持全局锁 _globalSchedulerLock）。 */
async function tickBody(): Promise<void> {
  const all = listRequirements({});
  const maxConcurrent = loadSchedulerConfig().max_concurrent_tasks ?? 1;
  const active = all.filter(
    (r) => r.status === "running" || r.status === "fix_revision",
  ).length;
  if (active >= maxConcurrent) return;

  const queued = all
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);

  let started = 0;
  for (const snapshot of queued) {
    if (active + started >= maxConcurrent) return;
    // 快照可能过期（循环中有 await，用户可能 cancel / 其他写方改状态），起跑前复核
    const candidate = getRequirementById(snapshot.id);
    if (!candidate || candidate.status !== "queued") continue;
    if (await scheduleOne(candidate)) started++;
  }
}

/**
 * 调度单个 queued 需求 → 起（或重跑）task。返回是否成功占用一个并发槽。
 *
 * 失败路径回滚 queued → ready 并写 schedule_error（失败可见，用户在需求页直接看到
 * 「为什么没开跑」）。无库需求（集合为空）也照常调度：沙盒退化 / phase 失败会可见地
 * 停下报人，优于在调度层静默跳过造成永久卡死。
 */
async function scheduleOne(candidate: Requirement): Promise<boolean> {
  // 候选代码库走集合（requirement_workspaces 是唯一真相源，主库概念已废除）
  const reqWorkspaces = listRequirementWorkspaces(candidate.id);
  const wsAlias = reqWorkspaces[0]?.alias ?? "(无代码库)";

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

  // 多代码库需求（审批阶段反写的集合）：所有库均可写、各自交付 PR。
  // 集合 >1 时任务沙盒会把每个库 clone 到子目录（具体布局由执行阶段的 listTaskRepos 提供）。
  if (reqWorkspaces.length > 1) {
    const lines = reqWorkspaces
      .map((w) => `- ${w.alias}: ${w.remote_url ?? "(无远程地址)"}（默认分支 ${w.default_branch}）`)
      .join("\n");
    requirement += `\n\n## 本需求涉及的代码库（均可改动，将分别交付 PR）\n\n${lines}\n\n具体仓库在任务沙盒中的目录布局由执行阶段提供。`;
  }

  // 需求选定的工作流（NULL = 未显式选择，回退默认 dev）
  const reqWorkflow = candidate.workflow ?? "dev";

  // 需求级重跑 = 新 run（v2 R2）：需求已有 task（failed/重新入队时 task_id 已写）→
  // startNewRunForRequirement 追加新 run（旧 run 历史保留，远程旧分支/旧 clone 由其善后）。
  // 首次执行 task_id 为 null 走下面新建。
  const existing = candidate.task_id ? getTask(candidate.task_id) : null;
  if (existing) {
    try {
      const task = await _starters.startNewRunForRequirement(candidate.id, {
        requirement,
        title: candidate.title,
        // failed 后用户可换工作流再重试：新 run 全新 clone + 全新状态机，换流程是干净的
        workflow: reqWorkflow,
      });
      // schedule_error 不在此处盲清：startNewRunForRequirement 内部负责（删远程分支真失败
      // 时它写入的 RERUN-07 根因要保留，盲清会把刚 surface 的失败原因抹掉）
      setRequirementStatus(candidate.id, "running");
      log.info("tick: 重跑 requirement %s → 新 run %s（旧 run %s 历史保留）on workspace %s",
        candidate.id, task.id, existing.id, wsAlias);
      return true;
    } catch (e: unknown) {
      const msg = (e as Error).message;
      log.error("tick: 重跑失败 candidate=%s: %s", candidate.id, msg);
      try {
        updateRequirement(candidate.id, { schedule_error: `重跑失败：${msg}` });
        setRequirementStatus(candidate.id, "ready");
        emit({ type: "requirement:schedule-error", payload: { id: candidate.id, reason: `重跑失败：${msg}` } });
      } catch (rollbackErr: unknown) {
        log.error("tick: 重跑回滚失败 %s: %s", candidate.id, (rollbackErr as Error).message);
      }
      return false;
    }
  }

  let task;
  try {
    task = await _starters.startTaskFromTemplate({
      workflow: reqWorkflow,
      title: candidate.title,
      requirement,
      workspace_id: reqWorkspaces[0]?.id,
      requirement_id: candidate.id,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    log.error("tick: 创建 task 失败 candidate=%s: %s", candidate.id, msg);
    try {
      // 把失败原因写进需求，让用户在需求页直接看到「为什么退回 ready / 没开跑」，
      // 不必翻 daemon.log（静默回滚是这类问题极难排查的根源）。
      updateRequirement(candidate.id, { schedule_error: `起任务失败：${msg}` });
      setRequirementStatus(candidate.id, "ready");
      emit({ type: "requirement:schedule-error", payload: { id: candidate.id, reason: `起任务失败：${msg}` } });
    } catch (rollbackErr: unknown) {
      log.error("tick: 回滚 status 失败 %s: %s", candidate.id, (rollbackErr as Error).message);
    }
    return false;
  }

  try {
    // 起 task 成功：清掉上次可能残留的调度失败原因
    updateRequirement(candidate.id, { task_id: task.id, schedule_error: null });
    setRequirementStatus(candidate.id, "running");
    log.info(
      "tick: 启动 requirement %s → task %s on workspace %s",
      candidate.id,
      task.id,
      wsAlias,
    );
  } catch (e: unknown) {
    log.error("tick: 写回 task_id 或 setStatus running 失败 %s: %s", candidate.id, (e as Error).message);
  }
  // task 已实际启动，即使写回失败也占用了一个并发槽
  return true;
}

export function initRequirementScheduler(): void {
  if (_handler) return;

  const handler = async (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { from, to } = event.payload;

    const enqueued = to === "queued";
    const releasingSlot =
      (from === "running" || from === "fix_revision") &&
      ["awaiting_review", "done", "cancelled", "failed"].includes(to);

    if (!enqueued && !releasingSlot) return;

    try {
      await tick();
    } catch (e: unknown) {
      log.error("requirement-scheduler: tick 异常: %s", (e as Error).message);
    }
  };

  onEvent("requirement:status-changed", handler);
  _handler = handler;

  log.info("requirement-scheduler 已启动（订阅 requirement:status-changed）");

  // daemon 启动补 tick：捡起存量 queued（重启前已入队、触发事件已消逝的需求），
  // 与 fix-revision-runner 的重启扫描对称。调用时序在 initDb/migrations/discover 之后。
  void tick().catch((e: unknown) =>
    log.error("requirement-scheduler: 启动补 tick 失败: %s", (e as Error).message),
  );
}

export function disposeRequirementScheduler(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
  // 清除全局状态，防止 daemon 重启后残留脏状态
  _globalSchedulerLock = false;
  _pendingTick = false;
}
