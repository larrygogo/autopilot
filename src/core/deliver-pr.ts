/**
 * 声明式 PR 交付（零 TS 工作流的「砖 1」）。
 *
 * 把原 dev/workflow.ts 的 run_submit_pr 逐库 commit→push→开 PR→落 sub_prs 的全部逻辑收进框架。
 * 纯框架动作、零业务知识：调用方（dev 薄壳 / 内置 deliver_pr phase）只负责拼 PR body 上下文
 * 与最终 transition；交付动作本身不知道调用它的 phase 叫什么。
 *
 * 自包含 git/gh helper（runGit / ensurePr）—— dev 的同名 helper 仍被 code_review 等 phase 共用，
 * 故暂不下沉它们；待 dev 全声明式化后 dev 侧副本自然消失。
 */

import { getTask, updateTask } from "./db";
import { updateRequirement } from "./requirements";
import { appendSubPr } from "./requirement-sub-prs";
import { agentForPhase } from "../agents/registry";
import { listTaskRepos, type TaskRepoCtx } from "./sandbox";
import { getCurrentSandboxDir } from "./task-context";
import { createLogger } from "./logger";

const log = createLogger("deliver-pr");

function runGit(
  args: string[],
  cwd: string,
  check = true,
): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
  const exitCode = proc.exitCode ?? 0;
  if (check && exitCode !== 0) {
    throw new Error(`git 命令失败：git ${args.join(" ")}\nstderr: ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

/** gh pr view 判 OPEN 复用（pr edit）/ 否则 create。失败抛错（调用方按库聚合）。 */
function ensurePr(repo: TaskRepoCtx, title: string, prBody: string): string {
  const existingPr = Bun.spawnSync(["gh", "pr", "view", "--json", "url,state"], {
    cwd: repo.path,
    stderr: "pipe",
  });
  const existingOut = new TextDecoder().decode(existingPr.stdout ?? new Uint8Array()).trim();
  let parsedExisting: { url?: string; state?: string } | null = null;
  if (existingPr.exitCode === 0 && existingOut) {
    try {
      parsedExisting = JSON.parse(existingOut) as { url?: string; state?: string };
    } catch {
      parsedExisting = null;
    }
  }
  if (parsedExisting && parsedExisting.state === "OPEN") {
    Bun.spawnSync(["gh", "pr", "edit", "--body", prBody], { cwd: repo.path });
    return parsedExisting.url ?? "";
  }
  const createProc = Bun.spawnSync(
    ["gh", "pr", "create", "--title", title, "--body", prBody, "--base", repo.base, "--head", repo.branch],
    { cwd: repo.path, stderr: "pipe" },
  );
  if (createProc.exitCode !== 0) {
    const errMsg = new TextDecoder().decode(createProc.stderr ?? new Uint8Array()).trim();
    throw new Error(`创建 PR 失败：${errMsg}`);
  }
  return new TextDecoder().decode(createProc.stdout ?? new Uint8Array()).trim();
}

/** 任务的仓库布局（与 dev taskRepos 等价）：listTaskRepos 为准，极旧任务无 meta 时用 sandbox 兜底单库。 */
function resolveRepos(taskId: string, task: NonNullable<ReturnType<typeof getTask>>): TaskRepoCtx[] {
  const repos = listTaskRepos(taskId);
  if (repos.length > 0) return repos;
  const p = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  return [
    {
      workspace_id: "",
      alias: "",
      path: p,
      dir: "",
      primary: true,
      branch: task["branch"] as string,
      base: (task["default_branch"] as string) ?? "main",
      remote_url: null,
    },
  ];
}

export interface DeliverPrOpts {
  /** 用哪个 phase 的内联 agent 生成 PR body；缺省 "submit_pr"（不存在则走 DEFAULT_AGENT）。 */
  agentPhase?: string;
  /** 拼进 PR body「技术方案摘要」的上下文（dev 传 plan.md；声明式可传 handoff 汇总）。缺省仅用 diff stat。 */
  prBodyContext?: string;
  /** commit / PR 标题；缺省 task.title。 */
  title?: string;
}

export interface DeliverPrResult {
  /** 本次成功交付的 PR url（第一个 = 主显示）。 */
  prUrls: string[];
}

/**
 * 逐库交付：commit → push → 开/复用 PR → 落 sub_prs + 回填 task/requirement.pr_url。
 * **不做状态机 transition**（调用方负责）。部分失败 = 已开 PR 落库保留 + 抛错停下报人。
 */
export async function deliverPr(taskId: string, opts: DeliverPrOpts = {}): Promise<DeliverPrResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repos = resolveRepos(taskId, task);
  const reqId = task["requirement_id"] as string | undefined;
  const title = opts.title ?? (task["title"] as string);
  const planContext = opts.prBodyContext ?? "";
  const agent = agentForPhase(task.workflow as string, opts.agentPhase ?? "submit_pr");

  const results: Array<{ repo: TaskRepoCtx; prUrl: string }> = [];
  const failures: string[] = [];
  for (const r of repos) {
    const label = r.alias || "仓库";
    try {
      runGit(["add", "-A"], r.path);
      const staged = runGit(["diff", "--cached", "--quiet", `origin/${r.base}`], r.path, false).exitCode !== 0;
      const ahead = runGit(["rev-list", "--count", `origin/${r.base}..HEAD`], r.path, false).stdout.trim() !== "0";
      if (!staged && !ahead) continue; // 该库无改动 → 不开空 PR
      runGit(["commit", "-m", `feat: ${title}`], r.path, false);
      runGit(["push", "-u", "origin", r.branch], r.path);

      const diffStat = runGit(["diff", `origin/${r.base}...HEAD`, "--stat"], r.path).stdout.slice(0, 3000);
      const multiNote =
        repos.length > 1
          ? `\n\n（本需求共涉及 ${repos.length} 个仓库的交付，当前是 ${label}；交付 PR 全集见 autopilot 需求页）`
          : "";
      const prPrompt =
        `请根据以下信息生成 PR 描述（Markdown 格式）：\n\n` +
        `## 标题\n${title}\n\n` +
        `## 技术方案摘要\n${planContext.slice(0, 4000)}\n\n` +
        `## 变更统计\n${diffStat}\n\n` +
        `请输出完整的 PR body，包含：概述、主要变更、测试说明。${multiNote}`;
      const prResult = await agent.run(prPrompt, { cwd: r.path, timeout: 300_000 });

      const prUrl = ensurePr(r, title, prResult.text);
      results.push({ repo: r, prUrl });

      if (r.workspace_id && reqId) {
        const n = Number(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 0);
        try {
          appendSubPr({ requirement_id: reqId, child_workspace_id: r.workspace_id, pr_url: prUrl, pr_number: n });
        } catch (e: unknown) {
          log.warn("记录交付 PR 失败 [%s]：%s", label, e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e: unknown) {
      failures.push(`[${label}] ${(e as Error).message}`);
    }
  }

  if (results.length === 0 && failures.length === 0) {
    throw new Error("所有仓库均无改动，没有可交付内容");
  }
  if (failures.length > 0) {
    throw new Error(`部分仓库交付失败（已成功 ${results.length} 个，其 PR 已保留）：\n${failures.join("\n")}`);
  }

  const primaryPr = results.find((x) => x.repo.primary) ?? results[0];
  updateTask(taskId, { pr_url: primaryPr.prUrl });
  if (reqId) {
    const m = primaryPr.prUrl.match(/\/pull\/(\d+)/);
    try {
      updateRequirement(reqId, { pr_url: primaryPr.prUrl, pr_number: m ? Number(m[1]) : null });
    } catch (e: unknown) {
      log.warn("回填 requirement.pr_url 失败：%s", e instanceof Error ? e.message : String(e));
    }
  }

  return { prUrls: results.map((x) => x.prUrl) };
}
