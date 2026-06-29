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
import { submitPrPure, type ExecRepo } from "./submit-pr";

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
    let taskRepos: TaskRepoCtx[] = listTaskRepos(taskId);
    if (taskRepos.length === 0) {
      const p = getCurrentSandboxDir() ?? (task["repo_path"] as string);
      taskRepos = [{
        workspace_id: "", alias: "", path: p, dir: "", primary: true,
        branch: task["branch"] as string, base: (task["default_branch"] as string) ?? "main", remote_url: null,
      }];
    }

    const reqId = task["requirement_id"] as string | undefined;
    const title = task["title"] as string;
    const totalRepos = taskRepos.length;

    // 构造 ExecRepo[]：remote_url 为 null 时传 "origin"（git push 会把它当 remote 别名，
    // 与原来的 `git push -u origin <branch>` 功能等价——少 `-u` upstream tracking，
    // 当前沙盒一次性交付不依赖 tracking branch；token=null 不碰 remoteUrl）
    const execRepos: ExecRepo[] = taskRepos.map((r) => ({
      path: r.path,
      remoteUrl: r.remote_url ?? "origin",
      branch: r.branch,
      base: r.base,
      primary: r.primary,
      label: r.alias || "仓库",
    }));

    // 调 submitPrPure 纯核：commit+push+PR，无 DB 副作用
    const { results, failures } = await submitPrPure(execRepos, {
      title,
      bodyFor: (repo, diffStatText) => {
        const label = repo.label;
        const multiNote =
          totalRepos > 1 ? `\n\n（本需求共 ${totalRepos} 个仓库交付，当前 ${label}；全集见需求页）` : "";
        return (
          (planContext.trim() ? `## 技术方案摘要\n\n${planContext.slice(0, 8000)}\n\n` : "") +
          `## 变更统计\n\n\`\`\`\n${diffStatText || "（无 diff stat）"}\n\`\`\`` +
          multiNote
        );
      },
      // gitToken=null：保持既有行为（push 靠环境 gh + clone 时写进 .git 的 origin、PR 靠 gh 环境）；
      // 不传 openPr → submitPrPure 默认走 openOrUpdatePr(path, {title,body,base,head}, gitToken)。
      // A2 接 runner 时只需把 gitToken 改成 vend token，push 与 PR 同时拿到，无需再改注入闭包。
      gitToken: null,
    });

    if (results.length === 0 && failures.length === 0) {
      throw new Error("所有仓库均无改动，没有可交付内容");
    }
    if (failures.length > 0) {
      throw new Error(`部分仓库交付失败（已成功 ${results.length} 个，其 PR 已保留）：\n${failures.join("\n")}`);
    }

    // DB 副作用层：登记交付 PR（pr-poller 聚合验收）
    for (const { repo, prUrl, prNumber } of results) {
      // ExecRepo 不携带 workspace_id，按 path 反查回 TaskRepoCtx 取 workspace_id 给 appendSubPr
      const taskRepo = taskRepos.find((r) => r.path === repo.path);
      if (taskRepo?.workspace_id && reqId) {
        try {
          appendSubPr({ requirement_id: reqId, child_workspace_id: taskRepo.workspace_id, pr_url: prUrl, pr_number: prNumber });
        } catch { /* best-effort */ }
      }
    }

    const primaryResult = results.find((x) => x.repo.primary) ?? results[0]!;
    updateTask(taskId, { pr_url: primaryResult.prUrl });
    if (reqId) {
      const m = primaryResult.prUrl.match(/\/pull\/(\d+)/);
      try {
        updateRequirement(reqId, { pr_url: primaryResult.prUrl, pr_number: m ? Number(m[1]) : null });
      } catch { /* best-effort */ }
    }

    transition(taskId, `${phaseName}_complete`, {
      transitions: buildTransitions(wf),
      note: `PR 已提交：${results.map((x) => x.prUrl).join(" , ")}`,
    });
  };
}
