import { getTask, createTask, closeOpenPhaseEvents, nextRunSeqForRequirement } from "./db";
import type { Task } from "./db";
import { discover, getWorkflow, listWorkflows, isParallelPhase, getTerminalStates } from "./registry";
import { snapshotWorkflow } from "./manifest";
import { ensureTaskSandbox, deleteRemoteDeliverBranch, getTaskWorktreeMeta, getTaskSandbox, bindTaskRunRoot, removeTaskWorktree, type WorkspaceRef } from "./sandbox";
import { rmSync } from "fs";
import { getWorkspaceById } from "./workspaces";
import { getRequirementById, updateRequirement, listRequirementWorkspaces } from "./requirements";
import { clearSubPrs } from "./requirement-sub-prs";
import { isLocked } from "./infra";
import { forgetTaskRecoveryState } from "./watcher";
import { executePhase } from "./runner";
import { closeAgents } from "../agents/registry";

/** WorkspaceRef + alias（多库沙盒子目录名用） */
type WorkspaceRefWithAlias = WorkspaceRef & { alias?: string };

/**
 * 解析任务要 clone 的代码库集合（集合自然序 = workspace created_at 升序，主库概念已废除）。
 * - 需求集合（requirement_workspaces）≥1 时以集合为准（多库需求 = 多 clone 各自交付）
 * - 集合为空时回退单库 fallbackWsId（adhoc / 测试夹具路径）
 * 软失效（缺 remote_url）任一即抛：多库任务要求全集可 clone。
 */
function resolveWorkspaceRefs(
  reqId: string | undefined,
  fallbackWsId: string | undefined,
  errPrefix: string,
): WorkspaceRefWithAlias[] {
  const req = reqId ? getRequirementById(reqId) : null;
  const all = req ? listRequirementWorkspaces(req.id) : [];
  const pool = all.length > 0
    ? all
    : fallbackWsId
      ? [getWorkspaceById(fallbackWsId)].filter((w): w is NonNullable<typeof w> => w != null)
      : [];
  const refs: WorkspaceRefWithAlias[] = [];
  for (const ws of pool) {
    if (!ws.remote_url) {
      throw new StartTaskError(
        `${errPrefix}：Workspace ${ws.id}（${ws.alias}）缺少远程地址（软失效）。` +
        `多代码库任务要求集合内全部仓库可 clone。请先执行：\n` +
        `  autopilot workspace update ${ws.id} --remote <git-url>`,
        400,
      );
    }
    refs.push({
      id: ws.id,
      alias: ws.alias,
      remote_url: ws.remote_url,
      default_branch: ws.default_branch,
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    });
  }
  return refs;
}

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

/** 交付分支名：feat/<title-slug>-<taskId4>；中文等无 ascii slug 时回退 feat/task-<taskId8>。
 *  规范命名（而非 autopilot/<taskId> 这种中间痕迹名），让 PR head 干净。 */
