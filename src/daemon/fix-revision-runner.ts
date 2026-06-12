/**
 * fix-revision-runner：fix_revision 的修复执行器（方案 B，2026-06-12）。
 *
 * 背景：旧设计里修复由 workflow 的 await_review / fix_revision 两个 phase 承担
 * （任务长驻 polling 等 trigger）。该机制随 workflow 精简被拆掉后，需求转入
 * fix_revision 就没有任何组件去执行修复 —— 反馈注入后永远停在原地（req-018 链路）。
 *
 * 本模块以「需求级执行器」补上闭环，与任务状态机解耦（task 保持 done 不复活）：
 *   requirement → fix_revision（注入反馈 / PR CHANGES_REQUESTED / CI 失败均会触发）
 *     → 在保留的任务沙盒（clone + 交付分支工作树）上一次性起修复 agent：
 *       读反馈 → 改代码 → commit & push 同分支（PR 自动更新）
 *     → 成功转回 awaiting_review（pr-poller 继续盯 merge / CI）
 *     → 失败转 failed 停下报人（status_reason 可见，可重试）
 *
 * 进度可见性：fix-progress 内存态 + requirement:fix-round-update 事件，
 * Web 在 fix_revision 状态显示实时进度卡。
 *
 * daemon 重启恢复：init 时扫描存量 fix_revision 需求补跑（漏触发的回路不悬空）。
 */

import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import {
  getRequirementById,
  setRequirementStatus,
  listRequirements,
} from "../core/requirements";
import { listFeedbacks } from "../core/requirement-feedbacks";
import { createComment, nextCommentId } from "../core/requirement-comments";
import { listTaskRepos, type TaskRepoCtx } from "../core/sandbox";
import { listSubPrs } from "../core/requirement-sub-prs";
import { createAgent } from "../agents/registry";
import { loadProviders } from "../core/config";
import type { ProviderName } from "../core/config";
import { runWithTaskContext } from "../core/task-context";
import { startFixRound, setFixPhase, endFixRound } from "./fix-progress";
import { createLogger, setTaskId, setPhase as setLogPhase, resetPhase } from "../core/logger";
import { existsSync } from "fs";

const log = createLogger("fix-revision-runner");

/** 拼进 prompt 的反馈条数上限（升序取最近 N 条，最新在后） */
const MAX_FEEDBACKS_IN_PROMPT = 5;

// ──────────────────────────────────────────────
// 修复 agent（daemon 层基础设施，与 clarifier-agent 同构；信任级同 develop 阶段）
// ──────────────────────────────────────────────

const FIXER_DEFAULTS = {
  provider: "anthropic" as ProviderName,
  // 修复要读日志 / 改多文件 / 跑测试 / git 操作，回合数给足
  max_turns: 40,
  permission_mode: "bypassPermissions",
  system_prompt:
    "你是资深工程师，负责按评审/CI 反馈修复已交付的 PR。工作目录是交付分支的工作树，" +
    "直接修改并 push 同一分支。修复前先理解反馈与现有实现，修小而准，不顺手重构。",
};

function buildFixerAgent() {
  const providers = loadProviders();
  const provider = FIXER_DEFAULTS.provider;
  return createAgent({
    name: "fix-reviser",
    provider,
    model: providers[provider]?.default_model,
    max_turns: FIXER_DEFAULTS.max_turns,
    permission_mode: FIXER_DEFAULTS.permission_mode,
    system_prompt: FIXER_DEFAULTS.system_prompt,
  });
}

// ──────────────────────────────────────────────
// 执行层（可测试注入）
// ──────────────────────────────────────────────

type FixFn = (prompt: string, cwd: string) => Promise<string>;

let _fixFn: FixFn = runFixerAgent;

export function _setFixFnForTest(fn: FixFn | null): void {
  _fixFn = fn ?? runFixerAgent;
}

// listTaskRepos 依赖模块加载时固定的 AUTOPILOT_HOME 常量，测试无法用 tmp home
// 重定向（沙盒测试为此走子进程）。这里提供注入点让 runner 测试留在主进程。
type ListReposFn = typeof listTaskRepos;

