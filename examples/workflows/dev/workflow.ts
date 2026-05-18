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
import { homedir } from "os";
import { getTask, updateTask } from "@autopilot/core/db";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { runInBackground } from "@autopilot/core/runner";
import { getAgent } from "@autopilot/agents/registry";
import { getPhaseIndex } from "@autopilot/core/artifacts";
import { getTaskWorkspace } from "@autopilot/core/workspace";

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

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 计算指定 phase 的产物目录：workspace/<NN-phase>/，幂等创建。
 */
function phaseDir(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  if (idx < 0) throw new Error(`phase not found in workflow: ${phaseName}`);
  const dir = join(getTaskWorkspace(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// 任务初始化
// ──────────────────────────────────────────────

export function setup_dev_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  const wf = getWorkflow("dev");
  const config = (wf?.config ?? {}) as Record<string, string>;

  const repoPath = expandPath(config["repo_path"] ?? "");
  const defaultBranch = config["default_branch"] ?? "main";
  const title = args.title ?? "untitled";

  return {
    title,
    requirement: args.requirement ?? "",
    repo_path: repoPath,
    default_branch: defaultBranch,
    branch: `feat/${title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`,
  };
}

// ──────────────────────────────────────────────
// 阶段函数
// ──────────────────────────────────────────────

export async function run_design(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);

  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();
  if (!requirement) {
    throw new Error("任务 requirement 字段为空，请在创建任务时提供需求描述");
  }

  // 驳回历史：上一次 reviewer 驳回意见
  let rejectionHistory = "";
  const reviewDir = phaseDir(taskId, task.workflow, "review");
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

  const agent = getAgent("architect", task.workflow);
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

  const repoPath = task["repo_path"] as string;

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
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

  const agent = getAgent("reviewer", task.workflow);
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
    const maxRejections = reviewPhase?.max_rejections ?? 10;

    if (newCount >= maxRejections) {
      transition(taskId, "cancel", {
        transitions,
        note: `方案评审驳回 ${newCount} 次，已取消`,
        extraUpdates: { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason },
      });
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

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);

  // 用户工作目录保护：develop 阶段开始前若 working tree 有未提交改动，
  // 全部 stash（含 untracked），commit agent 自己的产物后再 pop 回来。
  // 不加这层保护时 git add -A 会把用户散改一并卷入 dogfood commit，污染
  // 下游 code_review 看到的 diff，让 reviewer 抱怨 agent 没写过的代码。
  const dirtyBefore = runGit(["status", "--porcelain"], repoPath).stdout.trim();
  let stashed = false;
  if (dirtyBefore) {
    const stashMsg = `autopilot-pre-develop-${taskId}`;
    runGit(["stash", "push", "--include-untracked", "-m", stashMsg], repoPath);
    stashed = true;
  }

  const checkoutNew = runGit(["checkout", "-b", branch], repoPath, false);
  if (checkoutNew.exitCode !== 0) {
    runGit(["checkout", branch], repoPath);
  }

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  // reject 重做时把上一轮 code_review 反馈拼进 prompt — dogfood-bug7：
  // 之前 prompt 只含 plan.md，reject 重做时 developer 看到 commit 已存在
  // 就回答"任务已完成无需额外工作"，反复 reject 直到 max_rejections。
  // 现在显式告诉 developer 这是 reject 重做轮 + 上轮 reviewer 的具体抱怨，
  // 让它知道要去 specifically address critical 问题。
  const codeReviewReportPath = join(
    phaseDir(taskId, task.workflow, "code_review"),
    "code_review_report.md",
  );
  const hasPriorReview = existsSync(codeReviewReportPath);
  const priorReviewContent = hasPriorReview ? readFileSync(codeReviewReportPath, "utf-8") : "";

  const prompt = hasPriorReview
    ? `你是一位高级开发工程师。**这是 reject 重做轮** —— 上一轮你的提交被代码审查打回，需要根据 review 反馈修改代码。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `## 上一轮代码审查反馈（必须 address 所有 Critical 问题）\n${priorReviewContent}\n\n` +
      `注意：当前 feature branch 上已有上一轮的 commit。**不要因为"已经 commit 过"就回答"任务已完成"** — review 明确指出了需要补充/修改的具体内容，你必须基于现有 commit **追加新的修改**（修文件、补字段、删冗余等），然后追加一个新 commit。代码可编译、可运行。`
    : `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。`;

  const agent = getAgent("developer", task.workflow);
  try {
    const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });
    const reportPath = join(phaseDir(taskId, task.workflow, "develop"), "dev_report.md");
    writeFileSync(reportPath, `<!-- generated:${new Date().toISOString()} -->\n${result.text}`, "utf-8");

    const statusResult = runGit(["status", "--porcelain"], repoPath);
    if (statusResult.stdout.trim()) {
      // agent 自己改的文件 add + commit；此时 working tree 只有 agent
      // 的产物（用户散改已 stash），git add -A 是安全的。
      runGit(["add", "-A"], repoPath);
      runGit(["commit", "-m", `feat: ${task.title}`], repoPath);
    }
  } finally {
    // 不论 agent 成功 / 失败 / 超时，都要 pop 回用户散改，否则用户看不到
    // 自己的未提交改动会很慌。
    //
    // dogfood-bug11 修法：pop 冲突时不能 silent 失败 —— 必须显式告诉用户
    // working tree 当前有 conflict marker 在某些文件，否则下游 submit_pr
    // 的 checkout default_branch 会因 unmerged 状态再失败一次（连锁 bug 6
    // fix 失效）。检测 pop 失败 → 把 conflict 状态写进 dev_report.md，
    // 任务仍 done 但 user 能看到"该手工解 conflict"的指引。
    if (stashed) {
      const popResult = runGit(["stash", "pop"], repoPath, false);
      if (popResult.exitCode !== 0) {
        const unmergedResult = runGit(["diff", "--name-only", "--diff-filter=U"], repoPath, false);
        const unmergedFiles = unmergedResult.stdout.trim();
        const warning =
          `\n\n---\n\n` +
          `## ⚠ 用户散改恢复冲突\n\n` +
          `develop 阶段开始前 stash 了用户工作目录散改（含 untracked），` +
          `开发完成 commit 后 \`git stash pop\` 失败：\n\n` +
          `\`\`\`\n${popResult.stderr || "(no stderr)"}\n\`\`\`\n\n` +
          (unmergedFiles
            ? `**unmerged 文件**：\n\n\`\`\`\n${unmergedFiles}\n\`\`\`\n\n`
            : "") +
          `这些文件的散改可能因为本次 task commit 修改同名文件而冲突。\n` +
          `**stash 仍保留在 \`git stash list\` 顶部**，可手工 \`git stash apply\` 后解冲突。\n` +
          `submit_pr 阶段会因 unmerged 状态无法 checkout main —— 请先手工解决冲突。\n`;
        try {
          const reportPath = join(phaseDir(taskId, task.workflow, "develop"), "dev_report.md");
          const existing = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "";
          writeFileSync(reportPath, existing + warning, "utf-8");
        } catch { /* 写不进 report 也不能影响 task 进展 */ }
      }
    }
  }

  transition(taskId, "develop_complete", {
    transitions: getTransitions(task.workflow),
    note: "开发完成",
  });
  runInBackground(taskId, "code_review");
}