function deliverBranchName(title: string, taskId: string): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug ? `feat/${slug}-${taskId.slice(0, 4)}` : `feat/task-${taskId.slice(0, 8)}`;
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
  /** run 种类（v2 R2）：缺省 execution；fix 修复轮由 R3 接入 */
  kind?: string;
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

  // 活跃 run 互斥（v2 R2：req:run 1:N，但活跃 run 同时最多一个）：需求当前指向的 run
  // 仍非终态时禁止新建。终态后允许追加新 run（重跑走 startNewRunForRequirement，历史保留）。
  const linkedReq = getRequirementById(reqLink);
  if (linkedReq?.task_id) {
    const activeRun = getTask(linkedReq.task_id);
    if (activeRun && !isTaskTerminal(activeRun)) {
      throw new StartTaskError(
        `需求 ${reqLink} 已有活跃 run ${activeRun.id}（${activeRun.status}），同一需求活跃 run 最多一个；` +
        `重跑请等其终态后走 startNewRunForRequirement`,
        409,
      );
    }
  }

  let taskId: string;
  if (opts.reqId) {
    taskId = opts.reqId.slice(0, 8);
    if (getTask(taskId)) throw new StartTaskError(`Task ID 已存在：${taskId}`, 409);
  } else {
    taskId = generateUniqueTaskId();
  }

  // v2 R2：新任务文件落新根 runtime/requirements/<reqId>/runs/<taskId>/。
  // 必须在任何文件落盘（ensureTaskSandbox / createTask 写 manifest）之前登记目录归属——
  // 此刻 task 行还不在 DB，getTaskRoot 无法反查 requirement_id。
  try {
    bindTaskRunRoot(taskId, reqLink);
  } catch (e: unknown) {
    console.warn("bindTaskRunRoot 失败（退回 legacy 根）：", e instanceof Error ? e.message : e);
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
        if (!["workflow", "title", "requirement", "reqId", "kind"].includes(key)) {
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

  // sandbox.git=true 时反查需求的代码库集合起多库 clone。必须在 createTask 之前，
  // 这样能把 clone 的真实路径/分支注入 extra（写进 manifest），供 run 阶段使用。
  let workspaceRefs: WorkspaceRefWithAlias[] = [];
  if (wf.sandbox?.git) {
    // 单库 fallback id：原始入参 opts（scheduler / routes 传的真值）优先；setup_func 返回的 extra
    // 不一定回传 workspace_id，不能依赖它（这是 worktree 之前从未建成的根因）。
    // 集合（requirement_workspaces）≥1 时以集合为准，fallback 只在集合为空时生效。
    const fallbackWsId =
      (typeof opts.workspace_id === "string" ? opts.workspace_id : undefined) ??
      (typeof opts.codebase_id === "string" ? opts.codebase_id : undefined) ??
      (typeof extra["workspace_id"] === "string" ? extra["workspace_id"] : undefined) ??
      (typeof extra["codebase_id"] === "string" ? extra["codebase_id"] : undefined) ??
      (getRequirementById(reqLink)?.workspace_id ?? undefined);
    workspaceRefs = resolveWorkspaceRefs(reqLink, fallbackWsId, "起任务失败");
    if (workspaceRefs.length >= 1) {
      // 统一 multi-clone 布局（单库也 clone 到 ./alias/ 子目录）：老 dev workflow 副本
      // 默认把 workspace 根当仓库根，所有 git 任务都会裸 git fatal；
      // 这里预先写一条指引日志，失败时用户能在任务日志看到根因。
      console.warn(
        `[task=${taskId}] 任务沙盒为统一子目录布局（${workspaceRefs.length} 库）：` +
        `dev workflow 副本需同步到统一布局版本：autopilot workflow sync dev --apply`,
      );
    }
  }
  try {
    // 共用沙盒模型：task 启动时建独立 clone（源仓库零痕迹），所有 phase 共用直接改文件。
    // 统一布局：每库 clone 到 workspace/<alias>/ 子目录（单库也是），各库共用同名交付分支。
    ensureTaskSandbox(
      taskId, workflowName, wf.sandbox,
      workspaceRefs.length > 0 ? workspaceRefs : undefined,
      deliverBranchName(title, taskId),
    );
  } catch (e: unknown) {
    console.warn("ensureTaskSandbox 失败：", e instanceof Error ? e.message : e);
  }

  // 框架标准字段注入：clone 建成功时，把物理路径/分支/base 写进 extra（写进 manifest 供 run
  // 阶段用）。workspace→物理路径解析是通用基础设施（注入路径事实，非业务概念），不违反红线。
  const worktreeMeta = getTaskWorktreeMeta(taskId);
  if (worktreeMeta) {
    extra["default_branch"] = worktreeMeta.base;
    extra["branch"] = worktreeMeta.branch;
    extra["workspace_path"] = worktreeMeta.workspace_path;
    // 共用沙盒：注入 repo_path = 共用 clone 路径，供 phase 直接当 cwd。
    extra["repo_path"] = getTaskSandbox(taskId);
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
    // v2 R2：run 种类 + 需求内序号（重跑追加新 run 时递增，历史 run 保留）
    kind: opts.kind ?? "execution",
    seq: nextRunSeqForRequirement(reqLink),
    workflowSnapshot: snapshotWorkflow(wf),
  });

  executePhase(taskId, firstPhaseName).catch(() => {});

  const task = getTask(taskId);
  if (!task) throw new StartTaskError("任务创建后读取失败", 500);
  return task;
}

/** task 是否处于终态（workflow 自定义 terminal_states ∪ 基础集 done/cancelled/failed）。 */
function isTaskTerminal(task: Task): boolean {
  const terminals = new Set(["done", "cancelled", "failed", ...getTerminalStates(task.workflow)]);
  return terminals.has(task.status);
}

