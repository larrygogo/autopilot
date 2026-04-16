/**
 * dev 工作流阶段函数（TypeScript 版）
 * 完整开发流程：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getTask, updateTask } from "../../../src/core/db";
import { getTaskDir } from "../../../src/core/infra";
import { transition } from "../../../src/core/state-machine";
import { getWorkflow, buildTransitions } from "../../../src/core/registry";
import { runInBackground } from "../../../src/core/runner";
import { getAgent } from "../../../src/agents/registry";

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

// ──────────────────────────────────────────────
// 任务初始化
// ──────────────────────────────────────────────

export function setup_dev_task(args: { title?: string }): Record<string, unknown> {
  const wf = getWorkflow("dev");
  const config = (wf?.config ?? {}) as Record<string, string>;

  const repoPath = expandPath(config["repo_path"] ?? "");
  const defaultBranch = config["default_branch"] ?? "main";
  const title = args.title ?? "untitled";

  return {
    title,
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

  const taskDir = getTaskDir(taskId);
  const repoPath = task["repo_path"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);

  const reqPath = join(taskDir, "requirement.md");
  if (!existsSync(reqPath)) {
    throw new Error(`需求文件不存在：${reqPath}`);
  }
  const requirement = readFileSync(reqPath, "utf-8");

  // 驳回历史
  let rejectionHistory = "";
  const reviewPath = join(taskDir, "plan_review.md");
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

  const planPath = join(taskDir, "plan.md");
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

  const taskDir = getTaskDir(taskId);
  const repoPath = task["repo_path"] as string;

  const planContent = readFileSync(join(taskDir, "plan.md"), "utf-8");
  const reqPath = join(taskDir, "requirement.md");
  const requirement = existsSync(reqPath) ? readFileSync(reqPath, "utf-8") : "";

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

  const reviewPath = join(taskDir, "plan_review.md");
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

  const taskDir = getTaskDir(taskId);
  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);
  const checkoutNew = runGit(["checkout", "-b", branch], repoPath, false);
  if (checkoutNew.exitCode !== 0) {
    runGit(["checkout", branch], repoPath);
  }

  const planContent = readFileSync(join(taskDir, "plan.md"), "utf-8");

  const prompt =
    `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。`;

  const agent = getAgent("developer", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  const reportPath = join(taskDir, "dev_report.md");
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

  const taskDir = getTaskDir(taskId);
  const repoPath = task["repo_path"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  const diffResult = runGit(["diff", `${defaultBranch}...HEAD`, "--no-ext-diff"], repoPath);
  const gitDiff = diffResult.stdout.slice(0, 80000);

  const planContent = readFileSync(join(taskDir, "plan.md"), "utf-8");

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

  const reviewPath = join(taskDir, "code_review_report.md");
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

  const taskDir = getTaskDir(taskId);
  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;
  const defaultBranch = (task["default_branch"] as string) ?? "main";

  runGit(["push", "-u", "origin", branch], repoPath);

  const planPath = join(taskDir, "plan.md");
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

  transition(taskId, "submit_pr_complete", {
    transitions: getTransitions(task.workflow),
    note: `PR 已提交：${prUrl}`,
  });
}
