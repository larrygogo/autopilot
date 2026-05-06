/**
 * req_dev workflow 阶段函数
 *
 * 与旧 dev workflow 的本质差别：
 *  - setup_func 接收 repo_id（从 repos 表查 path / branch / github_owner / github_repo）
 *    而非读 workflow.config.repo_path
 *  - 阶段函数从 task extra 读 repo_path / github_owner / github_repo，无全局 config 依赖
 *  - submit_pr 阶段写回 pr_url / pr_number 到 task extra（P3 await_review 阶段用）
 *
 * P1：design → review → develop → code_review → submit_pr 5 阶段
 * await_review / fix_revision 在 P3 加入
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTask, updateTask } from "@autopilot/core/db";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { runInBackground } from "@autopilot/core/runner";
import { getAgent } from "@autopilot/agents/registry";
import { getPhaseIndex } from "@autopilot/core/artifacts";
import { getTaskWorkspace } from "@autopilot/core/workspace";
import { getRepoById } from "@autopilot/core/repos";
import { setRequirementStatus, getRequirementById } from "@autopilot/core/requirements";
import { forceTransition } from "@autopilot/core/state-machine";
import { latestFeedback } from "@autopilot/core/requirement-feedbacks";

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

export interface ReqDevSetupArgs {
  repo_id: string;
  title?: string;
  requirement?: string;
}

export function setup_req_dev_task(args: ReqDevSetupArgs): Record<string, unknown> {
  if (!args.repo_id) throw new Error("setup_req_dev_task: repo_id 必填");
  const repo = getRepoById(args.repo_id);
  if (!repo) throw new Error(`setup_req_dev_task: repo not found: ${args.repo_id}`);

  const title = args.title ?? "untitled";
  const requirement = args.requirement ?? "";
  const branch = `feat/${title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`;

  return {
    title,
    requirement,
    repo_id: repo.id,
    repo_path: repo.path,
    default_branch: repo.default_branch,
    github_owner: repo.github_owner,
    github_repo: repo.github_repo,
    branch,
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
  const checkoutNew = runGit(["checkout", "-b", branch], repoPath, false);
  if (checkoutNew.exitCode !== 0) {
    runGit(["checkout", branch], repoPath);
  }

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  const prompt =
    `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。`;

  const agent = getAgent("developer", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  const reportPath = join(phaseDir(taskId, task.workflow, "develop"), "dev_report.md");
  writeFileSync(reportPath, `<!-- generated:${new Date().toISOString()} -->\n${result.text}`, "utf-8");

  const statusResult = runGit(["status", "--porcelain"], repoPath);
  if (statusResult.stdout.trim()) {
    runGit(["add", "-A"], repoPath);
    runGit(["commit", "-m", `feat: ${task.title}`], repoPath);
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

  // 写回 pr_url / pr_number 到 task extra（P3 await_review 阶段用）
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
  updateTask(taskId, { pr_url: prUrl, pr_number: prNumber });

  transition(taskId, "submit_pr_complete", {
    transitions: getTransitions(task.workflow),
    note: `PR 已提交：${prUrl}`,
  });
}

export async function run_await_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const reqId = task["requirement_id"] as string | undefined;
  if (!reqId) {
    throw new Error(
      "await_review 阶段：task 缺少 requirement_id 字段。" +
        "确保 task 由 requirement-scheduler 创建（会透传 requirement_id），" +
        "或在 setup_req_dev_task 中传入此字段。"
    );
  }

  // 立即同步 requirement.status = awaiting_review，调度器据此释放槽位
  // 若当前已经是 awaiting_review（从 fix_revision jump 回来）则跳过避免重复写入
  const initial = getRequirementById(reqId);
  if (!initial) throw new Error(`requirement ${reqId} 不存在`);
  if (initial.status !== "awaiting_review") {
    setRequirementStatus(reqId, "awaiting_review");
  }

  // 挂起循环：每 15s 轮询 requirement.status
  // daemon 重启后从头执行此函数，requirement.status 由 DB 持久化保留，逻辑幂等
  while (true) {
    const cur = getRequirementById(reqId);
    if (!cur) {
      throw new Error(`requirement ${reqId} 已不存在`);
    }

    if (cur.status === "fix_revision") {
      // 触发跳转到 fix_revision 阶段（jump_trigger=revision_request）
      const transitions = getTransitions(task.workflow);
      transition(taskId, "revision_request", { transitions, note: `requirement ${reqId} 请求修订` });
      return;
    }

    if (cur.status === "done") {
      // PR 已合并，任务进入完成终态
      forceTransition(taskId, "done", `requirement ${reqId} → done`);
      return;
    }

    if (cur.status === "cancelled" || cur.status === "failed") {
      forceTransition(taskId, "cancelled", `requirement ${reqId} → ${cur.status}`);
      return;
    }

    // awaiting_review 或其他中间状态，继续等待
    await Bun.sleep(15_000);
  }
}

export async function run_fix_revision(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const reqId = task["requirement_id"] as string | undefined;
  if (!reqId) throw new Error("fix_revision 阶段：task 缺少 requirement_id 字段");

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  // 1. 取最新 feedback
  const latest = latestFeedback(reqId);
  if (!latest) throw new Error(`requirement ${reqId} 没有反馈记录可处理`);

  // 2. checkout PR 分支（不切默认分支，直接切到原 PR 分支）
  runGit(["checkout", branch], repoPath);
  // 拉远端最新；失败不阻塞（可能仅本地有改动）
  runGit(["pull", "--ff-only", "origin", branch], repoPath, false);

  // 3. 准备产物目录 + 写 feedback.md
  const fixDir = phaseDir(taskId, task.workflow, "fix_revision");
  const feedbackPath = join(fixDir, "feedback.md");
  writeFileSync(feedbackPath, latest.body, "utf-8");

  // 4. 拿设计方案 + 当前 PR diff stat 作为 agent 上下文
  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8").slice(0, 4000) : "";
  const diffStat = runGit(["diff", `${defaultBranch}...HEAD`, "--stat"], repoPath, false).stdout.slice(0, 3000);

  // 5. 记录 push 前的 HEAD（用于验证有新 commit）
  const beforeHeadProc = Bun.spawnSync(
    ["git", "rev-parse", "HEAD"],
    { cwd: repoPath, stderr: "pipe" }
  );
  const beforeHead = new TextDecoder().decode(beforeHeadProc.stdout ?? new Uint8Array()).trim();

  // 6. 调 developer agent
  const agent = getAgent("developer", task.workflow);
  const prompt =
    `请按以下反馈修改代码（在仓库 ${repoPath}，当前分支 ${branch}）：\n\n` +
    `## 反馈来源\n${latest.source === "github_review" ? "GitHub PR review" : "用户手动注入"}\n\n` +
    `## 反馈内容\n${latest.body}\n\n` +
    `## 原方案摘要\n${planContent}\n\n` +
    `## 当前 PR 变更统计\n${diffStat}\n\n` +
    `要求：\n` +
    `- 修改对应代码满足反馈\n` +
    `- 写完后 git add & commit（commit message 用中文，标注「按 review 反馈修改」）\n` +
    `- 不要 push 不要建 PR（push 由后续步骤处理）\n` +
    `- 不要切换分支（保持在 ${branch}）\n`;

  await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  // 7. 验证有新 commit
  const afterHeadProc = Bun.spawnSync(
    ["git", "rev-parse", "HEAD"],
    { cwd: repoPath, stderr: "pipe" }
  );
  const afterHead = new TextDecoder().decode(afterHeadProc.stdout ?? new Uint8Array()).trim();
  if (!afterHead || afterHead === beforeHead) {
    throw new Error("fix_revision 阶段：agent 没有产生新 commit");
  }

  // 8. push 到原 PR 分支（不 force）
  runGit(["push", "origin", branch], repoPath);

  // 9. 触发 jump trigger fix_done → 跳回 await_review
  transition(taskId, "fix_done", {
    transitions: getTransitions(task.workflow),
    note: "fix_revision 完成，回到 await_review",
  });
  runInBackground(taskId, "await_review");
}
