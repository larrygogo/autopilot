/**
 * dev 工作流阶段函数（TypeScript 版）
 * 完整开发流程：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交
 *
 * 产物路径契约（与 runner 自动归档对齐）：
 * 所有 agent 产物写到 workspace/<NN-phase>/，与框架自动归档的
 * agent-trace.md / phase.log 同目录。NN 是 phase 在 workflow.phases
 * 中的顺序编号，由 getPhaseIndex() 计算。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTask, updateTask } from "@autopilot/core/db";
import { updateRequirement } from "@autopilot/core/requirements";
import { transition, forceTransition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { runInBackground } from "@autopilot/core/runner";
import { agentForPhase } from "@autopilot/agents/registry";
import { getPhaseIndex } from "@autopilot/core/artifacts";
import { getTaskArtifactsDir } from "@autopilot/core/sandbox";
import { getCurrentSandboxDir } from "@autopilot/core/task-context";
import { notify } from "@autopilot/core/notify";

const REVIEW_RESULT_PASS = "REVIEW_RESULT: PASS";
const REVIEW_RESULT_REJECT = "REVIEW_RESULT: REJECT";

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

function getRejectionCounts(task: ReturnType<typeof getTask>): Record<string, number> {
  if (!task) return {};
  const raw = (task["rejection_counts"] as string | undefined) ?? "{}";
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * 计算指定 phase 的产物目录路径：workspace/<NN-phase>/。不创建目录——
 * 只读场景（检查上一轮产物是否存在）用这个，避免在沙盒里提前长出
 * 还没跑到的阶段的空目录（如 develop 期出现 03-code_review）。
 */
function phasePath(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  if (idx < 0) throw new Error(`phase not found in workflow: ${phaseName}`);
  return join(getTaskArtifactsDir(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
}

/**
 * 计算指定 phase 的产物目录：workspace/<NN-phase>/，幂等创建。写产物前调用。
 */
function phaseDir(taskId: string, workflowName: string, phaseName: string): string {
  const dir = phasePath(taskId, workflowName, phaseName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// 任务初始化
// ──────────────────────────────────────────────

export function setup_dev_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  // repo_path / default_branch / branch 由框架按需求绑定的 workspace + git worktree 注入
  // （见 task-factory.ts）。这里只回传业务字段，不再从 config 读写死路径。
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
  };
}

// ──────────────────────────────────────────────
// 阶段函数
// ──────────────────────────────────────────────

export async function run_design(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  // worktree 模式：sandbox 已 checkout 在基于 default_branch 派生的独立分支上，
  // 无需再 checkout/pull（worktree 不能 checkout 主仓库已占用的 default_branch）。

  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();
  if (!requirement) {
    throw new Error("任务 requirement 字段为空，请在创建任务时提供需求描述");
  }

  // 驳回历史：上一次 reviewer 驳回意见
  let rejectionHistory = "";
  const reviewDir = phasePath(taskId, task.workflow, "review");
  const reviewPath = join(reviewDir, "plan_review.md");
  const rejectionCounts = getRejectionCounts(task);
  const designRejections = rejectionCounts["design"] ?? 0;
  if (existsSync(reviewPath) && designRejections > 0) {
    const prevReview = readFileSync(reviewPath, "utf-8");
    rejectionHistory = `\n\n## 上一次评审的驳回意见（第${designRejections}次驳回）\n${prevReview}`;
  }

  const prompt =
    `你是一位资深架构师。请根据以下需求，生成一份完整的技术方案。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 仓库路径\n${repoPath}\n\n` +
    `请先阅读仓库代码了解项目结构，然后输出包含以下内容的技术方案：\n` +
    `1. 需求分析\n2. 技术方案\n3. 实现步骤\n4. 影响范围\n5. 测试计划` +
    rejectionHistory;

  const agent = agentForPhase(task.workflow, "design");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 900_000 });

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  writeFileSync(planPath, `<!-- generated:${new Date().toISOString()} -->\n${result.text}`, "utf-8");

  transition(taskId, "design_complete", {
    transitions: getTransitions(task.workflow),
    note: "方案设计完成",
  });
  runInBackground(taskId, "review");
}

