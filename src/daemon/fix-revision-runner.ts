/**
 * fix-revision-runner：fix_revision 的修复执行器（需求中心架构 v2 R3：fix = 标准 run）。
 *
 * 演进：
 *   - 旧设计 A：workflow 内 await_review / fix_revision 两个 phase 长驻 polling —— 已拆。
 *   - 旧设计 B（方案 B，2026-06-12 上半）：需求级独立执行器，在「保留的任务沙盒」上
 *     一次性起修复 agent —— 独立炉灶：没有文件锁 / heartbeat / watcher 保护 / phase events，
 *     且依赖旧 run 的 workspace（被 retention 清走则只能 failed）。
 *   - 当前（v2 R3）：fix = kind=fix 的**标准 task**，走完整 runner 管线。本模块只负责：
 *       1. 程序化注册内置 `__fix` 工作流（单 phase `fix`；`__` 前缀 = 平台内置，
 *          listWorkflows 隐藏。prompt 含 PR / 反馈语义，故注册代码在 daemon 不进 core）
 *       2. 监听 requirement:status-changed → fix_revision：创建 fix run（kind=fix、seq 递增、
 *          requirement.task_id 指向 fix run；**续作不重来**——不删远程分支、不清旧 run workspace）
 *       3. daemon 启动补跑：fix_revision 且无活跃 run → 创建 fix run；有活跃 fix run 的
 *          由标准 task 恢复机制（respawn / dangling / watcher）接管
 *
 * fix run 沙盒 = **clone 远程交付分支**（checkout_existing_branch 模式）：feat/ 分支在远程
 * 存在，重新 clone 即可——不再依赖旧 run 的 workspace，「沙盒被 retention 清走则 failed」
 * 的尴尬从根上消灭。多库需求：全集 clone，有交付 PR 的库 checkout 各自交付分支，
 * 无 PR 的库停在默认分支只读参考。
 *
 * 终结汇报：fix run done → bridge 翻译 `{kind:"fixed"}` → reportRunOutcome → awaiting_review；
 * 失败（runner 确定性止损 / 触顶）→ failed → 需求 failed 停下报人。run 永不直接改需求状态。
 *
 * 进度可见性 = 标准 task 进度（执行视图 / task logs / agent-calls 天然可看），
 * 旧 fix-progress 内存态已退役。
 */

