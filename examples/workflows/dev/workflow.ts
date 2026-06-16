/**
 * dev 工作流阶段函数（TypeScript 版）
 *
 * 执行模式（2026-06 起）：design / review / develop / code_review 四个 agent 阶段已全部
 * 「纯提示词」——prompt 写在 workflow.yaml，由框架内置 prompt-runner 驱动，本文件不再有它们的
 * run_ 函数（提示词优先全局生效，有 prompt 的 phase 一律走 prompt-runner）。
 *
 * 本文件只保留两段「框架给不了、必须工作流自己写」的逻辑：
 *   - setup_dev_task：任务初始化（回传业务字段）；
 *   - run_submit_pr：机械交付（逐库 commit/push + gh 开 PR + appendSubPr 登记），无 AI。
 *     submit_pr 在 yaml 里没有 prompt 字段，故回退到这里的同名 ts 函数。
 *
 * 产物路径契约：prompt-runner 把各阶段 agent 产物写到 artifacts/<NN-phase>/agent_output.md。
 * submit_pr 据此读 design 阶段的 agent_output.md 作 PR body 的方案摘要。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getTask, updateTask } from "@autopilot/core/db";
import { updateRequirement } from "@autopilot/core/requirements";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/workflow/registry";
import { getPhaseIndex } from "@autopilot/core/artifacts";
import { getTaskArtifactsDir, listTaskRepos, type TaskRepoCtx } from "@autopilot/core/sandbox";
import { appendSubPr } from "@autopilot/core/requirements/sub-prs";
import { getCurrentSandboxDir } from "@autopilot/core/task/context";

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

function runGit(args: string[], cwd: string, check = true): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
  const exitCode = proc.exitCode ?? 0;
  if (check && exitCode !== 0) {
    throw new Error(`git 命令失败：git ${args.join(" ")}\nstderr: ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

function getTransitions(workflowName: string) {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`工作流不存在：${workflowName}`);
  return buildTransitions(wf);
}

/**
 * 任务的代码仓库布局（统一 multi-clone：每库 clone 到 ./alias/ 子目录，单库也是；
 * 旧 mode=clone 任务为单项指向 workspace/ 根）。
 * 单一真相在 .worktree.json（listTaskRepos 读），极旧任务无 meta 时用 extra 拼单库兜底。
 */
function taskRepos(taskId: string, task: NonNullable<ReturnType<typeof getTask>>): TaskRepoCtx[] {
  const repos = listTaskRepos(taskId);
  if (repos.length > 0) return repos;
  const p = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  return [{
    workspace_id: "",
    alias: "",
    path: p,
    dir: "",
    primary: true,
    branch: task["branch"] as string,
    base: (task["default_branch"] as string) ?? "main",
    remote_url: null,
  }];
}

/**
 * 计算指定 phase 的产物目录路径：artifacts/<NN-phase>/。只读场景（读上游产物）用这个。
 */
function phasePath(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  if (idx < 0) throw new Error(`phase not found in workflow: ${phaseName}`);
  return join(getTaskArtifactsDir(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
}

// ──────────────────────────────────────────────
// 任务初始化
// ──────────────────────────────────────────────

export function setup_dev_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  // repo_path / default_branch / branch 由框架按需求绑定的 workspace + git 沙盒注入
  // （见 task-factory.ts）。这里只回传业务字段，不再从 config 读写死路径。
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
  };
}

// ──────────────────────────────────────────────
// 交付阶段（机械，无 AI）
// ──────────────────────────────────────────────

/**
 * gh pr view 判 OPEN 复用（pr edit）/ 否则 create。失败抛错（调用方按库聚合）。
 * 「怎么交付 = 开 GitHub PR」是本工作流（dev）的选择（肉）；框架只给沙盒 + git/gh + 追踪原语。
 */
function ensurePr(repo: TaskRepoCtx, title: string, prBody: string): string {
  const existing = Bun.spawnSync(["gh", "pr", "view", "--json", "url,state"], { cwd: repo.path, stderr: "pipe" });
  const out = new TextDecoder().decode(existing.stdout ?? new Uint8Array()).trim();
  let parsed: { url?: string; state?: string } | null = null;
  if (existing.exitCode === 0 && out) {
    try { parsed = JSON.parse(out) as { url?: string; state?: string }; } catch { parsed = null; }
  }
  if (parsed && parsed.state === "OPEN") {
    Bun.spawnSync(["gh", "pr", "edit", "--body", prBody], { cwd: repo.path });
    return parsed.url ?? "";
  }
  const created = Bun.spawnSync(
    ["gh", "pr", "create", "--title", title, "--body", prBody, "--base", repo.base, "--head", repo.branch],
    { cwd: repo.path, stderr: "pipe" },
  );
  if (created.exitCode !== 0) {
    throw new Error(`创建 PR 失败：${new TextDecoder().decode(created.stderr ?? new Uint8Array()).trim()}`);
  }
  return new TextDecoder().decode(created.stdout ?? new Uint8Array()).trim();
}

export async function run_submit_pr(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  // 交付动作（逐库 commit/push/开 GitHub PR）是本工作流的肉——直接在这写。
  // 框架只提供：沙盒（含 git clone + token）、git/gh、追踪原语 appendSubPr / updateRequirement.pr_url。
  // design 阶段（纯 prompt）产物落 agent_output.md，用作 PR body 的方案摘要。
  const designOutputPath = join(phasePath(taskId, task.workflow, "design"), "agent_output.md");
  const planContext = existsSync(designOutputPath) ? readFileSync(designOutputPath, "utf-8") : "";

  const repos = taskRepos(taskId, task);
  const reqId = task["requirement_id"] as string | undefined;
  const title = task["title"] as string;
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
        repos.length > 1 ? `\n\n（本需求共 ${repos.length} 个仓库交付，当前 ${label}；全集见需求页）` : "";
      const prBody =
        (planContext.trim() ? `## 技术方案摘要\n\n${planContext.slice(0, 8000)}\n\n` : "") +
        `## 变更统计\n\n\`\`\`\n${diffStat || "（无 diff stat）"}\n\`\`\`` +
        multiNote;

      const prUrl = ensurePr(r, title, prBody);
      results.push({ repo: r, prUrl });

      // 框架追踪原语：登记交付的 PR（pr-poller 据此聚合验收）
      if (r.workspace_id && reqId) {
        const n = Number(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 0);
        try {
          appendSubPr({ requirement_id: reqId, child_workspace_id: r.workspace_id, pr_url: prUrl, pr_number: n });
        } catch { /* best-effort */ }
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

  const primaryPr = results.find((x) => x.repo.primary) ?? results[0]!;
  updateTask(taskId, { pr_url: primaryPr.prUrl });
  if (reqId) {
    const m = primaryPr.prUrl.match(/\/pull\/(\d+)/);
    try {
      updateRequirement(reqId, { pr_url: primaryPr.prUrl, pr_number: m ? Number(m[1]) : null });
    } catch { /* best-effort */ }
  }

  transition(taskId, "submit_pr_complete", {
    transitions: getTransitions(task.workflow),
    note: `PR 已提交：${results.map((x) => x.prUrl).join(" , ")}`,
  });
}