export async function run_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = getCurrentSandboxDir() ?? (task["repo_path"] as string);

  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");
  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();

  const prompt =
    `你是一位技术评审专家。请评审以下技术方案是否满足需求。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `请从以下维度评审：完整性、可行性、风险点、测试覆盖。\n\n` +
    `最后必须输出以下结论之一（独占一行）：\n` +
    `- ${REVIEW_RESULT_PASS}\n` +
    `- ${REVIEW_RESULT_REJECT}\n\n` +
    `如果驳回，请在 ## 驳回理由 下说明具体问题。`;

  const agent = agentForPhase(task.workflow, "review");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 900_000 });
  const text = result.text;

  const reviewPath = join(phaseDir(taskId, task.workflow, "review"), "plan_review.md");
  writeFileSync(reviewPath, `<!-- generated:${new Date().toISOString()} -->\n${text}`, "utf-8");

  const passed = text.includes(REVIEW_RESULT_PASS);
  const rejected = text.includes(REVIEW_RESULT_REJECT);
  const transitions = getTransitions(task.workflow);

  if (passed) {
    transition(taskId, "review_complete", { transitions, note: "方案评审通过" });
    runInBackground(taskId, "develop");
  } else if (rejected) {
    const reasonMatch = text.match(/## 驳回理由\n([\s\S]*?)(?=\n## |\s*$)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : "请查看评审报告";
    const rejectionCounts = getRejectionCounts(task);
    const newCount = (rejectionCounts["design"] ?? 0) + 1;
    rejectionCounts["design"] = newCount;

    const wf = getWorkflow(task.workflow);
    const reviewPhase = wf?.phases.find(
      (p) => !("parallel" in p) && (p as { name: string }).name === "review"
    ) as { max_rejections?: number } | undefined;
    const maxRejections = reviewPhase?.max_rejections ?? 3;

    if (newCount >= maxRejections) {
      // 触顶 = 停下报人：转 failed（可重试终态，用户补约束后可一键重新入队），
      // 不再 cancel（cancelled 是死终态，会把「撞墙需要人介入」表达成「用户不想要了」）。
      try {
        await notify(
          task,
          `方案评审反复驳回 ${newCount} 次（≥ ${maxRejections}），任务已暂停等待人工处理。最近一次理由：${reason.slice(0, 200)}`,
          "task-failed",
        );
      } catch { /* notify 失败不阻塞 */ }
      // forceTransition 不带 extraUpdates，先落 extra（驳回详情供 bridge 沉淀回需求评论）
      updateTask(taskId, { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason });
      forceTransition(taskId, "failed", `方案评审驳回 ${newCount} 次，已暂停等待人工处理`);
    } else {
      transition(taskId, "review_reject", {
        transitions,
        note: `方案评审驳回（第${newCount}次）`,
        extraUpdates: { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason },
      });
      transition(taskId, "retry_design", { transitions, note: `自动重新设计（第${newCount}次驳回）` });
      runInBackground(taskId, "design");
    }
  } else {
    throw new Error("无法解析评审结论，请检查报告");
  }
}

export async function run_develop(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  // worktree 模式：sandbox 是基于 default_branch 派生的独立分支工作树，工作树天然
  // 干净、已在自己的分支（autopilot/<taskId>）上 —— 无需 checkout/pull/stash/建分支。

  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  // reject 重做时把上一轮 code_review 反馈拼进 prompt — dogfood-bug7：
  // 之前 prompt 只含 plan.md，reject 重做时 developer 看到 commit 已存在
  // 就回答"任务已完成无需额外工作"，反复 reject 直到 max_rejections。
  // 现在显式告诉 developer 这是 reject 重做轮 + 上轮 reviewer 的具体抱怨，
  // 让它知道要去 specifically address critical 问题。
  const codeReviewReportPath = join(
    phasePath(taskId, task.workflow, "code_review"),
    "code_review_report.md",
  );
  const hasPriorReview = existsSync(codeReviewReportPath);
  const priorReviewContent = hasPriorReview ? readFileSync(codeReviewReportPath, "utf-8") : "";

  const prompt = hasPriorReview
    ? `你是一位高级开发工程师。**这是 reject 重做轮** —— 上一轮你的提交被代码审查打回，需要根据 review 反馈修改代码。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `## 上一轮代码审查反馈（必须 address 所有 Critical 问题）\n${priorReviewContent}\n\n` +
      `注意：上一轮你的改动已在工作树里（未提交，共用沙盒会保留）。**不要因为"已经改过"就回答"任务已完成"** — review 明确指出了需要补充/修改的具体内容，你必须在现有改动基础上**继续修改**（修文件、补字段、删冗余等），直接改文件即可、**不要自己 git commit**（提交由 submit_pr 阶段统一做）。代码可编译、可运行。`
    : `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。`;

  const agent = agentForPhase(task.workflow, "develop");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });
  const reportPath = join(phaseDir(taskId, task.workflow, "develop"), "dev_report.md");
  writeFileSync(reportPath, `<!-- generated:${new Date().toISOString()} -->\n${result.text}`, "utf-8");

  // 共用沙盒模型：改动直接留在共用 clone 的工作树（不 commit），下游 phase 共用同一 clone
  // 直接看到；submit_pr 才 git add -A && commit && push。

  transition(taskId, "develop_complete", {
    transitions: getTransitions(task.workflow),
    note: "开发完成",
  });
  runInBackground(taskId, "code_review");
}

