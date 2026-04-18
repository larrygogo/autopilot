/**
 * Phase 产出归档：runner 在每个阶段（成功/失败）跑完后调用，把 agent 调用记录与
 * phase 日志按阶段写到 workspace/<NN-phase>/，让 UI 的 Workspace Tab 能直接看
 * 到任务的可观测产物，无需工作流作者手动 writeFileSync。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { getTaskWorkspace } from "./workspace";
import { isParallelPhase, type WorkflowDefinition } from "./registry";
import type { AgentCallRecord } from "./task-logs";

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function getPhaseIndex(workflow: WorkflowDefinition, phaseName: string): number {
  let idx = 0;
  for (const p of workflow.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) {
        if (sub.name === phaseName) return idx;
        idx++;
      }
    } else {
      if (p.name === phaseName) return idx;
      idx++;
    }
  }
  return -1;
}

function readAllAgentCalls(taskId: string): AgentCallRecord[] {
  const path = join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "agent-calls.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: AgentCallRecord[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as AgentCallRecord);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function readPhaseLogFull(taskId: string, phaseName: string): string {
  if (!PHASE_NAME_RE.test(phaseName)) return "";
  const path = join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "logs", `phase-${phaseName}.log`);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function fmtUsage(usage: AgentCallRecord["usage"]): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (typeof usage.input_tokens === "number") parts.push(`input=${usage.input_tokens}`);
  if (typeof usage.output_tokens === "number") parts.push(`output=${usage.output_tokens}`);
  if (typeof usage.total_cost_usd === "number") parts.push(`cost=$${usage.total_cost_usd.toFixed(4)}`);
  return parts.join(" · ");
}

function renderAgentTrace(phaseName: string, records: AgentCallRecord[]): string {
  const lines: string[] = [];
  lines.push(`# Phase: ${phaseName}`);
  lines.push("");
  lines.push(`共 ${records.length} 次 agent 调用`);
  lines.push("");

  for (const r of records) {
    const meta = [
      r.agent,
      r.provider ? `${r.provider}/${r.model ?? "?"}` : r.model,
      typeof r.elapsed_ms === "number" ? `${r.elapsed_ms} ms` : null,
      fmtUsage(r.usage),
    ].filter(Boolean).join(" · ");

    lines.push(`## #${r.seq} · ${r.ts}`);
    lines.push("");
    lines.push(`> ${meta}`);
    lines.push("");

    if (r.system_prompt) {
      lines.push("### System");
      lines.push("");
      lines.push("```");
      lines.push(r.system_prompt);
      lines.push("```");
      lines.push("");
    }

    if (r.additional_system) {
      lines.push("### Additional System");
      lines.push("");
      lines.push("```");
      lines.push(r.additional_system);
      lines.push("```");
      lines.push("");
    }

    lines.push("### Prompt");
    lines.push("");
    lines.push("```");
    lines.push(r.prompt ?? "");
    lines.push("```");
    lines.push("");

    if (r.error) {
      lines.push("### Error");
      lines.push("");
      lines.push("```");
      lines.push(r.error);
      lines.push("```");
      lines.push("");
    } else {
      lines.push("### Result");
      lines.push("");
      lines.push(r.result_text ?? "");
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 把指定 phase 的 agent 调用 + phase 日志归档到 workspace/<NN-phase>/。
 * 失败静默：归档异常不应阻塞主流程。
 *
 * @param taskId    任务 ID
 * @param workflow  工作流定义（用来算 phase 序号）
 * @param phaseName 阶段名（顶层或并行子阶段）
 */
export function archivePhaseArtifacts(
  taskId: string,
  workflow: WorkflowDefinition,
  phaseName: string,
): void {
  try {
    if (!PHASE_NAME_RE.test(phaseName)) return;

    const idx = getPhaseIndex(workflow, phaseName);
    if (idx < 0) return; // 未在 workflow 中找到（非常规调用），跳过

    const dirName = `${String(idx).padStart(2, "0")}-${phaseName}`;
    const phaseDir = join(getTaskWorkspace(taskId), dirName);
    if (!existsSync(phaseDir)) mkdirSync(phaseDir, { recursive: true });

    const allCalls = readAllAgentCalls(taskId);
    const phaseCalls = allCalls.filter((r) => r.phase === phaseName);
    if (phaseCalls.length > 0) {
      writeFileSync(join(phaseDir, "agent-trace.md"), renderAgentTrace(phaseName, phaseCalls), "utf-8");
    }

    const logContent = readPhaseLogFull(taskId, phaseName);
    if (logContent) {
      writeFileSync(join(phaseDir, "phase.log"), logContent, "utf-8");
    }
  } catch {
    /* 归档失败静默 */
  }
}
