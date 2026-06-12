/**
 * artifact 探针工作流：非 PR 交付的最小闭环（零内核改动）。
 *
 * produce（gate 人工验收，驳回重做）→ deliver（归档出沙盒）。
 * 归档目录 AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/ ——
 * 不能放 runtime/requirements/<reqId>/（需求 done 时整目录被清），
 * 也不能留任务沙盒（done 即清 workspace）。
 *
 * 设计基准：docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md
 */

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "@autopilot/index";
import { getTask } from "@autopilot/core/db";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { agentForPhase } from "@autopilot/agents/registry";
import { getCurrentSandboxDir } from "@autopilot/core/task-context";
import { getTaskArtifactsDir } from "@autopilot/core/sandbox";
import { getPhaseIndex } from "@autopilot/core/artifacts";

const DELIVERABLES_DIR = "deliverables";

export function setup_artifact_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
  };
}

function sandboxRoot(task: NonNullable<ReturnType<typeof getTask>>): string {
  const root = getCurrentSandboxDir() ?? (task["repo_path"] as string | undefined);
  if (!root) throw new Error("拿不到沙盒目录（getCurrentSandboxDir 与 repo_path 都为空）");
  return root;
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

function phaseDir(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  if (idx < 0) throw new Error(`phase not found in workflow: ${phaseName}`);
  const dir = join(getTaskArtifactsDir(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// produce：agent 产出交付物，gate 挂起等人工验收
// ──────────────────────────────────────────────
//
// 末尾不主动 transition——runner 检测到 gate:true 自动挂到 awaiting_produce。

export async function run_produce(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const root = sandboxRoot(task);
  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();
  if (!requirement) throw new Error("任务 requirement 字段为空，请在创建任务时提供需求描述");

  // 人工 gate 驳回后重做：把驳回意见喂回 prompt
  let rejectionHistory = "";
  const decision = readLastUserDecision(task);
  if (decision?.phase === "produce" && decision.decision === "reject" && decision.note) {
    rejectionHistory =
      `\n\n## 上一轮人工驳回意见（${decision.ts}）\n${decision.note}\n\n` +
      `沙盒里 ${DELIVERABLES_DIR}/ 还保留着上一轮产物。请针对意见增量修改，不要推倒重来（除非意见明确要求）。`;
  }

  const prompt =
    `你是一位多面手创作者（设计 / 前端 / 文档均可）。请根据需求产出交付物。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 工作目录\n当前目录是参考仓库的克隆，仅供阅读参考。**不要修改仓库已有文件，不要 git commit / push。**\n\n` +
    `## 交付规则\n` +
    `1. 所有交付物写入 \`${DELIVERABLES_DIR}/\` 目录（不存在则创建）\n` +
    `2. 网页 demo = 自包含静态文件（单 html 或 html+css+js），双击可开，不依赖构建工具或服务器\n` +
    `3. 设计图 = svg，或可在浏览器直接打开的 html 画布\n` +
    `4. 最后写 \`${DELIVERABLES_DIR}/SUMMARY.md\`：交付了什么、每个文件是什么、怎么打开查看\n` +
    `5. 完成前自查：SUMMARY.md 列出的每个文件都真实存在且可打开` +
    rejectionHistory;

  const agent = agentForPhase(task.workflow, "produce");
  const result = await agent.run(prompt, { cwd: root, timeout: 1_800_000 });

  // agent 收尾自述落 artifacts，便于 Web 时间线排查
  writeFileSync(
    join(phaseDir(taskId, task.workflow, "produce"), "produce-notes.md"),
    `<!-- generated:${new Date().toISOString()} -->\n${result.text}`,
    "utf-8",
  );

  if (!existsSync(join(root, DELIVERABLES_DIR))) {
    throw new Error(`produce 完成但沙盒里没有 ${DELIVERABLES_DIR}/ 目录——agent 未按约定产出`);
  }
  // ↓ 不 transition：runner 自动 await_produce → awaiting_produce 等人工决断
}

// ──────────────────────────────────────────────
// deliver：机械归档（无 agent），把产物抄出沙盒
// ──────────────────────────────────────────────

export async function run_deliver(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const src = join(sandboxRoot(task), DELIVERABLES_DIR);
  if (!existsSync(src)) throw new Error(`找不到产物目录：${src}`);

  const reqId = (task["requirement_id"] as string | undefined) ?? "no-req";
  const dest = join(AUTOPILOT_HOME, "deliverables", reqId, taskId);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });

  const fileCount = readdirSync(dest, { recursive: true }).length;
  const wf = getWorkflow(task.workflow);
  if (!wf) throw new Error(`工作流不存在：${task.workflow}`);
  transition(taskId, "deliver_complete", {
    transitions: buildTransitions(wf),
    note: `产物已归档：${dest}（${fileCount} 项）`,
  });
}