export async function run_code_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  const defaultBranch = (task["default_branch"] as string) ?? "main";
  // 共用沙盒：develop 改动留在工作树（可能含 commit / 新建文件）。先 add -A 纳入未跟踪新文件，
  // 再 diff --cached <base> 看相对 base 的全量改动 —— 覆盖 committed + 未提交 + 新建，不依赖
  // agent 把改动留成什么状态。否则 agent 一 commit 或新建文件，工作树 vs HEAD 的 diff 就看空 →
  // code_review 误判"变更未实现"反复驳回 → 任务 cancelled（即焚的 reset -q 归一层删掉后的回归）。
  runGit(["add", "-A"], repoPath);
  // base 用 origin/<branch>：clone 后远程跟踪 ref 对默认+非默认分支都在（本地只建了默认分支）。
  const diffResult = runGit(["diff", "--cached", "--no-ext-diff", `origin/${defaultBranch}`], repoPath);
  const fullDiffLen = diffResult.stdout.length;
  const DIFF_CAP = 80000;
  const gitDiff = diffResult.stdout.slice(0, DIFF_CAP);
  const diffTruncated = fullDiffLen > DIFF_CAP;
  // 全量 stat（很小）给 reviewer 文件级全景——大改动 diff 截断时，排在尾部的文件
  // （迁移/前端组件等）会整个消失，reviewer 盲判「未实现」三连驳（dogfood：req-011
  // 第三轮 108KB diff，被指「缺失」的 migration/上传组件全都存在，只是被切掉了）。
  const statResult = runGit(["diff", "--cached", "--stat", `origin/${defaultBranch}`], repoPath);
  const gitDiffStat = statResult.stdout.slice(0, 8000);

  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  const truncationNotice = diffTruncated
    ? `\n\n⚠ **注意：完整 diff 共 ${Math.round(fullDiffLen / 1024)}KB，上面只内联了前 ${Math.round(DIFF_CAP / 1024)}KB**。` +
      `「变更文件全景」里列出但未出现在内联 diff 中的文件**不代表未实现**——你在仓库工作目录里，` +
      `必须用 \`git diff --cached origin/${defaultBranch} -- <文件路径>\` 或 Read 工具自查这些文件的实际改动后再下结论。` +
      `**禁止以「diff 中未见到」为由认定功能缺失或驳回。**`
    : "";

  const prompt =
    `你是一位代码审查专家。请审查以下代码变更是否符合技术方案要求。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `## 变更文件全景（git diff --stat 全量）\n\`\`\`\n${gitDiffStat}\n\`\`\`\n\n` +
    `## 代码变更\n\`\`\`diff\n${gitDiff}\n\`\`\`${truncationNotice}\n\n` +
    `请从以下维度审查：正确性、代码质量、安全性、测试覆盖。\n\n` +
    `最后必须输出以下结论之一（独占一行）：\n` +
    `- ${REVIEW_RESULT_PASS}\n` +
    `- ${REVIEW_RESULT_REJECT}\n\n` +
    `如果驳回，请在 ## 不通过理由 下说明具体问题。`;

  const agent = agentForPhase(task.workflow, "code_review");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_200_000 });
  const text = result.text;

  const reviewPath = join(phaseDir(taskId, task.workflow, "code_review"), "code_review_report.md");
  writeFileSync(reviewPath, `<!-- generated:${new Date().toISOString()} -->\n${text}`, "utf-8");

  const passed = text.includes(REVIEW_RESULT_PASS);
  const rejected = text.includes(REVIEW_RESULT_REJECT);
  const transitions = getTransitions(task.workflow);

  if (passed) {
    transition(taskId, "code_review_complete", { transitions, note: "代码审查通过" });
    runInBackground(taskId, "submit_pr");
  } else if (rejected) {
    const reasonMatch = text.match(/## 不通过理由\n([\s\S]*?)(?=\n## |\s*$)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : "请查看审查报告";
    const rejectionCounts = getRejectionCounts(task);
    const newCount = (rejectionCounts["code"] ?? 0) + 1;
    rejectionCounts["code"] = newCount;

    const wf = getWorkflow(task.workflow);
    const codeReviewPhase = wf?.phases.find(
      (p) => !("parallel" in p) && (p as { name: string }).name === "code_review"
    ) as { max_rejections?: number } | undefined;
    const maxRejections = codeReviewPhase?.max_rejections ?? 3;

    if (newCount >= maxRejections) {
      // 触顶 = 停下报人：转 failed（可重试终态），同 review 触顶分支
      try {
        await notify(
          task,
          `代码审查反复驳回 ${newCount} 次（≥ ${maxRejections}），任务已暂停等待人工处理。最近一次理由：${reason.slice(0, 200)}`,
          "task-failed",
        );
      } catch { /* notify 失败不阻塞 */ }
      updateTask(taskId, { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason });
      forceTransition(taskId, "failed", `代码审查驳回 ${newCount} 次，已暂停等待人工处理`);
    } else {
      transition(taskId, "code_review_reject", {
        transitions,
        note: `代码审查驳回（第${newCount}次）`,
        extraUpdates: { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason },
      });
      transition(taskId, "retry_develop", { transitions, note: `自动返工（第${newCount}次驳回）` });
      runInBackground(taskId, "develop");
    }
  } else {
    throw new Error("无法解析审查结论，请检查报告");
  }
}