export async function run_code_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  const diffResult = runGit(["diff", `${defaultBranch}...HEAD`, "--no-ext-diff"], repoPath);
  const gitDiff = diffResult.stdout.slice(0, 80000);

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  const prompt =
    `你是一位代码审查专家。请审查以下代码变更是否符合技术方案要求。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `## 代码变更\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\n` +
    `请从以下维度审查：正确性、代码质量、安全性、测试覆盖。\n\n` +
    `最后必须输出以下结论之一（独占一行）：\n` +
    `- ${REVIEW_RESULT_PASS}\n` +
    `- ${REVIEW_RESULT_REJECT}\n\n` +
    `如果驳回，请在 ## 不通过理由 下说明具体问题。`;

  const agent = getAgent("reviewer", task.workflow);
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
    const maxRejections = codeReviewPhase?.max_rejections ?? 10;

    if (newCount >= maxRejections) {
      transition(taskId, "cancel", {
        transitions,
        note: `代码审查驳回 ${newCount} 次，已取消`,
        extraUpdates: { rejection_counts: JSON.stringify(rejectionCounts), rejection_reason: reason },
      });
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

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["push", "-u", "origin", branch], repoPath);

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
  const diffStatResult = runGit(["diff", `${defaultBranch}...HEAD`, "--stat"], repoPath);
  const gitDiffStat = diffStatResult.stdout.slice(0, 3000);

  const agent = getAgent("reviewer", task.workflow);
  const prPrompt =
    `请根据以下信息生成 PR 描述（Markdown 格式）：\n\n` +
    `## 标题\n${task.title}\n\n` +
    `## 技术方案摘要\n${planContent.slice(0, 4000)}\n\n` +
    `## 变更统计\n${gitDiffStat}\n\n` +
    `请输出完整的 PR body，包含：概述、主要变更、测试说明。`;

  const prResult = await agent.run(prPrompt, { cwd: repoPath, timeout: 300_000 });
  const prBody = prResult.text;

  // 检查是否已存在 PR
  const existingPr = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "url"],
    { cwd: repoPath, stderr: "pipe" }
  );
  const existingOut = new TextDecoder().decode(existingPr.stdout ?? new Uint8Array()).trim();

  let prUrl: string;
  if (existingPr.exitCode === 0 && existingOut) {
    const parsed = JSON.parse(existingOut) as { url?: string };
    prUrl = parsed.url ?? "";
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

  // 切回 default branch，避免 daemon 主机 cwd 上 HEAD 长期停留在 task
  // feature branch 上 — 用户在终端 / IDE 跑 git 时默认是 feature branch
  // 而不是 main，连续两次 dogfood 都因此把我的 fix commit 误推到 feature
  // branch 而不是 main。dogfood-bug6 修法。
  runGit(["checkout", defaultBranch], repoPath, false);

  transition(taskId, "submit_pr_complete", {
    transitions: getTransitions(task.workflow),
    note: `PR 已提交：${prUrl}`,
  });
}
