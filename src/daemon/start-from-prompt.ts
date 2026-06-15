import {
  createRequirement,
  getRequirementById,  setRequirementStatus,
  setRequirementWorkspaces,
  updateRequirement,
  type Requirement,
} from "../core/requirements";
import { ensureDefaultProject } from "../core/projects";
import { getWorkspaceById, listWorkspaces } from "../core/workspaces";
import { validateWorkflowInput } from "./workflow-declarations";
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
 * 工作区是否必需取决于**所选工作流的声明**（requires.git）：
 *   - 显式 workspace_id → 用它（其 project）
 *   - 否则取 project（opts.project_id 或兜底 proj-default）的顶层工作区（有就用）
 *   - 无工作区时按 validateWorkflowInput 判定：requires.git=true / delivers:pr 才拒，
 *     requires.git=false/"optional" 的工作流（如 review_loop）无库照样跑
 * 拿到（可能为空的）工作区后建需求 → 设 workflow + input_mode → drafting→ready→queued，
 * 由 scheduler 异步起任务（同工作区串行）。
 *
 * 所有 DB 写都走 core helper，不在此直接写 SQL。
 */
export async function startTaskFromPrompt(opts: StartFromPromptOpts): Promise<StartFromPromptResult> {
  const rawText = opts.rawText?.trim();
  if (!rawText) throw new Error("startTaskFromPrompt: 缺 rawText");

  // 1. 解析 project + workspace（workspace 现为可选，由工作流声明决定是否必需）
  let projectId: string;
  let workspaceId: string | null = null;
  if (opts.workspace_id) {
    const ws = getWorkspaceById(opts.workspace_id);
    if (!ws) throw new Error(`startTaskFromPrompt: workspace ${opts.workspace_id} 不存在`);
    projectId = ws.project_id;
    workspaceId = ws.id;
  } else {
    projectId = opts.project_id ?? ensureDefaultProject();
    const top = listWorkspaces({ projectId, includeSubmodules: false }).find(
      (w) => !w.parent_workspace_id,
    );
    workspaceId = top?.id ?? null;
  }

  // 工作流声明校验：requires.git=true 但无库、或 delivers:pr 但无库 → 拒（人话理由）。
  // requires.git=false/"optional" 的工作流无库放行。
  const reason = validateWorkflowInput(opts.workflow, workspaceId !== null, {
    crossCheckDelivers: true,
  });
  if (reason) {
    const e = new Error(reason);
    (e as { code?: string }).code = "WORKFLOW_INPUT";
    throw e;
  }

  // 2. agent 抽取需求（永不抛，失败走 raw_text 兜底；无库走纯文本模式）
  const { title, spec_md } = await runClarifierExtract({
    raw_text: rawText,
    project_id: projectId,
    workspace_id: workspaceId,
  });

  // 3. 建需求（status 固定 drafting）；id 由 createRequirement 原子生成（撞号重试）
  const reqId = createRequirement({ project_id: projectId, workspace_id: workspaceId, title, spec_md }).id;
  // 工作流（快捷路径 -w 指定；缺省 dev 由调度器消费 NULL）+ 代码库集合 / input_mode 同步：
  // 有库 → 'git'；无库 → 'none'（确认无库，clarifier/scheduler 走纯文本闭环）
  if (opts.workflow) updateRequirement(reqId, { workflow: opts.workflow });
  setRequirementWorkspaces(reqId, workspaceId ? [workspaceId] : []);

  // 4. drafting → ready → queued；queued 触发 scheduler 异步起任务（尊重同工作区串行）
  setRequirementStatus(reqId, "ready");
  setRequirementStatus(reqId, "queued");

  return { requirement: getRequirementById(reqId) as Requirement };
}