export async function run_submit_pr(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = getCurrentSandboxDir() ?? (task["repo_path"] as string);
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  // 共用沙盒：各 phase 的改动已直接累积在工作树，submit_pr 落成交付 commit（空改动时容错不报错）。
  runGit(["add", "-A"], repoPath);
  runGit(["commit", "-m", `feat: ${task.title}`], repoPath, false);
  // 普通 push（不 --force）：重跑时 resetTaskForRerun 已删远程上一轮交付分支（幂等清旧轮，
  // GitHub 自动 close 旧 PR），新一轮 push 到全新分支不会有 non-fast-forward 冲突。
  runGit(["push", "-u", "origin", branch], repoPath);

  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
  // base 用 origin/<branch>：clone 只创建源仓库 HEAD 所指分支，源仓库 checkout 在
  // 非默认分支时本地没有 <defaultBranch> ref，裸引用直接 fatal（与 code_review 同理）。
  const diffStatResult = runGit(["diff", `origin/${defaultBranch}...HEAD`, "--stat"], repoPath);
  const gitDiffStat = diffStatResult.stdout.slice(0, 3000);

  const agent = agentForPhase(task.workflow, "submit_pr");
  const prPrompt =
    `请根据以下信息生成 PR 描述（Markdown 格式）：\n\n` +
    `## 标题\n${task.title}\n\n` +
    `## 技术方案摘要\n${planContent.slice(0, 4000)}\n\n` +
    `## 变更统计\n${gitDiffStat}\n\n` +
    `请输出完整的 PR body，包含：概述、主要变更、测试说明。`;

  const prResult = await agent.run(prPrompt, { cwd: repoPath, timeout: 300_000 });
  const prBody = prResult.text;

  // 检查是否已存在 **OPEN** PR：只有 open 的才复用、更新 body（如 review 驳回返工后再 submit）。
  // closed 的必须建新 —— 重跑会删交付分支触发 GitHub 自动 close 旧 PR，gh pr view 仍会返回这个
  // closed PR；若不判 state 就会把改动"更新"到已关闭的 PR 上，等于重跑跑完却没有有效 open PR。
  const existingPr = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "url,state"],
    { cwd: repoPath, stderr: "pipe" }
  );
  const existingOut = new TextDecoder().decode(existingPr.stdout ?? new Uint8Array()).trim();

  let prUrl: string;
  let parsedExisting: { url?: string; state?: string } | null = null;
  if (existingPr.exitCode === 0 && existingOut) {
    try { parsedExisting = JSON.parse(existingOut) as { url?: string; state?: string }; } catch { parsedExisting = null; }
  }
  if (parsedExisting && parsedExisting.state === "OPEN") {
    prUrl = parsedExisting.url ?? "";
    Bun.spawnSync(["gh", "pr", "edit", "--body", prBody], { cwd: repoPath });
  } else {
    const createProc = Bun.spawnSync(
      ["gh", "pr", "create", "--title", task.title, "--body", prBody, "--base", defaultBranch, "--head", branch],
      { cwd: repoPath, stderr: "pipe" }
    );
    if (createProc.exitCode !== 0) {
      const errMsg = new TextDecoder().decode(createProc.stderr ?? new Uint8Array()).trim();
      throw new Error(`创建 PR 失败：${errMsg}`);
    }
    prUrl = new TextDecoder().decode(createProc.stdout ?? new Uint8Array()).trim();
  }

  updateTask(taskId, { pr_url: prUrl });

  // 回填 PR 到需求：需求页/产出卡从 requirement.pr_url 读，不回填则"需求做完了看不到 PR"。
  const reqId = task["requirement_id"] as string | undefined;
  if (reqId) {
    const m = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = m ? Number(m[1]) : null;
    try {
      updateRequirement(reqId, { pr_url: prUrl, pr_number: prNumber });
    } catch (e: unknown) {
      console.warn("回填 requirement.pr_url 失败：", e instanceof Error ? e.message : e);
    }
  }

  // clone 沙盒是独立副本，无需切回 default branch（源仓库与主机 cwd 都不受影响）。

  transition(taskId, "submit_pr_complete", {
    transitions: getTransitions(task.workflow),
    note: `PR 已提交：${prUrl}`,
  });
}
