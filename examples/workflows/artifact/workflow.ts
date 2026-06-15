/**
 * artifact 工作流：非 PR 交付的最小闭环（v2 R5 正式形态，原探针已升级）。
 *
 * produce（agent 产出到沙盒 deliverables/）→ deliver（deliverArtifacts promote 到需求
 * runtime/requirements/<reqId>/deliveries/round-<N>/ 并落 requirement_deliveries 表）。
 *
 * 验收不在 workflow 内（探针期的 produce gate hack 已移除）：run done 后框架判定
 * hasDeliveries → 需求转 awaiting_review，由 Web 验收卡 / CLI `req accept|reject` 人工
 * 通过（done）或驳回（fix_revision → __fix run artifacts 模式重做产物 promote round+1）。
 *
 * 设计基准：docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md
 *          + 2026-06-12-requirement-centric-architecture-v2.md（§3 acceptance 执行器）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTask } from "@autopilot/core/db";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/workflow/registry";
import { agentForPhase } from "@autopilot/agents/registry";
import { getCurrentSandboxDir } from "@autopilot/core/task-context";
import { getTaskArtifactsDir } from "@autopilot/core/sandbox";
import { deliverArtifacts } from "@autopilot/core/requirements/deliveries";
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
// produce：agent 产出交付物到沙盒 deliverables/
// ──────────────────────────────────────────────
//
// 末尾不手动 transition：runner 在阶段函数返回后自动 complete_trigger 推进 deliver。

export async function run_produce(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const root = sandboxRoot(task);
  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();
  if (!requirement) throw new Error("任务 requirement 字段为空，请在创建任务时提供需求描述");

  // 交付目录用**绝对路径**写进 prompt（dogfood req-020 实锤：相对指引下 agent 用
  // Write 工具时幻觉出 ~/deliverables 绝对路径，产物逃逸沙盒写进用户主目录）
  const deliverablesAbs = join(root, DELIVERABLES_DIR);
  const prompt =
    `你是一位多面手创作者（设计 / 前端 / 文档均可）。请根据需求产出交付物。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 工作目录\n当前目录下若有代码仓库克隆，仅供阅读参考。**不要修改仓库已有文件，不要 git commit / push。**\n\n` +
    `## 交付规则\n` +
    `1. 所有交付物写入此绝对路径目录（已存在）：\`${deliverablesAbs}\`\n` +
    `   ⚠ 写文件必须用上面的绝对路径前缀，不要写到任何其他位置（尤其不要写到用户主目录）\n` +
    `2. 网页 demo = 自包含静态文件（单 html 或 html+css+js），双击可开，不依赖构建工具或服务器\n` +
    `3. 设计图 = svg，或可在浏览器直接打开的 html 画布\n` +
    `4. 最后写 \`${join(deliverablesAbs, "SUMMARY.md")}\`：交付了什么、每个文件是什么、怎么打开查看\n` +
    `5. 完成前自查：SUMMARY.md 列出的每个文件都真实存在且可打开`;

  // 预创建交付目录（prompt 声明「已存在」，免去 agent mkdir 一步出错面）
  mkdirSync(deliverablesAbs, { recursive: true });

  const agent = agentForPhase(task.workflow, "produce");
  const result = await agent.run(prompt, { cwd: root, timeout: 1_800_000 });

  // agent 收尾自述落 artifacts，便于 Web 时间线排查
  writeFileSync(
    join(phaseDir(taskId, task.workflow, "produce"), "produce-notes.md"),
    `<!-- generated:${new Date().toISOString()} -->\n${result.text}`,
    "utf-8",
  );

  // 非空校验（仅查目录存在不够：req-020 中 agent mkdir 了空目录、产物写去了别处，
  // phase 误通过把锅甩给 deliver——早失败才能在 produce 轮内重做）
  const produced = existsSync(deliverablesAbs) ? readdirSync(deliverablesAbs) : [];
  if (produced.length === 0) {
    throw new Error(`produce 完成但 ${deliverablesAbs} 为空——agent 未按约定产出交付物`);
  }
}

// ──────────────────────────────────────────────
// deliver：机械交付（无 agent），promote 产物到需求 deliveries/ 并落表
// ──────────────────────────────────────────────

export async function run_deliver(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const src = join(sandboxRoot(task), DELIVERABLES_DIR);
  if (!existsSync(src)) throw new Error(`找不到产物目录：${src}`);

  // SUMMARY.md 作本轮交付摘要（验收 UI 展示）；读不到不阻塞
  let summary: string | undefined;
  try {
    summary = readFileSync(join(src, "SUMMARY.md"), "utf-8").slice(0, 2000);
  } catch { /* ignore */ }

  // promote 出沙盒：交付物生命周期属于需求；round = 现有 max+1（驳回重交递增）
  const delivery = deliverArtifacts(taskId, src, summary);

  const wf = getWorkflow(task.workflow);
  if (!wf) throw new Error(`工作流不存在：${task.workflow}`);
  transition(taskId, "deliver_complete", {
    transitions: buildTransitions(wf),
    note: `产物已交付：需求 ${delivery.requirement_id} 第 ${delivery.round} 轮（${delivery.path}/），等待需求级人工验收`,
  });
}
