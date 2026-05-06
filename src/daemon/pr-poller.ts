import {
  listRequirements,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
} from "../core/requirements";
import { appendFeedback } from "../core/requirement-feedbacks";
import { getRepoById } from "../core/repos";
import { loadGithubConfig } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("pr-poller");

interface GhReview {
  id: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  author?: { login?: string };
  submittedAt?: string;
}

interface GhPrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  reviews: GhReview[];
  mergeCommit?: { oid: string } | null;
}

/**
 * gh 调用接口（依赖注入用，测试可替换）
 */
export type GhRunner = (args: string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const defaultGhRunner: GhRunner = async (args) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
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

/**
 * 单需求轮询：拉 PR → 处理 merge / new reviews。
 *
 * 为什么 export：测试需要直接调用。
 */
export async function pollOne(reqId: string, cli: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "awaiting_review") return;
  if (!req.pr_number) {
    log.warn("requirement %s 无 pr_number，跳过", reqId);
    return;
  }
  const repo = getRepoById(req.repo_id);
  if (!repo || !repo.github_owner || !repo.github_repo) {
    log.warn(
      "requirement %s 关联 repo 缺 github_owner/repo，跳过（请先在 /repos 健康检查回填）",
      reqId,
    );
    return;
  }

  const data = await ghPrView(cli, repo.github_owner, repo.github_repo, req.pr_number);
  if (!data) return; // gh 调用失败，下周期重试

  // 1. 检查 merged
  if (data.state === "MERGED" || data.mergeCommit) {
    log.info("requirement %s PR #%s merged，转 done", reqId, req.pr_number);
    try {
      setRequirementStatus(reqId, "done");
    } catch (e: unknown) {
      log.warn("requirement %s 转 done 失败：%s", reqId, (e as Error).message);
    }
    return;
  }

  // 2. 检查新 CHANGES_REQUESTED review
  const changes = data.reviews
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .filter((r) => !req.last_reviewed_event_id || r.id > req.last_reviewed_event_id);

  if (changes.length === 0) return;

  // 拼合反馈正文（多条 review 合并到一次 fix_revision 处理）
  const body = changes
    .map((r) => `## ${r.author?.login ?? "unknown"}\n\n${r.body || "(无评论正文)"}`)
    .join("\n\n---\n\n");
  const latestId = changes[changes.length - 1].id;

  log.info(
    "requirement %s 收到 %s 条新 CHANGES_REQUESTED review，注入反馈触发 fix_revision",
    reqId,
    changes.length,
  );

  appendFeedback({
    requirement_id: reqId,
    source: "github_review",
    body,
    github_review_id: latestId,
  });

  // 更新 last_reviewed_event_id 去重
  updateRequirement(reqId, { last_reviewed_event_id: latestId });

  // 触发 fix_revision（跟 P3 手动注入路径一致）
  try {
    setRequirementStatus(reqId, "fix_revision");
  } catch (e: unknown) {
    log.warn("requirement %s 转 fix_revision 失败：%s", reqId, (e as Error).message);
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
    "reviews,state,mergeCommit",
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