import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import {
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  listRequirements,
} from "../core/requirements";
import { listFeedbacks } from "../core/requirements/feedbacks";
import { createComment, nextCommentId } from "../core/requirements/comments";
import { listTaskRepos, getTaskSandbox, getTaskWorktreeMeta, type TaskRepoCtx } from "../core/sandbox";
import { listSubPrs, type RequirementSubPr } from "../core/requirements/sub-prs";
import { hasDeliveries, deliverArtifacts, maxDeliveryRound, getDeliveryRoundDir } from "../core/requirements/deliveries";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { getTask } from "../core/db";
import {
  registerBuiltin,
  expandPhaseDefaults,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../core/workflow/registry";
import { startTaskFromTemplate, isTaskTerminal, StartTaskError } from "../core/task/factory";
import { agentForPhase } from "../agents/registry";
import type { InlineAgentConfig } from "../core/agent-defaults";
import { loadLifecycleConfig } from "../core/config";
import { resolveDefaultProvider } from "../core/default-provider";
import { createLogger } from "../core/logger";

const log = createLogger("fix-revision-runner");

/** 内置修复工作流名（`__` 前缀 = 平台内置，listWorkflows 隐藏） */
export const FIX_WORKFLOW_NAME = "__fix";

/** 拼进 prompt 的反馈条数上限（升序取最近 N 条，最新在后） */
const MAX_FEEDBACKS_IN_PROMPT = 5;

// ──────────────────────────────────────────────
// 内置 __fix 工作流（单 phase fix，走标准 runner 管线）
// ──────────────────────────────────────────────

/**
 * 修复 agent 的【代码兜底缺省】（信任级同 dev develop 阶段；模型回退 provider 默认）。
 * system_prompt 里「修小而准，不顺手重构」是一种修复取向——属用户该掌控的领域决策，
 * 故下面 effectiveFixConfig 让 config.json `lifecycle.fix` 字段级覆盖它（与 clarify 同构）。
 */
const FIXER_DEFAULTS: InlineAgentConfig = {
  // provider 不写死：缺省走 resolveDefaultProvider()（按用户实际配置派生），见 effectiveFixConfig
  // 修复要读日志 / 改多文件 / 跑测试 / git 操作，回合数给足
  max_turns: 40,
  permission_mode: "bypassPermissions",
  system_prompt:
    "你是资深工程师，负责按评审/CI 反馈修复已交付的 PR。工作目录是交付分支的工作树，" +
    "直接修改并 push 同一分支。修复前先理解反馈与现有实现，修小而准，不顺手重构。",
};

/**
 * 修复 agent 的生效配置 = FIXER_DEFAULTS ← config.json `lifecycle.fix`（字段级 merge）。
 * 与 effectiveClarifyConfig 同构（返回 {effective, userConfig, defaults}，供 lifecycle RPC 复用）：
 * 用户写的字段（含 system_prompt / provider / model / max_turns / permission_mode）覆盖同名缺省，
 * 未写的走兜底。改 config.json 后 daemon 重启生效。
 */
export function effectiveFixConfig(): {
  effective: InlineAgentConfig;
  userConfig: InlineAgentConfig;
  defaults: InlineAgentConfig;
} {
  const userConfig = (loadLifecycleConfig().fix ?? {}) as InlineAgentConfig;
  const effective: InlineAgentConfig = { ...FIXER_DEFAULTS, ...userConfig };
  // 用户没显式写 provider → 填解析到的系统默认（让生效配置 + Web 卡片回显真实默认，而非写死 anthropic）
  if (!effective.provider) effective.provider = resolveDefaultProvider();
  return { effective, userConfig, defaults: FIXER_DEFAULTS };
}

function buildFixWorkflow(): WorkflowDefinition {
  const phase: PhaseDefinition = expandPhaseDefaults(
    {
      name: "fix",
      timeout: 3600,
      agent: effectiveFixConfig().effective,
      func: runFixPhase,
    },
    new Set(["fix"]),
  );
  return {
    name: FIX_WORKFLOW_NAME,
    label: "修复轮（内置）",
    description: "平台内置：fix_revision 修复轮执行器（按评审/CI 反馈在交付分支上修复并 push）",
    phases: [phase],
    initial_state: phase.pending_state, // pending_fix
    terminal_states: ["done", "cancelled", "failed"],
    // sandbox.git=true：task-factory 反查需求代码库集合远程 clone（fix run 经
    // checkout_existing_branch 续作交付分支，见 startFixRun）
    sandbox: { git: true },
  };
}

// ──────────────────────────────────────────────
// 执行层（可测试注入）
// ──────────────────────────────────────────────

type FixFn = (prompt: string, cwd: string) => Promise<string>;

let _fixFn: FixFn = runFixerAgent;

export function _setFixFnForTest(fn: FixFn | null): void {
  _fixFn = fn ?? runFixerAgent;
}

// listTaskRepos 读 .worktree.json（真实 clone 布局）；测试无真实 clone 时注入假布局。
type ListReposFn = typeof listTaskRepos;

let _listRepos: ListReposFn = listTaskRepos;

export function _setListReposForTest(fn: ListReposFn | null): void {
  _listRepos = fn ?? listTaskRepos;
}

async function runFixerAgent(prompt: string, cwd: string): Promise<string> {
  const agent = agentForPhase(FIX_WORKFLOW_NAME, "fix");
  const result = await agent.run(prompt, { cwd });
  return result.text.trim();
}

// ──────────────────────────────────────────────
// Prompt 构造
// ──────────────────────────────────────────────

function repoLayoutSection(repos: TaskRepoCtx[], subPrs: RequirementSubPr[]): string {
  const prByWs = new Map(subPrs.map((sp) => [sp.child_workspace_id, sp.pr_number]));
  const lines = repos.map((r) => {
    const where = r.dir ? `子目录 ${r.dir}/` : "当前目录（仓库根）";
    const pr = prByWs.get(r.workspace_id);
    const deliver = pr
      ? `交付分支 ${r.branch}（base ${r.base}），交付 PR #${pr}`
      : `无交付 PR（停在默认分支，只读参考，勿改动）`;
    return `- ${r.alias || "（仓库）"}：${where}，${deliver}`;
  });
  return lines.join("\n");
}

export function buildFixPrompt(
  reqId: string,
  title: string,
  repos: TaskRepoCtx[],
  subPrs: RequirementSubPr[],
  mainPrNumber: number | null,
): string {
  // 排除 from_role=agent 的反馈：fixer 每轮把「改了什么」总结作为 agent feedback 落库
  // （还有 run-outcome 写的「执行评审遗留」也是 agent），slice(-N) 会把它当反馈喂回下一轮、
  // 还被误标成「用户」→ 多轮后用 agent 自产噪音污染修复输入。用排除语义（而非白名单 user/
  // github）直接表意，且对将来新增 from_role 保守——默认进 prompt 而不是被静默丢弃。
  const feedbacks = listFeedbacks(reqId)
    .filter((f) => f.from_role !== "agent")
    .slice(-MAX_FEEDBACKS_IN_PROMPT);
  const fbSection = feedbacks.length > 0
    ? feedbacks
        .map((f) => `### ${f.source === "github_review" ? "GitHub 评审/CI" : "用户"} · ${new Date(f.created_at).toISOString()}\n${f.body}`)
        .join("\n\n---\n\n")
    : "（未找到反馈正文 —— 请检查 PR 上的最新 review 与 CI 状态后自行判断需要修什么）";
  const prNumbers = [
    ...new Set([...subPrs.map((sp) => sp.pr_number), ...(mainPrNumber ? [mainPrNumber] : [])]),
  ].filter((n) => n > 0);
  const prHint = prNumbers.length > 0
    ? `相关 PR：${prNumbers.map((n) => `#${n}`).join("、")}。CI 失败时可用 \`gh pr checks <PR号>\` 与 \`gh run view --log-failed\` 查看失败日志。`
    : "";

  return [
    `# 修复任务：${title}`,
    "",
    "此前交付的 PR 收到了评审 / CI 反馈，请在现有交付分支上修复。",
    "",
    "## 仓库布局（任务沙盒，有交付 PR 的库已 checkout 交付分支）",
    repoLayoutSection(repos, subPrs),
    "",
    "## 反馈（按时间升序，最新在最后；与旧反馈冲突时以最新为准）",
    fbSection,
    "",
    "## 要求",
    "1. 理解反馈，在对应仓库中完成修复；能本地验证（编译/测试）就先验证",
    `2. ${prHint}`,
    "3. 修复完成后，在每个有改动的仓库里执行：git add -A && git commit（中文 commit message）&& git push（推当前分支）",
    "4. 禁止：创建/切换分支、改动 base 分支、force push、修改远程配置",
    "5. 最后用一段话总结：改了什么、push 了哪些仓库；没有需要修的就说明原因（不要空 commit）",
  ].join("\n");
}

/** 沙盒内产物目录名（与 artifact 工作流约定一致；修复轮重做产物写到这里再 promote） */
const FIX_DELIVERABLES_DIR = "deliverables";

/**
 * artifacts 修复模式 prompt（v2 R5）：需求无交付 PR、有 deliveries —— 按反馈**重做产物**，
 * 完成后由框架 promote 到需求 deliveries/round-<N+1>/（替代 PR 模式的 commit/push 指引）。
 */
function buildArtifactFixPrompt(
  reqId: string,
  title: string,
  repos: TaskRepoCtx[],
  lastRound: number,
): string {
  // 同 buildFixPrompt：排除 fixer 自产 / run-outcome 的 from_role=agent 反馈，只留可操作的
  const feedbacks = listFeedbacks(reqId)
    .filter((f) => f.from_role !== "agent")
    .slice(-MAX_FEEDBACKS_IN_PROMPT);
  const fbSection = feedbacks.length > 0
    ? feedbacks
        .map((f) => `### ${f.source === "github_review" ? "评审" : "用户"} · ${new Date(f.created_at).toISOString()}\n${f.body}`)
        .join("\n\n---\n\n")
    : "（未找到反馈正文 —— 请根据需求规约自行判断需要改什么）";
  const repoSection = repos.length > 0
    ? [
        "## 参考仓库布局（只读参考，**不要 git commit / push / 改动仓库已有文件**）",
        repos.map((r) => `- ${r.alias || "（仓库）"}：${r.dir ? `子目录 ${r.dir}/` : "当前目录"}`).join("\n"),
        "",
      ]
    : [];

  return [
    `# 产物修复任务：${title}`,
    "",
    `此前交付的产物（第 ${lastRound} 轮验收）被驳回，请按反馈重做产物。`,
    "",
    ...repoSection,
    "## 反馈（按时间升序，最新在最后；与旧反馈冲突时以最新为准）",
    fbSection,
    "",
    "## 要求",
    `1. 当前目录的 \`${FIX_DELIVERABLES_DIR}/\` 里已放着上一轮产物，请按反馈修改它（增量改还是推倒重做由你的修复取向决定）。该目录在你完成后会整体作为新一轮交付——保留的文件原样留着即可`,
    `2. 最后更新 \`${FIX_DELIVERABLES_DIR}/SUMMARY.md\`：本轮改了什么、每个文件是什么、怎么打开查看`,
    "3. 禁止：git commit / push、修改参考仓库文件、把产物写到别处",
    "4. 最后用一段话总结：按哪条反馈改了什么",
  ].join("\n");
}

// ──────────────────────────────────────────────
// fix phase（标准阶段函数：runner 负责锁/心跳/事件/重试/止损，这里只干修复本身）
// ──────────────────────────────────────────────

export async function runFixPhase(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`fix run ${taskId} 不存在`);
  const reqId = task.requirement_id;
  if (!reqId) throw new Error(`fix run ${taskId} 缺少 requirement_id`);
  const req = getRequirementById(reqId);
  if (!req) throw new Error(`fix run ${taskId} 关联需求 ${reqId} 不存在`);

  const subPrs = listSubPrs(reqId);
  const hasPr = (req.pr_number ?? 0) > 0 || subPrs.some((sp) => sp.pr_number > 0);

  // artifacts 修复模式（v2 R5）：无交付 PR、有 deliveries —— 重做产物 + promote round+1。
  // 守卫 = deliveries 存在（hasPr 优先，混合交付不支持，PR 赢——与 run-outcome 同口径），
  // PR 路径零回归：hasPr 时永远走下方原 PR 修复分支。
  if (!hasPr && hasDeliveries(reqId)) {
    await runArtifactFixPhase(taskId, reqId, req.title);
    return;
  }

  const repos = _listRepos(taskId);
  if (repos.length === 0) {
    throw new Error(`fix run ${taskId} 无沙盒布局（.worktree.json 缺失 / clone 失败），无法修复`);
  }

  const prompt = buildFixPrompt(reqId, req.title, repos, subPrs, req.pr_number ?? null);

  log.info("fix-runner: req=%s 开始修复（fix run=%s, repos=%s, PRs=%s）",
    reqId, taskId, repos.length,
    [...new Set([...subPrs.map((sp) => sp.pr_number), ...(req.pr_number ? [req.pr_number] : [])])].join(",") || "无");

  // cwd = 沙盒根（统一子目录布局，各库在 ./alias/）。agent 实时输出 / agent-calls 记录
  // 由 runner 的 runWithTaskContext 标准管线提供，无需在此手工接 logger / task-context。
  const summary = (await _fixFn(prompt, getTaskSandbox(taskId))).trim();

  // 产出可见性：修复总结落需求评论（反馈历史直接展示「改了什么、push 了哪些库」），
  // 不让产出只活在任务日志里。写入失败不阻塞 run 终结（状态流转走 bridge → reportRunOutcome）。
  try {
    createComment({
      id: nextCommentId(),
      requirement_id: reqId,
      kind: "feedback",
      from_role: "agent",
      body: `【修复完成】\n\n${summary.slice(0, 8000)}`,
    });
  } catch (e: unknown) {
    log.warn("fix-runner: req=%s 修复总结写评论失败：%s", reqId, (e as Error).message);
  }
  log.info("fix-runner: req=%s 修复完成（fix run=%s）。agent 总结：%s", reqId, taskId, summary.slice(0, 300));
}

