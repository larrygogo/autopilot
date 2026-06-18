/**
 * 框架内置「PR 交付器」——把 dev 的 submit_pr（逐库 commit/push + gh 开 PR + appendSubPr 登记）
 * 从用户 workflow.ts 收编成框架内置受信任交付器。用户工作流在 phase 上声明 `deliver: pr`
 * （可选 `pr_body_from: <phase>` 取某阶段 agent 产物作 PR body 方案摘要）即可，**不写 ts**。
 *
 * 这是唯一含 spawn(git/gh) 的内置交付器——但它是**框架受信任代码**（与 __fix 的 FIXER 同级），
 * 不是用户 ts，不违反「DB 不存可 eval 代码」红线：能力上界由框架钉死、用户只声明 delivers:pr。
 *
 * 触发：bindPhaseFunc 见 phase.deliver === "pr" 就绑本模块（与 artifacts deliver 对称）。
 * 闭包内动态 import 破循环：bindPhaseFunc(registry) 静态 import 本模块，本模块的运行时重依赖
 * （registry/db/requirements…）一律延迟到运行时取（同 artifacts deliverer 范式）。
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { TaskRepoCtx } from "../sandbox";

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

/** gh pr view 判 OPEN 复用（pr edit）/ 否则 create。失败抛错（调用方按库聚合）。 */
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

/**
 * 生成 PR 交付器 runner。phaseName = 声明 deliver:pr 的阶段名（用于 transition 触发 ${phaseName}_complete）；
 * opts.bodyFromPhase = 取哪个阶段的 agent 产物（artifacts/<NN-phase>/agent_output.md）作 PR body 方案摘要。
 */
export function makePrDeliverRunner(
  phaseName: string,
  opts: { bodyFromPhase?: string } = {},
): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const { getTask, updateTask } = await import("../db");
    const { updateRequirement } = await import("../requirements");
    const { transition } = await import("../state-machine");
    const { getWorkflow, buildTransitions } = await import("./registry");
    const { getPhaseIndex } = await import("../artifacts");
    const { getTaskArtifactsDir, listTaskRepos } = await import("../sandbox");
    const { appendSubPr } = await import("../requirements/sub-prs");
    const { getCurrentSandboxDir } = await import("../task/context");

    const task = getTask(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    const wf = getWorkflow(task.workflow);
    if (!wf) throw new Error(`工作流不存在：${task.workflow}`);

    // 可选：取 bodyFromPhase 阶段的 agent 产物作 PR body 方案摘要（dev 用 design）；未配/缺产物则只放 diff stat
    let planContext = "";
    if (opts.bodyFromPhase) {
      const idx = getPhaseIndex(wf, opts.bodyFromPhase);
      if (idx >= 0) {
        const p = join(getTaskArtifactsDir(taskId), `${String(idx).padStart(2, "0")}-${opts.bodyFromPhase}`, "agent_output.md");
        if (existsSync(p)) planContext = readFileSync(p, "utf-8");
      }
    }

    // 任务代码仓库布局（统一 multi-clone）；极旧任务无 meta 时用沙盒根兜底单库
    let repos = listTaskRepos(taskId);
    if (repos.length === 0) {
      const p = getCurrentSandboxDir() ?? (task["repo_path"] as string);
      repos = [{
        workspace_id: "", alias: "", path: p, dir: "", primary: true,
        branch: task["branch"] as string, base: (task["default_branch"] as string) ?? "main", remote_url: null,
      }];
    }

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

    transition(taskId, `${phaseName}_complete`, {
      transitions: buildTransitions(wf),
      note: `PR 已提交：${results.map((x) => x.prUrl).join(" , ")}`,
    });
  };
}
