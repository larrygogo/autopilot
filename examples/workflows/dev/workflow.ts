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
import { getWorkflow, buildTransitions } from "@autopilot/core/workflow/registry";
import { runInBackground } from "@autopilot/core/runner";
import { agentForPhase } from "@autopilot/agents/registry";
import { getPhaseIndex } from "@autopilot/core/artifacts";
import { getTaskArtifactsDir, listTaskRepos, type TaskRepoCtx } from "@autopilot/core/sandbox";
import { appendSubPr } from "@autopilot/core/requirements/sub-prs";
import { getCurrentSandboxDir } from "@autopilot/core/task/context";
import { notify } from "@autopilot/core/notify";
import { judgeVerdict } from "@autopilot/core/workflow/judge";

// 结构化裁判 provider：dev 的 review agent 走 anthropic CLI（订阅，无 API key），但结构化裁判
// 需 API 模式 + 强制 tool_choice。这里指向用户已配的 kimi-code（openai-compat，已实测兼容
// Kimi 思考端点的 tool_choice 强制）。换裁判 provider 改这里一处即可。
const JUDGE_PROVIDER = "kimi-code";

// 评审裁判标准（拼进结构化裁判 prompt，替代旧的 REVIEW_RESULT 标记约定）。
// design 评审刻意从宽：它是早期闸门，后面还有 develop + code_review 兜底，评审里"可在开发阶段
// 处理的 gap"不该把方案打回（否则 design↔review 易在 important-but-addressable 问题上空转触顶）。
const DESIGN_REVIEW_CRITERIA =
  "判定对象是【设计方案】而非最终代码——后面还有完整的开发 + 代码审查环节兜底，无需在设计阶段追求面面俱到。\n" +
  "通过(pass)：架构方向正确、技术可行、核心需求有覆盖即可。**可在开发阶段处理的 gap 一律不构成驳回**——" +
  "包括边界 case 未写全、次要规格未钉死、测试细节、可读性/命名建议、以及评审标注为 Important/minor 但不影响架构成立的问题。\n" +
  "驳回(reject)：仅当存在【架构性硬伤】——技术方向错误 / 方案不可行 / 核心需求遗漏 / 重大风险且方案毫无意识。\n" +
  "原则：评审即便挑了不少刺，只要架构站得住、能据此往下开发，就判 pass，把细节留给后续环节。";
const CODE_REVIEW_CRITERIA =
  "通过(pass)：改动正确实现了需求与技术方案的核心目标，无明显正确性/安全问题，关键路径可验证。仅 minor 风格问题不驳回。\n" +
  "驳回(reject)：critical/important 缺陷——功能未实现 / 逻辑错误 / 安全隐患 / 与方案严重不符。";

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
 * 仓库布局说明段（拼进 design/develop/code_review prompt）。统一 multi-clone 布局下
 * 单库代码也在 ./alias/ 子目录，必须告知 agent（否则在 workspace 根上跑 git 直接 fatal）。
 * 仅旧任务（根即仓库，dir 全空）返回空串——prompt 与旧时代完全一致。
 */
