import {
  listRequirements,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
} from "../core/requirements";
import { createComment, nextCommentId } from "../core/requirements/comments";
import { listSubPrs, updateSubPrWatermark, updateSubPrCiState } from "../core/requirements/sub-prs";
import { hasDeliveries } from "../core/requirements/deliveries";
import { getWorkspaceById } from "../core/sandbox/workspaces";
import { loadGithubConfig } from "../core/config";
import { emit } from "../core/event-bus";
import { createLogger } from "../core/logger";

const log = createLogger("pr-poller");

/** 同一交付 PR 的 CI 失败自动修复触发上限；触顶后停下报人（通知），防环境性故障空转 */
export const CI_FIX_LIMIT = 2;

interface GhReview {
  id: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  author?: { login?: string };
  submittedAt?: string;
}

/** gh pr view --json statusCheckRollup 数组元素：CheckRun（Actions）或 StatusContext（旧式 status） */
interface GhCheckItem {
  __typename?: "CheckRun" | "StatusContext";
  // CheckRun
  name?: string;
  status?: "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "PENDING" | "WAITING" | "REQUESTED";
  conclusion?: string;
  detailsUrl?: string;
  // StatusContext
  context?: string;
  state?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
  targetUrl?: string;
}

interface GhPrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  reviews: GhReview[];
  mergeCommit?: { oid: string } | null;
  /** PR head commit SHA —— CI 失败水位的去重键（修复 push 新 commit 才可再触发） */
  headRefOid?: string;
  statusCheckRollup?: GhCheckItem[] | null;
}

/** 失败结论集合（CheckRun.conclusion）。CANCELLED/SKIPPED/NEUTRAL/ACTION_REQUIRED 不算 —— 非代码可修信号 */
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);

function checkIsPending(c: GhCheckItem): boolean {
  if (c.__typename === "StatusContext" || c.context !== undefined) {
    return c.state === "PENDING" || c.state === "EXPECTED";
  }
  return c.status !== undefined && c.status !== "COMPLETED";
}

function checkIsFailed(c: GhCheckItem): boolean {
  if (c.__typename === "StatusContext" || c.context !== undefined) {
    return c.state === "FAILURE" || c.state === "ERROR";
  }
  return c.conclusion !== undefined && FAILED_CONCLUSIONS.has(c.conclusion);
}

function checkLabel(c: GhCheckItem): string {
  const name = c.name ?? c.context ?? "unknown-check";
  const url = c.detailsUrl ?? c.targetUrl;
  return url ? `${name}（${url}）` : name;
}

/**
 * gh 调用接口（依赖注入用，测试可替换）
 */