/**
 * artifacts 修复（v2 R5）：cwd = 任务沙盒根（有库 = 需求级 codebase 容器目录，库只读参考；
 * 无库 = runs/<id>/workspace 空目录）。流程：
 *   1. 把上一轮交付物种入 cwd/deliverables/（agent 增量修改，与 artifact 探针的驳回语义一致）
 *   2. 起修复 agent 按反馈重做产物
 *   3. deliverArtifacts promote 到需求 deliveries/round-<N+1>/ 落表（替代 PR 模式的 commit/push）
 *   4. 修复总结落需求评论（与 PR 模式同管道）
 */
async function runArtifactFixPhase(taskId: string, reqId: string, title: string): Promise<void> {
  const cwd = getTaskSandbox(taskId);
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  // 种入上一轮产物（rm 后整拷，防上次中断残留半套）
  const lastRound = maxDeliveryRound(reqId);
  const workDir = join(cwd, FIX_DELIVERABLES_DIR);
  const prevDir = getDeliveryRoundDir(reqId, lastRound);
  rmSync(workDir, { recursive: true, force: true });
  if (existsSync(prevDir)) {
    cpSync(prevDir, workDir, { recursive: true });
  } else {
    mkdirSync(workDir, { recursive: true });
  }

  const repos = _listRepos(taskId);
  const prompt = buildArtifactFixPrompt(reqId, title, repos, lastRound);

  log.info("fix-runner: req=%s 开始产物修复（fix run=%s, 上一轮 round=%s, 参考仓库=%s）",
    reqId, taskId, lastRound, repos.length);

  const summary = (await _fixFn(prompt, cwd)).trim();

  if (!existsSync(workDir) || readdirSync(workDir).length === 0) {
    throw new Error(`产物修复完成但 ${FIX_DELIVERABLES_DIR}/ 为空——agent 未按约定产出`);
  }
  const delivery = deliverArtifacts(taskId, workDir, summary);

  try {
    createComment({
      id: nextCommentId(),
      requirement_id: reqId,
      kind: "feedback",
      from_role: "agent",
      body: `【修复完成 · 第 ${delivery.round} 轮交付】\n\n${summary.slice(0, 8000)}`,
    });
  } catch (e: unknown) {
    log.warn("fix-runner: req=%s 修复总结写评论失败：%s", reqId, (e as Error).message);
  }
  log.info("fix-runner: req=%s 产物修复完成（fix run=%s, round=%s）。agent 总结：%s",
    reqId, taskId, delivery.round, summary.slice(0, 300));
}