let _listRepos: ListReposFn = listTaskRepos;

export function _setListReposForTest(fn: ListReposFn | null): void {
  _listRepos = fn ?? listTaskRepos;
}

async function runFixerAgent(prompt: string, cwd: string): Promise<string> {
  const agent = buildFixerAgent();
  const result = await agent.run(prompt, { cwd });
  return result.text.trim();
}

// ──────────────────────────────────────────────
// Prompt 构造
// ──────────────────────────────────────────────

function repoLayoutSection(repos: TaskRepoCtx[]): string {
  const lines = repos.map((r) => {
    const where = r.dir ? `子目录 ${r.dir}/` : "当前目录（仓库根）";
    return `- ${r.alias || "（仓库）"}：${where}，交付分支 ${r.branch}（base ${r.base}）`;
  });
  return lines.join("\n");
}

function buildFixPrompt(reqId: string, title: string, repos: TaskRepoCtx[], prNumbers: number[]): string {
  const feedbacks = listFeedbacks(reqId).slice(-MAX_FEEDBACKS_IN_PROMPT);
  const fbSection = feedbacks.length > 0
    ? feedbacks
        .map((f) => `### ${f.source === "github_review" ? "GitHub 评审/CI" : "用户"} · ${new Date(f.created_at).toISOString()}\n${f.body}`)
        .join("\n\n---\n\n")
    : "（未找到反馈正文 —— 请检查 PR 上的最新 review 与 CI 状态后自行判断需要修什么）";
  const prHint = prNumbers.length > 0
    ? `相关 PR：${prNumbers.map((n) => `#${n}`).join("、")}。CI 失败时可用 \`gh pr checks <PR号>\` 与 \`gh run view --log-failed\` 查看失败日志。`
    : "";

  return [
    `# 修复任务：${title}`,
    "",
    "此前交付的 PR 收到了评审 / CI 反馈，请在现有交付分支上修复。",
    "",
    "## 仓库布局（任务沙盒，已是交付分支的工作树）",
    repoLayoutSection(repos),
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

// ──────────────────────────────────────────────
// 执行体
// ──────────────────────────────────────────────

const _inflight = new Set<string>();

/** 测试用：清空进程内锁。 */
export function _resetFixInflightForTest(): void {
  _inflight.clear();
}

export async function runFixRevision(reqId: string): Promise<void> {
  if (_inflight.has(reqId)) {
    log.info("fix-runner: req=%s 已在跑，跳过重复触发", reqId);
    return;
  }
  _inflight.add(reqId);
  try {
    await _runInner(reqId);
  } finally {
    _inflight.delete(reqId);
    endFixRound(reqId, "errored"); // inner 正常结束已 endFixRound，这里是异常路径兜底（no-op 安全）
  }
}

async function _runInner(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "fix_revision") return;

  startFixRound(reqId);

  const fail = (reason: string): void => {
    log.warn("fix-runner: req=%s 修复失败：%s", reqId, reason);
    endFixRound(reqId, "errored");
    try {
      setRequirementStatus(reqId, "failed", { reason: `修复执行失败：${reason}`, reason_source: "system" });
    } catch (e: unknown) {
      log.error("fix-runner: req=%s 转 failed 失败：%s", reqId, (e as Error).message);
    }
  };

  if (!req.task_id) {
    fail("需求无关联任务（task_id 为空），没有可修复的交付沙盒");
    return;
  }
  const repos = _listRepos(req.task_id);
  if (repos.length === 0) {
    fail(`任务 ${req.task_id} 无沙盒布局（.worktree.json 缺失）`);
    return;
  }
  const primary = repos.find((r) => r.primary) ?? repos[0];
  if (!existsSync(primary.path)) {
    fail(`任务沙盒已不存在（${primary.path}）—— 可能被保留策略清理，请重新入队整轮重跑`);
    return;
  }

  const prNumbers = [
    ...new Set([
      ...listSubPrs(reqId).map((sp) => sp.pr_number),
      ...(req.pr_number ? [req.pr_number] : []),
    ]),
  ].filter((n) => n > 0);

  const prompt = buildFixPrompt(reqId, req.title, repos, prNumbers);

  log.info("fix-runner: req=%s 开始修复（task=%s, repos=%s, PRs=%s）",
    reqId, req.task_id, repos.length, prNumbers.join(",") || "无");
  setFixPhase(reqId, "fixing");

  // 进入 task context + logger 任务标签 —— 让修复过程获得与正常 phase 同级的可见性：
  // - agent 的实时输出（bridgeCliMessage：assistant 文本/工具调用/工具结果）走 log:entry
  //   事件（带 taskId）+ 落 phase 磁盘日志 → Web 执行记录 / `task logs --follow` 实时可看
  // - Agent.run 自动 appendAgentCall(phase="fix_revision") → 调用记录（prompt/产出/用时）持久化
  let summary: string;
  setTaskId(req.task_id);
  setLogPhase("fix_revision", "FIX_REVISION");
  try {
    summary = await runWithTaskContext(
      { taskId: req.task_id, phase: "fix_revision", sandboxDir: primary.path },
      () => _fixFn(prompt, primary.path),
    );
  } catch (e: unknown) {
    fail(e instanceof Error ? e.message : String(e));
    return;
  } finally {
    resetPhase();
  }

  // 修复期间用户可能取消/状态被改 —— re-fetch 校验后再转回验收
  const after = getRequirementById(reqId);
  if (!after || after.status !== "fix_revision") {
    log.info("fix-runner: req=%s 修复完成但状态已变（%s），不写回", reqId, after?.status ?? "已删除");
    endFixRound(reqId, "done");
    return;
  }

  endFixRound(reqId, "done");

  // 产出可见性：修复总结落需求评论（反馈历史直接展示「改了什么、push 了哪些库」），
  // 不让产出只活在 daemon 日志里。写入失败不阻塞状态流转。
  try {
    createComment({
      id: nextCommentId(),
      requirement_id: reqId,
      kind: "feedback",
      from_role: "agent",
      body: `【修复完成 · 已转回验收】\n\n${summary.slice(0, 8000)}`,
    });
  } catch (e: unknown) {
    log.warn("fix-runner: req=%s 修复总结写评论失败：%s", reqId, (e as Error).message);
  }

  try {
    setRequirementStatus(reqId, "awaiting_review");
    log.info("fix-runner: req=%s 修复完成，转回 awaiting_review。agent 总结：%s",
      reqId, summary.slice(0, 300));
  } catch (e: unknown) {
    log.error("fix-runner: req=%s 转回 awaiting_review 失败：%s", reqId, (e as Error).message);
  }
}

// ──────────────────────────────────────────────
// 事件订阅 + 启动恢复
// ──────────────────────────────────────────────

let _handler: ((event: AutopilotEvent) => void) | null = null;

export function initFixRevisionRunner(): void {
  if (_handler) return;

  _handler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "fix_revision") return;
    runFixRevision(id).catch((e: unknown) => {
      log.error("fix-runner: 触发失败 req=%s: %s", id, (e as Error).message);
    });
  };
  onEvent("requirement:status-changed", _handler);

  // 重启恢复：daemon 挂掉时正在/等待修复的需求会停在 fix_revision，启动时补跑
  const stranded = listRequirements({ status: "fix_revision" });
  for (const r of stranded) {
    log.info("fix-runner: 启动恢复 —— req=%s 停在 fix_revision，补跑修复", r.id);
    runFixRevision(r.id).catch((e: unknown) => {
      log.error("fix-runner: 启动恢复失败 req=%s: %s", r.id, (e as Error).message);
    });
  }

  log.info("fix-revision-runner 已启动（订阅 requirement:status-changed，恢复 %s 条）", stranded.length);
}

export function disposeFixRevisionRunner(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