/**
 * 需求级重跑 = 开新 run（v2 R2，替代已删除的 resetTaskForRerun 清史复用模型）。
 *
 * 旧 run 的执行历史**全部保留**（DB 行 / phase events / task_logs / artifacts / logs /
 * agent-calls / manifest 不清空——这是 run 多历史的核心价值）；只做新一轮必需的善后：
 *   1. 删旧远程 feat/ 交付分支（分支名基于需求派生、新 run 复用同名分支，先删消除
 *      non-fast-forward 冲突；GitHub 自动 close 旧 PR）。真失败 surface 到需求页（RERUN-07）。
 *   2. 清旧 run 的 workspace/ 代码 clone（磁盘大头；legacy worktree 任务先清源仓库注册）。
 *   3. 关旧 run 残留 open phase events（幂等，防时间线僵尸 running 轮）。
 *   4. 创建新 task 行（kind=execution、seq 递增，文件落 runs/<newTaskId>/）并把
 *      requirement.task_id 指向新 run，正常 clone 启动首阶段。
 *
 * @param opts.requirement 重跑时刷新的需求文本（spec 可能已更新）；省略则用需求当前 spec 由调用方拼好传入。
 * @param opts.title 重跑时刷新的标题；省略沿用需求标题。
 * @param opts.workflow 重跑时切换工作流（failed 后用户换流程重试）；省略沿用需求所选（NULL 回退 dev）。
 */
export async function startNewRunForRequirement(
  reqId: string,
  opts: { requirement?: string; title?: string; workflow?: string } = {},
): Promise<Task> {
  const req = getRequirementById(reqId);
  if (!req) throw new StartTaskError(`需求不存在：${reqId}`, 404);

  const oldTask = req.task_id ? getTask(req.task_id) : null;

  // 活跃 run 互斥：当前 run 非终态（或仍持文件锁）时不开新 run，避免删正被 git 写的 clone
  if (oldTask && (!isTaskTerminal(oldTask) || isLocked(oldTask.id))) {
    throw new StartTaskError(
      `需求 ${reqId} 的当前 run ${oldTask.id} 仍活跃（${oldTask.status}），无法开新 run；请先取消或等其终态`,
      409,
    );
  }

  // 旧 run 善后（历史保留，只清代码与远程分支）
  if (oldTask) {
    // 1. 删旧远程交付分支。真失败（非 404）写 schedule_error 让用户在需求页看到根因。
    try {
      const del = deleteRemoteDeliverBranch(oldTask.id);
      try {
        updateRequirement(reqId, {
          schedule_error: del.failed
            ? `开新 run 前删远程交付分支失败：${del.error ?? "未知错误"}（新一轮 push 可能因分支已存在冲突，请检查分支保护/凭证）`
            : null,
        });
      } catch { /* ignore */ }
    } catch (e: unknown) {
      console.warn("startNewRunForRequirement: deleteRemoteDeliverBranch 失败（容错继续）：", e instanceof Error ? e.message : e);
    }

    // 2. 清旧 run 的 workspace/（保留 artifacts / logs / manifest / .worktree.json 供历史回看）。
    //    legacy worktree 任务例外：必须先 git worktree remove 清源仓库注册（零痕迹红线）。
    const oldMeta = getTaskWorktreeMeta(oldTask.id);
    if (oldMeta && oldMeta.mode !== "clone" && oldMeta.mode !== "multi-clone") {
      try { removeTaskWorktree(oldTask.id); } catch { /* ignore */ }
    }
    try { rmSync(getTaskSandbox(oldTask.id), { recursive: true, force: true }); } catch { /* ignore */ }

    // 3. 关旧 run 残留 open phase events（幂等）+ 清 watcher 内存恢复计数（防泄漏）
    try { closeOpenPhaseEvents(oldTask.id); } catch { /* ignore */ }
    try { forgetTaskRecoveryState(oldTask.id); } catch { /* ignore */ }

    // 旧 agent session 指向被清的 clone，关掉防 claude --resume 续到陈旧会话
    void closeAgents(oldTask.workflow).catch(() => { /* best-effort */ });
  }

  // 上轮 PR 记录清空（旧 PR 已随删分支 close；新 run 的 PR 出来前不该显示旧链接，RERUN-08）
  try {
    updateRequirement(reqId, { pr_url: null, pr_number: null });
    clearSubPrs(reqId);
  } catch (e: unknown) {
    console.warn("startNewRunForRequirement: 清 requirement pr_url/sub_prs 失败：", e instanceof Error ? e.message : e);
  }

  // 4. 新 run：kind=execution、seq 递增，文件落 runtime/requirements/<reqId>/runs/<taskId>/
  const task = await startTaskFromTemplate({
    workflow: opts.workflow ?? req.workflow ?? undefined,
    title: opts.title ?? req.title,
    requirement: opts.requirement,
    requirement_id: reqId,
  });

  // requirement.task_id 指向新 run（旧 run 行保留 = 执行历史）
  try {
    updateRequirement(reqId, { task_id: task.id });
  } catch (e: unknown) {
    console.warn("startNewRunForRequirement: 写回 requirement.task_id 失败：", e instanceof Error ? e.message : e);
  }
  return task;
}