// ──────────────────────────────────────────────
// fix run 创建（事件触发 / 启动补跑共用）
// ──────────────────────────────────────────────

/**
 * 为 fix_revision 需求创建 fix run（kind=fix 的标准 task）。
 *
 * 与 startNewRunForRequirement（重跑=重来）的关键区别 —— fix 是**续作**：
 *   - 不删远程交付分支（修复要 push 回同一分支让 PR 自动更新）
 *   - 不清旧 run workspace / 不清 sub_prs / pr_url（历史与交付记录原样保留）
 *   - 沙盒 = 重新 clone + checkout 远程交付分支（不依赖旧 run 的本地 workspace）
 *
 * 防重入：需求已有活跃（非终态）run 时跳过（DB 真相，与 task-factory 409 守卫同口径）——
 * 活跃 fix run 的中断恢复由标准 task 机制（respawn / dangling / watcher）负责。
 */
export async function startFixRun(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "fix_revision") return;

  const fail = (reason: string): void => {
    log.warn("fix-runner: req=%s 无法启动修复：%s", reqId, reason);
    try {
      setRequirementStatus(reqId, "failed", { reason: `修复执行失败：${reason}`, reason_source: "system" });
    } catch (e: unknown) {
      log.error("fix-runner: req=%s 转 failed 失败：%s", reqId, (e as Error).message);
    }
  };

  // 防重入（DB 真相）：当前指向的 run 仍活跃 → 不重复创建
  if (req.task_id) {
    const cur = getTask(req.task_id);
    if (cur && !isTaskTerminal(cur)) {
      log.info("fix-runner: req=%s 已有活跃 run %s（%s），跳过创建 fix run", reqId, cur.id, cur.status);
      return;
    }
  }

  if (!req.task_id) {
    fail("需求无关联任务（task_id 为空），找不到上一轮交付现场");
    return;
  }
  // artifacts 修复模式（v2 R5）：无交付 PR、有 deliveries —— 交付现场在需求 deliveries/
  // 目录（runFixPhase 会把上一轮产物种入沙盒），不依赖上一轮交付分支。
  const subPrs = listSubPrs(reqId);
  const artifactsMode =
    !((req.pr_number ?? 0) > 0 || subPrs.some((sp) => sp.pr_number > 0)) && hasDeliveries(reqId);

  // 交付分支名从上一轮 run 的 .worktree.json 取（fix run 链上每轮都续写同名分支）。
  // 运行目录被整体删除（meta 丢失）才无从续作 —— PR 模式此时只能整轮重跑；
  // artifacts 模式无分支也可修（有库则停默认分支只读参考）。
  const prevMeta = getTaskWorktreeMeta(req.task_id);
  const branch = prevMeta?.branch;
  if (!branch && !artifactsMode) {
    fail(`上一轮 run ${req.task_id} 无交付分支记录（.worktree.json 缺失，运行目录可能已被删除），请重新入队整轮重跑`);
    return;
  }

  let taskId: string;
  try {
    const task = await startTaskFromTemplate({
      workflow: FIX_WORKFLOW_NAME,
      title: req.title,
      requirement_id: reqId,
      kind: "fix",
      ...(branch ? { deliver_branch: branch, checkout_existing_branch: true } : {}),
    });
    taskId = task.id;
  } catch (e: unknown) {
    if (e instanceof StartTaskError && e.status === 409) {
      // 并发窗口下已有活跃 run（守卫同口径）——让位，不算失败
      log.info("fix-runner: req=%s 创建 fix run 撞活跃 run 守卫，跳过：%s", reqId, e.message);
      return;
    }
    fail(`创建 fix run 失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // requirement.task_id 指向 fix run（旧 run 行保留 = 执行历史；UI 执行视图随之切到修复轮）
  try {
    updateRequirement(reqId, { task_id: taskId });
  } catch (e: unknown) {
    log.error("fix-runner: req=%s 写回 task_id=%s 失败：%s", reqId, taskId, (e as Error).message);
  }
  log.info("fix-runner: req=%s 已创建 fix run %s（branch=%s，续作不删远程分支）", reqId, taskId, branch);
}

// ──────────────────────────────────────────────
// 事件订阅 + 启动恢复
// ──────────────────────────────────────────────

let _handler: ((event: AutopilotEvent) => void) | null = null;

export function initFixRevisionRunner(): void {
  if (_handler) return;

  // 注册内置 __fix 工作流（registerBuiltin：workflow reload 后仍存活）。
  // 必须先于 daemon 的 recoverDanglingTasks / watcher——它们恢复 running_fix 任务时
  // 要能 getWorkflow("__fix") 找到 phase 函数。
  registerBuiltin(buildFixWorkflow());

  _handler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "fix_revision") return;
    startFixRun(id).catch((e: unknown) => {
      log.error("fix-runner: 触发失败 req=%s: %s", id, (e as Error).message);
    });
  };
  onEvent("requirement:status-changed", _handler);

  // 启动补跑：停在 fix_revision 且无活跃 run 的需求补建 fix run（含 v2 R3 之前的存量
  // 需求——旧模型无 fix run 概念，直接起新 fix run 即可）。有活跃 fix run 的在
  // startFixRun 内被防重入跳过，交由标准 task 恢复机制接管。
  const stranded = listRequirements({ status: "fix_revision" });
  for (const r of stranded) {
    log.info("fix-runner: 启动恢复 —— req=%s 停在 fix_revision，检查/补建 fix run", r.id);
    startFixRun(r.id).catch((e: unknown) => {
      log.error("fix-runner: 启动恢复失败 req=%s: %s", r.id, (e as Error).message);
    });
  }

  log.info("fix-revision-runner 已启动（__fix 工作流已注册；订阅 requirement:status-changed，启动检查 %s 条）", stranded.length);
}

export function disposeFixRevisionRunner(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
