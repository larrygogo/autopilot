/**
 * with_human 工作流：演示 autopilot 的两种人机交互机制。
 *
 * - **ask_user**（agent 中途主动提问）：plan phase 的 prompt 鼓励 planner agent
 *   遇到方向二选一时调 mcp__autopilot_workflow__ask_user 工具问用户；agent 拿到
 *   答案继续。框架自动注入工具，工作流不需要写代码。
 *
 * - **gate**（phase 完成后人工审批）：plan phase 配 gate: true。runner 在阶段
 *   函数跑完后挂起 task 到 awaiting_plan，UI 弹 banner [通过/驳回/取消]。
 *
 * 重要：用 gate 时，phase 函数不要主动 transition('xxx_complete') + runInBackground。
 * 让 runner 自动接管——它检测到状态仍是 running_<phase> + gate:true 才会触发 await。
 *
 * 参考文档：docs/workflow-development.md「人机交互」一节。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTask } from "@autopilot/core/db";
import { getAgent } from "@autopilot/agents/registry";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { transition } from "@autopilot/core/state-machine";
import { runInBackground } from "@autopilot/core/runner";
import { getTaskWorkspace } from "@autopilot/core/workspace";
import { getPhaseIndex } from "@autopilot/core/artifacts";

const PASS = "REVIEW_RESULT: PASS";
const REJECT = "REVIEW_RESULT: REJECT";

function phaseDir(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  const dir = join(getTaskWorkspace(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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

function readLastUserDecision(task: ReturnType<typeof getTask>): {
  phase: string;
  decision: string;
  note: string;
  ts: string;
} | null {
  const raw = task?.["last_user_decision"] as string | undefined;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setup_with_human_task(args: {
  title?: string;
  requirement?: string;
}): Record<string, unknown> {
  const wf = getWorkflow("with_human");
  const config = (wf?.config ?? {}) as Record<string, string>;
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
    repo_path: config["repo_path"] ?? "",
  };
}

// ──────────────────────────────────────────────
// plan 阶段：agent 写计划，可调 ask_user
// ──────────────────────────────────────────────
//
// 注意：函数末尾**没有** transition + runInBackground。runner 会自动检测到
// gate:true 并触发 await_plan，把 task 挂到 awaiting_plan 等用户决断。

export async function run_plan(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const title = task.title as string;
  const requirement = (task["requirement"] as string | undefined) ?? "";
  const fullNeed = requirement.trim() ? `${title}\n\n${requirement}` : title;

  // 拼驳回历史：reviewer 上次驳回意见 + 用户上次驳回备注
  let rejectionHistory = "";
  const counts = getRejectionCounts(task);
  const planRejections = counts["plan"] ?? 0;

  const dir = phaseDir(taskId, task.workflow, "plan");
  const reviewMdPath = join(phaseDir(taskId, task.workflow, "review"), "plan_review.md");
  if (planRejections > 0 && existsSync(reviewMdPath)) {
    const prev = readFileSync(reviewMdPath, "utf-8");
    rejectionHistory += `\n\n## 上次 reviewer 驳回意见（第 ${planRejections} 次）\n${prev}`;
  }
  const userDecision = readLastUserDecision(task);
  if (userDecision?.phase === "plan" && userDecision.decision === "reject" && userDecision.note) {
    rejectionHistory += `\n\n## 上次人工驳回意见 (${userDecision.ts})\n${userDecision.note}`;
  }

  const prompt =
    `你是一位资深策划师。请根据以下需求写一份执行计划。\n\n` +
    `## 需求\n${fullNeed}\n\n` +
    `## 仓库路径\n${repoPath}\n\n` +
    `**人机交互提示**：如果需求里有方向二选一或范围模糊的关键决策，可以调用 ` +
    `\`mcp__autopilot_workflow__ask_user\` 工具向用户询问后再继续；不要为细枝末节频繁问。\n\n` +
    `请输出包含以下内容的计划：\n` +
    `1. 需求理解\n2. 关键决策（如果调过 ask_user，把回答记下来）\n` +
    `3. 实施步骤\n4. 验收标准` +
    rejectionHistory;

  const agent = getAgent("planner", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 600_000 });

  writeFileSync(
    join(dir, "plan.md"),
    `<!-- generated:${new Date().toISOString()} -->\n${result.text}`,
    "utf-8",
  );

  // ↓ 关键：不主动 transition。runner 看到 gate:true 会自动触发 await_plan。
}

// ──────────────────────────────────────────────
// review 阶段：reviewer 评审计划
// ──────────────────────────────────────────────
//
// 这里需要主动 transition，因为 review 有 PASS / REJECT 两个分支，runner 没法替你选。

export async function run_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const repoPath = task["repo_path"] as string;
  const title = task.title as string;
  const requirement = (task["requirement"] as string | undefined) ?? "";
  const fullNeed = requirement.trim() ? `${title}\n\n${requirement}` : title;
  const planContent = readFileSync(join(phaseDir(taskId, task.workflow, "plan"), "plan.md"), "utf-8");

  const prompt =
    `你是一位技术评审专家。请评审以下执行计划是否满足需求。\n\n` +
    `## 需求\n${fullNeed}\n\n` +
    `## 计划\n${planContent}\n\n` +
    `请从以下维度评审：完整性、可行性、风险点。\n\n` +
    `最后必须独占一行输出以下结论之一：\n- ${PASS}\n- ${REJECT}\n\n` +
    `如果驳回，请在 "## 驳回理由" 标题下说明具体问题。`;

  const agent = getAgent("reviewer", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath, timeout: 600_000 });
  const text = result.text;

  writeFileSync(
    join(phaseDir(taskId, task.workflow, "review"), "plan_review.md"),
    `<!-- generated:${new Date().toISOString()} -->\n${text}`,
    "utf-8",
  );

  const passed = text.includes(PASS);
  const rejected = text.includes(REJECT);
  const transitions = buildTransitions(getWorkflow(task.workflow)!);

  if (passed) {
    transition(taskId, "review_complete", { transitions, note: "评审通过" });
    return;
  }
  if (!rejected) {
    throw new Error("无法解析评审结论，请检查报告");
  }

  const reasonMatch = text.match(/## 驳回理由\n([\s\S]*?)(?=\n## |\s*$)/);
  const reason = reasonMatch ? reasonMatch[1].trim() : "请查看评审报告";
  const counts = getRejectionCounts(task);
  const newCount = (counts["plan"] ?? 0) + 1;
  counts["plan"] = newCount;

  const wf = getWorkflow(task.workflow);
  const reviewPhase = wf?.phases.find(
    (p) => !("parallel" in p) && (p as { name: string }).name === "review",
  ) as { max_rejections?: number } | undefined;
  const maxRejections = reviewPhase?.max_rejections ?? 3;

  if (newCount >= maxRejections) {
    transition(taskId, "cancel", {
      transitions,
      note: `评审驳回 ${newCount} 次，已取消`,
      extraUpdates: { rejection_counts: JSON.stringify(counts), rejection_reason: reason },
    });
    return;
  }

  transition(taskId, "review_reject", {
    transitions,
    note: `评审驳回（第 ${newCount} 次）`,
    extraUpdates: { rejection_counts: JSON.stringify(counts), rejection_reason: reason },
  });
  transition(taskId, "retry_plan", { transitions, note: `自动重做计划（第 ${newCount} 次驳回）` });
  runInBackground(taskId, "plan");
}
