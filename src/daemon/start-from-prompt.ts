import {
  createRequirement,
  getRequirementById,
  nextRequirementId,
  setRequirementStatus,
  updateRequirement,
  type Requirement,
} from "../core/requirements";
import { ensureDefaultProject } from "../core/projects";
import { getWorkspaceById } from "../core/workspaces";
import { startTaskFromTemplate } from "../core/task-factory";
import type { Task } from "../core/db";
import { runClarifierExtract } from "./requirement-extract";
import { createLogger } from "../core/logger";

const log = createLogger("start-from-prompt");

export { ensureDefaultProject };

export interface StartFromPromptOpts {
  rawText: string;
  workspace_id?: string | null;
  project_id?: string | null;
  workflow?: string;
}

export interface StartFromPromptResult {
  /** 串行入队路径：requirement 已建并 queued，task 由 scheduler 异步起，此时可能尚未生成。 */
  requirement?: Requirement;
  /** 纯 adhoc 路径：task 已同步起好。 */
  task?: Task;
}

/**
 * 快捷路径「先建需求再跑」：把一句话描述总结成真需求（进需求池），再让任务挂其下。
 *
 * - 有 workspace_id：走调度器（drafting→ready→queued），尊重同工作区串行，task 异步起。
 * - 无 workspace_id（纯 adhoc）：scheduler 不管它 → 这里直接 ready→queued 后同步 startTaskFromTemplate。
 *
 * 所有 DB 写都走 core helper，不在此直接写 SQL。
 */
export async function startTaskFromPrompt(opts: StartFromPromptOpts): Promise<StartFromPromptResult> {
  const rawText = opts.rawText?.trim();
  if (!rawText) throw new Error("startTaskFromPrompt: 缺 rawText");

  // 1. 解析 project_id
  let projectId: string;
  if (opts.workspace_id) {
    const ws = getWorkspaceById(opts.workspace_id);
    if (!ws) throw new Error(`startTaskFromPrompt: workspace ${opts.workspace_id} 不存在`);
    projectId = ws.project_id;
  } else if (opts.project_id) {
    projectId = opts.project_id;
  } else {
    projectId = ensureDefaultProject();
  }

  const workspaceId = opts.workspace_id ?? null;

  // 2. agent 抽取需求（永不抛，失败走 raw_text 兜底）
  const { title, spec_md } = await runClarifierExtract({
    raw_text: rawText,
    project_id: projectId,
    workspace_id: workspaceId,
  });

  // 3. 建需求（status 固定 drafting）
  const reqId = nextRequirementId();
  createRequirement({
    id: reqId,
    project_id: projectId,
    workspace_id: workspaceId,
    title,
    spec_md,
  });

  // 4 / 5. 推进状态机：drafting → ready → queued（不能直接 → queued）
  setRequirementStatus(reqId, "ready");
  setRequirementStatus(reqId, "queued");

  if (workspaceId) {
    // 有 workspace：queued 已触发 scheduler 异步起任务（尊重串行）。
    // 此时 task 可能还没起，返回 requirement 快照让调用方自行轮询。
    const requirement = getRequirementById(reqId) ?? undefined;
    return { requirement };
  }

  // 纯 adhoc：scheduler 跳过无 workspace 的需求 → 这里直接起。
  const task = await startTaskFromTemplate({
    workflow: opts.workflow ?? "ad-hoc",
    title,
    requirement: spec_md,
    requirement_id: reqId,
    workspace_id: workspaceId,
  });
  updateRequirement(reqId, { task_id: task.id });
  setRequirementStatus(reqId, "running");
  log.info("startTaskFromPrompt(adhoc): requirement %s → task %s", reqId, task.id);
  return { task };
}