function repoLayoutSection(repos: TaskRepoCtx[]): string {
  if (repos.length === 0 || repos.every((r) => r.dir === "")) return "";
  const lines = repos
    .map((r) => `- \`./${r.dir}/\` — ${r.alias}（base 分支 ${r.base}）`)
    .join("\n");
  return (
    `\n\n## 仓库布局\n本任务涉及 ${repos.length} 个仓库，分别克隆在当前目录的子目录下：\n${lines}\n` +
    `规则：直接在各子目录内修改文件；**不要自己 git commit/push**（每个仓库的改动会由 submit_pr 阶段分别提交并各开一个 PR）；` +
    `跨仓库接口（API 契约/类型定义）必须两侧同步修改。`
  );
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
    repoLayoutSection(taskRepos(taskId, task)) +
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
    `请从以下维度给出散文评审：完整性、可行性、风险点、测试覆盖。指出真问题、说明是否建议通过。` +
    `结论由系统裁判，你只需把评审意见写清楚（无需输出固定结论标记）。`;

  const agent = agentForPhase(task.workflow, "review");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 900_000 });
  const text = result.text;

  const reviewPath = join(phaseDir(taskId, task.workflow, "review"), "plan_review.md");
  writeFileSync(reviewPath, `<!-- generated:${new Date().toISOString()} -->\n${text}`, "utf-8");

  // 结构化裁判把散文评审收敛成 pass/reject（替代旧的 REVIEW_RESULT 标记匹配；
  // 模型不守格式 / 散文干扰预判的隐患由框架担保的结构化通道消除）。
  const verdict = await judgeVerdict({ review: text, criteria: DESIGN_REVIEW_CRITERIA, provider: JUDGE_PROVIDER });
  const transitions = getTransitions(task.workflow);

  if (verdict.verdict === "ambiguous") {
    // 裁判两次仍未给出明确结论 → 停下报人（与旧「无法解析评审结论」同语义）。
    throw new Error("结构化裁判无法判定方案评审结论（pass/reject），请检查评审报告");
  }

  if (verdict.verdict === "pass") {
    transition(taskId, "review_complete", { transitions, note: "方案评审通过" });
    runInBackground(taskId, "develop");
    return;
  }

  // reject
  const reason = verdict.reason || "请查看评审报告";
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

  const layoutSection = repoLayoutSection(taskRepos(taskId, task));
  const prompt = hasPriorReview
    ? `你是一位高级开发工程师。**这是 reject 重做轮** —— 上一轮你的提交被代码审查打回，需要根据 review 反馈修改代码。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `## 上一轮代码审查反馈（必须 address 所有 Critical 问题）\n${priorReviewContent}\n\n` +
      `注意：上一轮你的改动已在工作树里（未提交，共用沙盒会保留）。**不要因为"已经改过"就回答"任务已完成"** — review 明确指出了需要补充/修改的具体内容，你必须在现有改动基础上**继续修改**（修文件、补字段、删冗余等），直接改文件即可、**不要自己 git commit**（提交由 submit_pr 阶段统一做）。代码可编译、可运行。` +
      layoutSection
    : `你是一位高级开发工程师。请根据以下技术方案进行开发。\n\n` +
      `## 技术方案\n${planContent}\n\n` +
      `请直接在仓库中创建和修改文件完成开发，确保代码可编译、可运行。` +
      layoutSection;

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
  // 多代码库：逐库采集 diff（单库 = 长度 1 循环，git 命令序列与单库时代逐条等价）。
  // 共用沙盒：develop 改动留在工作树（可能含 commit / 新建文件）。先 add -A 纳入未跟踪新文件，
  // 再 diff --cached <base> 看相对 base 的全量改动 —— 覆盖 committed + 未提交 + 新建，不依赖
  // agent 把改动留成什么状态。否则 agent 一 commit 或新建文件，工作树 vs HEAD 的 diff 就看空 →
  // code_review 误判"变更未实现"反复驳回 → 任务 cancelled（即焚的 reset -q 归一层删掉后的回归）。
  const repos = taskRepos(taskId, task);
  const DIFF_CAP = 80000;
  const perRepoCap = Math.max(8000, Math.floor(DIFF_CAP / repos.length));
  let diffSections = "";
  let statSections = "";
  let anyTruncated = false;
  for (const r of repos) {
    runGit(["add", "-A"], r.path);
    // base 用 origin/<branch>：clone 后远程跟踪 ref 对默认+非默认分支都在（本地只建了默认分支）。
    const diffResult = runGit(["diff", "--cached", "--no-ext-diff", `origin/${r.base}`], r.path);
    const statResult = runGit(["diff", "--cached", "--stat", `origin/${r.base}`], r.path);
    const head = repos.length > 1 ? `\n### 仓库 ${r.alias}（目录 ./${r.dir}/）\n` : "";
    // 全量 stat（很小）给 reviewer 文件级全景——大改动 diff 截断时，排在尾部的文件
    // （迁移/前端组件等）会整个消失，reviewer 盲判「未实现」三连驳（dogfood：req-011
    // 第三轮 108KB diff，被指「缺失」的 migration/上传组件全都存在，只是被切掉了）。
    statSections += `${head}\`\`\`\n${statResult.stdout.slice(0, 8000)}\n\`\`\`\n`;
    diffSections += `${head}\`\`\`diff\n${diffResult.stdout.slice(0, perRepoCap)}\n\`\`\`\n`;
    if (diffResult.stdout.length > perRepoCap) anyTruncated = true;
  }

  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContent = readFileSync(planPath, "utf-8");

  const truncationNotice = anyTruncated
    ? `\n\n⚠ **注意：部分仓库的完整 diff 超出内联上限（每仓库 ${Math.round(perRepoCap / 1024)}KB），已截断**。` +
      `「变更文件全景」里列出但未出现在内联 diff 中的文件**不代表未实现**——你在仓库工作目录里，` +
      `必须进入对应仓库目录用 \`git diff --cached origin/<base> -- <文件路径>\` 或 Read 工具自查这些文件的实际改动后再下结论。` +
      `**禁止以「diff 中未见到」为由认定功能缺失或驳回。**`
    : "";

  const prompt =
    `你是一位代码审查专家。请审查以下代码变更是否符合技术方案要求。\n\n` +
    `## 技术方案\n${planContent}\n\n` +
    // repoLayoutSection 自空判断（旧根布局任务返回空串）；统一子目录布局下单库也要告知，
    // 否则 diff 截断时 reviewer 按提示自查会在 workspace 根上跑 git 直接 fatal。
    (repoLayoutSection(repos) ? `${repoLayoutSection(repos)}\n\n` : "") +
    `## 变更文件全景（git diff --stat 全量）\n${statSections}\n` +
    `## 代码变更\n${diffSections}${truncationNotice}\n\n` +
    `请从以下维度给出散文审查：正确性、代码质量、安全性、测试覆盖。指出真问题而非格式纠错、` +
    `说明是否建议通过。结论由系统裁判，你只需把审查意见写清楚（无需输出固定结论标记）。`;

  const agent = agentForPhase(task.workflow, "code_review");
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 1_200_000 });
  const text = result.text;

  const reviewPath = join(phaseDir(taskId, task.workflow, "code_review"), "code_review_report.md");
  writeFileSync(reviewPath, `<!-- generated:${new Date().toISOString()} -->\n${text}`, "utf-8");

  // 结构化裁判收敛散文审查为 pass/reject（替代旧标记匹配）。
  const verdict = await judgeVerdict({ review: text, criteria: CODE_REVIEW_CRITERIA, provider: JUDGE_PROVIDER });
  const transitions = getTransitions(task.workflow);

  if (verdict.verdict === "ambiguous") {
    throw new Error("结构化裁判无法判定代码审查结论（pass/reject），请检查审查报告");
  }

  if (verdict.verdict === "pass") {
    transition(taskId, "code_review_complete", { transitions, note: "代码审查通过" });
    runInBackground(taskId, "submit_pr");
    return;
  }

  // reject
  const reason = verdict.reason || "请查看审查报告";
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
}

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
  const planPath = join(phasePath(taskId, task.workflow, "design"), "plan.md");
  const planContext = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";

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
