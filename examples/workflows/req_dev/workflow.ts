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
import { listSubmodules } from "@autopilot/core/submodules";
import { appendSubPr } from "@autopilot/core/requirement-sub-prs";

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

// 从 task extra 读 submodules 数组
function getTaskSubmodules(task: ReturnType<typeof getTask>): SubmoduleInfo[] {
  if (!task) return [];
  const raw = task["submodules"];
  if (!Array.isArray(raw)) return [];
  return raw as SubmoduleInfo[];
}

// 在子模块路径下跑 git，参数风格跟 runGit 一致
function runGitInSubmodule(
  sm: SubmoduleInfo,
  args: string[],
  check = true,
): { stdout: string; stderr: string; exitCode: number } {
  return runGit(args, sm.path, check);
}

// 检测子模块是否有未提交改动（git status --porcelain 输出非空）
function submoduleHasChanges(sm: SubmoduleInfo): boolean {
  const result = runGitInSubmodule(sm, ["status", "--porcelain"], false);
  return result.exitCode === 0 && result.stdout.length > 0;
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

export interface SubmoduleInfo {
  id: string;
  alias: string;
  path: string;
  submodule_path: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

export function setup_req_dev_task(args: ReqDevSetupArgs): Record<string, unknown> {
  if (!args.repo_id) throw new Error("setup_req_dev_task: repo_id 必填");
  const repo = getRepoById(args.repo_id);
  if (!repo) throw new Error(`setup_req_dev_task: repo not found: ${args.repo_id}`);

  const title = args.title ?? "untitled";
  const requirement = args.requirement ?? "";
  const branch = `feat/${title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`;

  const submodules = listSubmodules(args.repo_id).map((sm): SubmoduleInfo => ({
    id: sm.id,
    alias: sm.alias,
    path: sm.path,
    submodule_path: sm.submodule_path ?? "",
    default_branch: sm.default_branch,
    github_owner: sm.github_owner ?? "",
    github_repo: sm.github_repo ?? "",
  }));

  return {
    title,
    requirement,
    repo_id: repo.id,
    repo_path: repo.path,
    default_branch: repo.default_branch,
    github_owner: repo.github_owner,
    github_repo: repo.github_repo,
    branch,
    submodules,
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
  runGit(["submodule", "update", "--init", "--recursive"], repoPath, false);

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

  const submodules = getTaskSubmodules(task);
  let submodulesSection = "";
  if (submodules.length > 0) {
    submodulesSection = `\n\n## 子模块\n\n本仓库含 ${submodules.length} 个子模块。在制订实现方案时，可以选择改父 repo、子模块、或两者：\n\n`;
    for (const sm of submodules) {
      submodulesSection += `- \`${sm.submodule_path}/\` — alias: ${sm.alias}, GitHub: ${sm.github_owner}/${sm.github_repo}, 默认分支: ${sm.default_branch}\n`;
    }
  }

  const prompt =
    `你是一位资深架构师。请根据以下需求，生成一份完整的技术方案。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 仓库路径\n${repoPath}\n\n` +
    `请先阅读仓库代码了解项目结构，然后输出包含以下内容的技术方案：\n` +
    `1. 需求分析\n2. 技术方案\n3. 实现步骤\n4. 影响范围\n5. 测试计划` +
    rejectionHistory +
    submodulesSection;

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

  // 1. 父 repo 切默认分支拉新
  runGit(["checkout", defaultBranch], repoPath);
  runGit(["pull", "--ff-only"], repoPath);

  // 2. 父 repo 切到 feat 分支
  const checkoutNew = runGit(["checkout", "-b", branch], repoPath, false);
  if (checkoutNew.exitCode !== 0) {
    runGit(["checkout", branch], repoPath);
  }

  // 3. 各子模块也切到 feat 分支
  const submodules = getTaskSubmodules(task);
  for (const sm of submodules) {
    runGitInSubmodule(sm, ["checkout", sm.default_branch], false);
    runGitInSubmodule(sm, ["pull", "--ff-only", "origin", sm.default_branch], false);
    const smCheckoutNew = runGitInSubmodule(sm, ["checkout", "-b", branch], false);
    if (smCheckoutNew.exitCode !== 0) {
      runGitInSubmodule(sm, ["checkout", branch], false);
    }
  }

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  // 4. 构造 prompt，加可改路径段
  let submodulesSection = "";
  if (submodules.length > 0) {
    submodulesSection = `\n\n## 可改路径\n\n父仓库根：\`${repoPath}\`\n\n子模块（在子模块路径下改代码就行，不要切分支也不要 commit/push）：\n`;
    for (const sm of submodules) {
      submodulesSection += `- \`${sm.submodule_path}/\` — ${sm.alias}\n`;
    }
  }

  const prompt =
    `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。\n` +
    `写完代码后不要 commit、不要 push，commit 由后续步骤统一处理。` +
    submodulesSection;

  const agent = getAgent("developer", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  const reportPath = join(phaseDir(taskId, task.workflow, "develop"), "dev_report.md");
  writeFileSync(reportPath, `<!-- generated:${new Date().toISOString()} -->\n${result.text}`, "utf-8");

  // 5. 扫每个子模块，有改动 → 在子模块内 commit
  for (const sm of submodules) {
    if (submoduleHasChanges(sm)) {
      runGitInSubmodule(sm, ["add", "-A"]);
      runGitInSubmodule(sm, ["commit", "-m", `feat: ${task.title}`]);
    }
  }

  // 6. 父 repo: git add -A 包含子模块 SHA bump + 父自身改动，再统一 commit
  runGit(["add", "-A"], repoPath);
  const cachedProc = Bun.spawnSync(
    ["git", "diff", "--cached", "--quiet"],
    { cwd: repoPath }
  );
  const hasParentStaged = cachedProc.exitCode !== 0; // exitCode=1 表示有 staged 改动
  if (hasParentStaged) {
    runGit(["commit", "-m", `feat: ${task.title}`], repoPath);
  }

  // 7. 验证：父 repo 至少有 1 个新 commit（含 SHA bump 也算）
  const logResult = runGit(["log", `${defaultBranch}...HEAD`, "--oneline"], repoPath, false);
  if (!logResult.stdout.trim()) {
    throw new Error("develop 阶段：开发完成后父仓库没有新 commit，请检查 agent 输出");
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

  // 父 repo diff
  const parentDiff = runGit(
    ["diff", `${defaultBranch}...HEAD`, "--stat", "--patch"],
    repoPath,
    false,
  ).stdout;

  // 各子模块 diff
  const submodules = getTaskSubmodules(task);
  let submodulesDiff = "";
  for (const sm of submodules) {
    const smDiff = runGitInSubmodule(
      sm,
      ["diff", `${sm.default_branch}...HEAD`, "--stat", "--patch"],
      false,
    ).stdout;
    if (smDiff && smDiff.trim()) {
      submodulesDiff += `\n\n## 子模块 ${sm.alias} (${sm.submodule_path}/)\n\n${smDiff.slice(0, 6000)}`;
    }
  }

  // 合并父+子 diff 供 reviewer 使用
  const fullDiff = parentDiff.slice(0, 8000) + submodulesDiff;

  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  const prompt =
    `你是一位代码审查专家。请审查以下代码变更是否符合技术方案要求。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    `## 代码变更\n\`\`\`diff\n${fullDiff}\n\`\`\`\n\n` +
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
  const reqId = task["requirement_id"] as string | undefined;

  // ── 1. 各子模块：先 push + 创建/更新 PR ──
  type SubResult = { sm: SubmoduleInfo; pr_url: string; pr_number: number };
  const submoduleResults: SubResult[] = [];
  const submodules = getTaskSubmodules(task);

  for (const sm of submodules) {
    // 检查是否有需要 push 的 commit
    const log = runGitInSubmodule(
      sm,
      ["log", "--oneline", `${sm.default_branch}..HEAD`],
      false,
    ).stdout;
    if (!log.trim()) continue;

    runGitInSubmodule(sm, ["push", "-u", "origin", branch]);

    // 检查现有 PR
    const ghCheck = Bun.spawnSync(
      ["gh", "pr", "view", "--json", "url,number"],
      { cwd: sm.path, stderr: "pipe" },
    );

    const smTitle = `${task.title}（子模块 ${sm.alias}）`;
    const smBody =
      `跟父仓库 PR 关联的子模块 PR。\n\n本次 ${sm.alias} 的改动用于响应父需求。`;

    let smPrUrl: string;
    let smPrNumber: number;

    if (ghCheck.exitCode === 0 && ghCheck.stdout) {
      const parsed = JSON.parse(new TextDecoder().decode(ghCheck.stdout)) as {
        url?: string;
        number?: number;
      };
      smPrUrl = parsed.url ?? "";
      smPrNumber = parsed.number ?? 0;
      Bun.spawnSync(["gh", "pr", "edit", "--body", smBody], { cwd: sm.path });
    } else {
      const create = Bun.spawnSync(
        [
          "gh", "pr", "create",
          "--title", smTitle,
          "--body", smBody,
          "--base", sm.default_branch,
          "--head", branch,
        ],
        { cwd: sm.path, stdout: "pipe", stderr: "pipe" },
      );
      if (create.exitCode !== 0) {
        const err = new TextDecoder().decode(create.stderr ?? new Uint8Array());
        throw new Error(`子模块 ${sm.alias} gh pr create 失败：${err}`);
      }
      smPrUrl = new TextDecoder().decode(create.stdout).trim();
      const m = smPrUrl.match(/\/pull\/(\d+)$/);
      smPrNumber = m ? parseInt(m[1], 10) : 0;
    }

    submoduleResults.push({ sm, pr_url: smPrUrl, pr_number: smPrNumber });

    // 写 requirement_sub_prs（如果 task 有 requirement_id）
    if (reqId) {
      appendSubPr({
        requirement_id: reqId,
        child_repo_id: sm.id,
        pr_url: smPrUrl,
        pr_number: smPrNumber,
      });
    }
  }

  // ── 2. 父 repo push ──
  runGit(["push", "-u", "origin", branch], repoPath);

  // ── 3. 生成父 PR body ──
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
  let parentBody = prResult.text;

  // ── 4. 父 PR body 追加关联子模块 PR 清单 ──
  if (submoduleResults.length > 0) {
    parentBody += "\n\n---\n\n## 关联子模块 PR\n\n";
    for (const r of submoduleResults) {
      parentBody += `- [${r.sm.alias}#${r.pr_number}](${r.pr_url})\n`;
    }
  }

  // ── 5. 检查是否已存在父 PR，然后创建/更新 ──
  const existingPr = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "url"],
    { cwd: repoPath, stderr: "pipe" },
  );
  const existingOut = new TextDecoder().decode(existingPr.stdout ?? new Uint8Array()).trim();

  let prUrl: string;
  if (existingPr.exitCode === 0 && existingOut) {
    const parsed = JSON.parse(existingOut) as { url?: string };
    prUrl = parsed.url ?? "";
    Bun.spawnSync(["gh", "pr", "edit", "--body", parentBody], { cwd: repoPath });
  } else {
    const createProc = Bun.spawnSync(
      [
        "gh", "pr", "create",
        "--title", task.title,
        "--body", parentBody,
        "--base", defaultBranch,
        "--head", branch,
      ],
      { cwd: repoPath, stderr: "pipe" },
    );
    if (createProc.exitCode !== 0) {
      const errMsg = new TextDecoder().decode(createProc.stderr ?? new Uint8Array()).trim();
      throw new Error(`创建 PR 失败：${errMsg}`);
    }
    prUrl = new TextDecoder().decode(createProc.stdout ?? new Uint8Array()).trim();
  }

  // ── 6. 写回 pr_url / pr_number 到 task extra（P3 await_review 阶段用）──
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

  // 2. 父 repo 切到 feat 分支并拉最新
  runGit(["checkout", branch], repoPath);
  runGit(["pull", "--ff-only", "origin", branch], repoPath, false);

  // 各子模块也切到 feat 分支并拉最新（失败不阻塞，子模块可能没参与本次需求）
  const submodules = getTaskSubmodules(task);
  for (const sm of submodules) {
    runGitInSubmodule(sm, ["checkout", branch], false);
    runGitInSubmodule(sm, ["pull", "--ff-only", "origin", branch], false);
  }

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
    { cwd: repoPath, stderr: "pipe" },
  );
  const beforeHead = new TextDecoder().decode(beforeHeadProc.stdout ?? new Uint8Array()).trim();

  // 6. 构造 prompt，加可改路径段
  let submodulesSection = "";
  if (submodules.length > 0) {
    submodulesSection = `\n\n## 可改路径\n\n父仓库根：\`${repoPath}\`\n\n子模块：\n`;
    for (const sm of submodules) {
      submodulesSection += `- \`${sm.submodule_path}/\` — ${sm.alias}\n`;
    }
  }

  const agent = getAgent("developer", task.workflow);
  const prompt =
    `请按以下反馈修改代码（在仓库 ${repoPath}，当前分支 ${branch}）：\n\n` +
    `## 反馈来源\n${latest.source === "github_review" ? "GitHub PR review" : "用户手动注入"}\n\n` +
    `## 反馈内容\n${latest.body}\n\n` +
    `## 原方案摘要\n${planContent}\n\n` +
    `## 当前 PR 变更统计\n${diffStat}\n\n` +
    `要求：\n` +
    `- 修改对应代码满足反馈\n` +
    `- 写完后不要 commit、不要 push（commit 由后续步骤统一处理）\n` +
    `- 不要切换分支（保持在 ${branch}）\n` +
    submodulesSection;

  await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  // 7. 各子模块：有改动则 commit + push
  for (const sm of submodules) {
    if (submoduleHasChanges(sm)) {
      runGitInSubmodule(sm, ["add", "-A"]);
      runGitInSubmodule(sm, ["commit", "-m", `fix: review 反馈修改`]);
      runGitInSubmodule(sm, ["push", "origin", branch]);
    }
  }

  // 8. 父 repo: add -A 一次性（含子模块 SHA bump），有 staged 改动则 commit
  runGit(["add", "-A"], repoPath);
  const cached = Bun.spawnSync(
    ["git", "diff", "--cached", "--quiet"],
    { cwd: repoPath },
  );
  if (cached.exitCode !== 0) {
    runGit(["commit", "-m", `fix: review 反馈修改`], repoPath);
  }

  // 9. 验证有新 commit（相对于 push 前的 HEAD）
  const afterHeadProc = Bun.spawnSync(
    ["git", "rev-parse", "HEAD"],
    { cwd: repoPath, stderr: "pipe" },
  );
  const afterHead = new TextDecoder().decode(afterHeadProc.stdout ?? new Uint8Array()).trim();
  if (!afterHead || afterHead === beforeHead) {
    throw new Error("fix_revision 阶段：agent 没有产生新 commit");
  }

  // 10. push 父 repo 到原 PR 分支（不 force）
  runGit(["push", "origin", branch], repoPath);

  // 11. 触发 jump trigger fix_done → 跳回 await_review
  transition(taskId, "fix_done", {
    transitions: getTransitions(task.workflow),
    note: "fix_revision 完成，回到 await_review",
  });
  runInBackground(taskId, "await_review");
}