export type GhRunner = (args: string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export const defaultGhRunner: GhRunner = async (args) => {
  // gh 二进制缺失（daemon PATH 与交互 shell 不同，常见于 Windows 服务化启动）时 Bun.spawn
  // 同步抛 ENOENT。捕获成结构化「exit 127」结果，复用 ghPrView 的 exit≠0 → null 优雅降级，
  // 避免裸异常冒泡到 pollAllPRs 兜底 catch 刷含糊「pollOne 失败」warn、丢失真因。
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return {
      exitCode,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } catch (e: unknown) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

let _ghRunner: GhRunner = defaultGhRunner;

/** 测试用：注入 mock gh 实现；传 null 恢复真实实现 */
export function _setGhRunnerForTest(runner: GhRunner | null): void {
  _ghRunner = runner ?? defaultGhRunner;
}

/**
 * 周期入口：扫所有 awaiting_review 需求的 PR，处理 review / merge 状态。
 * 由 daemon scheduler setInterval 触发（默认 5 min）。
 */
export async function pollAllPRs(): Promise<void> {
  const cfg = loadGithubConfig();
  const reqs = listRequirements({ status: "awaiting_review" });
  if (reqs.length === 0) return;

  log.info("pr-poller 周期：扫 %s 个 awaiting_review 需求", reqs.length);

  for (const req of reqs) {
    try {
      await pollOne(req.id, cfg.cli);
    } catch (e: unknown) {
      log.warn("pollOne %s 失败：%s", req.id, (e as Error).message);
    }
  }
}

/** 轮询跟踪项：一个交付 PR（多库 = sub_prs 全集；单库 = 需求主 PR） */
interface TrackedPr {
  prNumber: number;
  wsId: string;
  watermark: string | null;
  /** 水位写回目标：sub → requirement_sub_prs 行；main → requirements.last_reviewed_event_id */
  scope: "sub" | "main";
  label: string;
  /** CI 失败水位（迁移 039，仅 sub 有；main 兼容路径不做 CI 检测） */
  ciFailedSha: string | null;
  ciFixCount: number;
}

/**
 * 单需求轮询（多 PR 聚合）：跟踪集 = sub_prs ∪ 主 PR（按 pr_number 去重——兼容旧
 * submodule 数据：主 PR 不在 sub_prs 时必须并入，否则被排除在判定外）。
 *
 * 聚合判定：
 * - 全部 PR MERGED → done
 * - 任一 PR 新 CHANGES_REQUESTED → 合并反馈一条 comment、转一次 fix_revision（per-PR 水位去重）
 * - 混有 CLOSED（未 merge）→ 维持 awaiting_review 等人处置（close 未 merge 是人的拒收信号）
 *
 * 为什么 export：测试需要直接调用。
 */
export async function pollOne(reqId: string, cli: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "awaiting_review") return;

  const subs = listSubPrs(reqId);
  const tracked: TrackedPr[] = subs
    .filter((sp) => sp.pr_number > 0)
    .map((sp) => ({
      prNumber: sp.pr_number,
      wsId: sp.child_workspace_id,
      watermark: sp.last_reviewed_event_id ?? null,
      scope: "sub" as const,
      label: getWorkspaceById(sp.child_workspace_id)?.alias ?? sp.child_workspace_id,
      ciFailedSha: sp.ci_failed_head_sha ?? null,
      ciFixCount: sp.ci_fix_count ?? 0,
    }));
  if (req.pr_number && req.workspace_id && !tracked.some((t) => t.prNumber === req.pr_number)) {
    tracked.push({
      prNumber: req.pr_number,
      wsId: req.workspace_id,
      watermark: req.last_reviewed_event_id,
      scope: "main",
      label: "",
      ciFailedSha: null,
      ciFixCount: 0,
    });
  }
  if (tracked.length === 0) {
    // artifacts 交付（v2 R5）：有 deliveries 无 PR = 人工验收（Web/CLI 通过/驳回），
    // poller 无事可做 —— 静默 skip，消除 5 分钟一条的 warn 噪音
    if (hasDeliveries(reqId)) return;
    log.warn("requirement %s 无可跟踪 PR（pr_number/sub_prs 均空），跳过", reqId);
    return;
  }

  // 逐 PR 拉状态：任一缺 owner/repo 或 gh 失败 → 本周期放弃该需求的聚合判定（看不全不判，下周期重试）
  const states: Array<{ t: TrackedPr; data: GhPrView }> = [];
  for (const t of tracked) {
    const ws = getWorkspaceById(t.wsId);
    if (!ws || !ws.github_owner || !ws.github_repo) {
      log.warn(
        "requirement %s 的交付 PR #%s 关联 workspace %s 缺 github_owner/repo，本周期跳过聚合判定",
        reqId, t.prNumber, t.wsId,
      );
      return;
    }
    const data = await ghPrView(cli, ws.github_owner, ws.github_repo, t.prNumber);
    if (!data) return; // gh 调用失败，下周期重试
    states.push({ t, data });
  }

  // 1. 全部 merged → done
  const allMerged = states.every((s) => s.data.state === "MERGED" || s.data.mergeCommit);
  if (allMerged) {
    log.info("requirement %s 全部 %s 个交付 PR 已 merge，转 done", reqId, states.length);
    try {
      setRequirementStatus(reqId, "done");
    } catch (e: unknown) {
      log.warn("requirement %s 转 done 失败：%s", reqId, (e as Error).message);
    }
    return;
  }

  // 2. 新 CHANGES_REQUESTED：逐 PR 按各自水位过滤；同周期多 PR 反馈合并成一条、只转一次 fix_revision
  const sections: string[] = [];
  const watermarkUpdates: Array<{ t: TrackedPr; latest: string }> = [];
  let totalChanges = 0;
  for (const s of states) {
    const changes = s.data.reviews
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .filter((r) => !s.t.watermark || r.id > s.t.watermark);
    if (changes.length === 0) continue;
    totalChanges += changes.length;
    const tag = s.t.label ? `[${s.t.label}] ` : "";
    sections.push(
      changes
        .map((r) => `## ${tag}${r.author?.login ?? "unknown"}\n\n${r.body || "(无评论正文)"}`)
        .join("\n\n---\n\n"),
    );
    watermarkUpdates.push({ t: s.t, latest: changes[changes.length - 1].id });
  }

  // 3. CI / PR check 失败 → 自动修复回路（仅 scope=sub：迁移 039 水位列在 sub_prs 上；
  //    旧 main-scope 兼容路径无水位落点，跳过——新需求主 PR 已全集落 sub_prs）。
  //    触发条件：PR OPEN + checks 全部完成 + 有失败 + head SHA ≠ 已处理水位。
  //    护栏：同 PR 自动修复 CI_FIX_LIMIT 次后停下报人（通知），不再自动转 fix_revision。
  const ciSections: string[] = [];
  const ciStateUpdates: Array<{ t: TrackedPr; sha: string }> = [];
  for (const s of states) {
    if (s.t.scope !== "sub") continue;
    if (s.data.state !== "OPEN") continue;
    const checks = s.data.statusCheckRollup ?? [];
    if (checks.length === 0) continue;
    if (checks.some(checkIsPending)) continue; // 跑完再判，一次拿到全部失败清单
    const failed = checks.filter(checkIsFailed);
    if (failed.length === 0) continue;
    const sha = s.data.headRefOid;
    if (!sha || s.t.ciFailedSha === sha) continue; // 该 head SHA 已处理过

    const failedList = failed.map((c) => `- ${checkLabel(c)}`).join("\n");
    if (s.t.ciFixCount >= CI_FIX_LIMIT) {
      // 触顶：写 SHA 水位（同 SHA 不重复通知）+ 停下报人
      updateSubPrCiState(reqId, s.t.wsId, sha, false);
      // rank20：文案标明 ci_fix_count 语义 = 本 PR **生命周期累计**（不按 review/fix 轮重置）。
      // 设计意图 = 防环境性 CI 故障无限空转（迁移 039）；故后续 review 驱动的 fix 后若再 CI 失败、
      // 累计仍 ≥ 上限，会直接走此触顶分支不再自动修——这是有意行为，文案让用户读得懂。
      const reason =
        `本 PR 累计自动修复 CI 已达上限 ${CI_FIX_LIMIT} 次（计数按本 PR 生命周期累计、不按轮重置）仍未转绿，` +
        `不再自动修复——可能是环境性问题，请人工处置。\n失败项：\n${failedList}`;
      log.warn("requirement %s PR #%s CI 自动修复触顶（%s 次），停下报人", reqId, s.t.prNumber, s.t.ciFixCount);
      emit({ type: "requirement:ci-fix-limit", payload: { id: reqId, pr_number: s.t.prNumber, reason } });
      continue;
    }
    const tag = s.t.label ? `[${s.t.label}] ` : "";
    ciSections.push(
      `## ${tag}PR #${s.t.prNumber} 的 CI 检查失败（${failed.length} 项）\n\n` +
      `${failedList}\n\n` +
      `请在交付分支上修复并 push（PR 会自动更新）。可用 \`gh pr checks ${s.t.prNumber}\` / ` +
      `\`gh run view --log-failed\` 查看失败日志。commit ${sha.slice(0, 8)}。`,
    );
    ciStateUpdates.push({ t: s.t, sha });
  }

  if (sections.length === 0 && ciSections.length === 0) return;

  // rank19：line 153 的 awaiting_review 检查在所有 gh await 之前；await 期间他方（人工 reject /
  // bridge）可能已把需求转走（→ fix_revision/done/cancelled）。此时若照旧写 comment + 前移水位，
  // 会把这批 CHANGES_REQUESTED/CI 标记为「已消费」，但下面 setRequirementStatus(fix_revision) 撞
  // cur===to 早返回不抛——水位前移却没真正驱动转换，下一轮不再处理；若抢先的 fix run 未覆盖这批
  // 反馈则永久丢失。故写回前复核当前状态：不再 awaiting_review → 本轮整体放弃（不写 comment/水位/
  // 状态），水位不前移，下一轮在新状态重新评估同一批 review（幂等安全）。
  const fresh = getRequirementById(reqId);
  if (!fresh || fresh.status !== "awaiting_review") {
    log.info("requirement %s pollOne 写回前状态已变（%s），本轮放弃注入、留待下周期重评", reqId, fresh?.status ?? "deleted");
    return;
  }

  log.info(
    "requirement %s：%s 条新 CHANGES_REQUESTED + %s 个 PR 的 CI 失败，注入反馈触发 fix_revision",
    reqId, totalChanges, ciStateUpdates.length,
  );

  // 先转状态（cur 已确认 awaiting_review，到此无 await 不会被并发打断 → 真转换）。转换失败（理论
  // CAS）则不写 comment/水位、下周期重评，反馈不丢——水位前移与状态转换绑定，二者要么都成要么都不成。
  try {
    setRequirementStatus(reqId, "fix_revision");
  } catch (e: unknown) {
    log.warn("requirement %s 转 fix_revision 失败：%s，本轮不写反馈/水位（下周期重评）", reqId, (e as Error).message);
    return;
  }

  createComment({
    id: nextCommentId(),
    requirement_id: reqId,
    kind: "feedback",
    from_role: "github",
    body: [...sections, ...ciSections].join("\n\n---\n\n"),
    github_review_id: watermarkUpdates.length > 0
      ? watermarkUpdates[watermarkUpdates.length - 1].latest
      : undefined,
  });

  // per-PR 水位去重（review 水位 + CI 水位/计数）——状态已成功转换后才前移
  for (const u of watermarkUpdates) {
    if (u.t.scope === "sub") updateSubPrWatermark(reqId, u.t.wsId, u.latest);
    else updateRequirement(reqId, { last_reviewed_event_id: u.latest });
  }
  for (const u of ciStateUpdates) {
    updateSubPrCiState(reqId, u.t.wsId, u.sha, true);
  }
}

/**
 * 调 gh CLI 拉 PR view。统一走 argv 数组（无 shell 注入）；
 * gh 失败时返回 null 让上层下周期重试。
 */
async function ghPrView(
  cli: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GhPrView | null> {
  const args = [
    cli,
    "pr",
    "view",
    String(prNumber),
    "--json",
    "reviews,state,mergeCommit,headRefOid,statusCheckRollup",
    "-R",
    `${owner}/${repo}`,
  ];

  const result = await _ghRunner(args);
  if (result.exitCode !== 0) {
    log.warn(
      "gh pr view %s/%s#%s 失败 (exit %s): %s",
      owner,
      repo,
      prNumber,
      result.exitCode,
      result.stderr.slice(0, 200),
    );
    return null;
  }

  try {
    return JSON.parse(result.stdout) as GhPrView;
  } catch (e: unknown) {
    log.warn("gh pr view 输出 JSON 解析失败：%s", (e as Error).message);
    return null;
  }
}
