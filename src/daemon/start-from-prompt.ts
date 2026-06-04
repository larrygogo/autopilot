import {
  createRequirement,
  getRequirementById,
  nextRequirementId,
  setRequirementStatus,
  type Requirement,
} from "../core/requirements";
import { ensureDefaultProject } from "../core/projects";
import { getWorkspaceById, listWorkspaces } from "../core/workspaces";
import { runClarifierExtract } from "./requirement-extract";

export { ensureDefaultProject };

export interface StartFromPromptOpts {
  rawText: string;
  workspace_id?: string | null;
  project_id?: string | null;
  workflow?: string;
}

export interface StartFromPromptResult {
  /** requirement 已建并 queued，task 由 scheduler 异步起（尊重同工作区串行），此时可能尚未生成。 */
  requirement: Requirement;
}

/**
 * 快捷路径「先建需求再跑」：把一句话描述总结成真需求（进需求池），再让任务挂其下。
 *
 * 强制：必须有一个工作区才能跑（项目须关联工作区）。解析顺序：
 *   - 显式 workspace_id → 用它（其 project）
 *   - 否则取 project（opts.project_id 或兜底 proj-default）的顶层工作区
 *   - 项目无工作区 → 抛错（不允许无工作区运行）
 * 拿到工作区后建需求 → drafting→ready→queued，由 scheduler 异步起任务（同工作区串行）。
 *
 * 所有 DB 写都走 core helper，不在此直接写 SQL。
 */
export async function startTaskFromPrompt(opts: StartFromPromptOpts): Promise<StartFromPromptResult> {
  const rawText = opts.rawText?.trim();
  if (!rawText) throw new Error("startTaskFromPrompt: 缺 rawText");

  // 1. 解析 project + workspace（强制要求工作区）
  let projectId: string;
  let workspaceId: string;
  if (opts.workspace_id) {
    const ws = getWorkspaceById(opts.workspace_id);
    if (!ws) throw new Error(`startTaskFromPrompt: workspace ${opts.workspace_id} 不存在`);
    projectId = ws.project_id;
    workspaceId = ws.id;
  } else {
    projectId = opts.project_id ?? ensureDefaultProject();
    // 1:1：取该 project 的顶层工作区
    const top = listWorkspaces({ projectId, includeSubmodules: false }).find(
      (w) => !w.parent_workspace_id,
    );
    if (!top) {
      const e = new Error("项目未关联工作区，无法运行——请先给项目添加一个工作区");
      (e as { code?: string }).code = "NO_WORKSPACE";
      throw e;
    }
    workspaceId = top.id;
  }

  // 2. agent 抽取需求（永不抛，失败走 raw_text 兜底）
  const { title, spec_md } = await runClarifierExtract({
    raw_text: rawText,
    project_id: projectId,
    workspace_id: workspaceId,
  });

  // 3. 建需求（status 固定 drafting）
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: projectId, workspace_id: workspaceId, title, spec_md });

  // 4. drafting → ready → queued；queued 触发 scheduler 异步起任务（尊重同工作区串行）
  setRequirementStatus(reqId, "ready");
  setRequirementStatus(reqId, "queued");

  return { requirement: getRequirementById(reqId) as Requirement };
}
