import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { atomicWriteSync } from "./atomic-write";
import { log } from "./logger";
import { isParallelPhase, type WorkflowDefinition, type PhaseDefinition, type ParallelDefinition, type WorkflowWorkspaceSpec } from "./registry";
import type { TransitionTable } from "./state-machine";

/** 动态读取 AUTOPILOT_HOME，支持测试中修改 env */
function getAutopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

// ──────────────────────────────────────────────
// Task manifest —— 每个任务的持久化权威状态
//
// 布局：
//   AUTOPILOT_HOME/runtime/tasks/<task-id>/task-manifest.json
//
// SQLite 的 tasks / task_logs 表是此文件的索引；丢了可从 manifest 重建。
// 设计参考 gsd 的 state-manifest.json：权威源在文件，DB 是缓存。
// ──────────────────────────────────────────────

export const MANIFEST_VERSION = 1;

export interface TransitionRecord {
  from: string;
  to: string;
  trigger: string;
  ts: string;
  note?: string | null;
}

/**
 * 工作流快照：从 WorkflowDefinition 中剥除不可序列化字段（函数、hooks）。
 * 任务引用的工作流文件后续被修改/删除也不影响这个历史记录。
 */
export interface WorkflowSnapshot {
  name: string;
  description?: string;
  initial_state: string;
  terminal_states: string[];
  phases: (PhaseDefinition | { parallel: ParallelDefinition })[];
  transitions?: TransitionTable;
  agents?: Record<string, unknown>[];
  workspace?: WorkflowWorkspaceSpec;
  config?: Record<string, unknown>;
  /** rebuild-manifest 给老任务补的结构性占位标记 */
  _legacy?: boolean;
  [key: string]: unknown;
}

export interface TaskManifest {
  version: typeof MANIFEST_VERSION;
  taskId: string;
  title: string;
  workflow: string;
  workflow_snapshot: WorkflowSnapshot;
  status: string;
  failure_count: number;
  channel: string;
  notify_target: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  parent_task_id: string | null;
  parallel_index: number | null;
  parallel_group: string | null;
  extra: Record<string, unknown>;
  transitions: TransitionRecord[];
}

const TASK_ID_RE = /^[\w.\-]+$/;

export function getManifestPath(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  return join(getAutopilotHome(), "runtime", "tasks", taskId, "task-manifest.json");
}

/**
 * 把 WorkflowDefinition 剥成可 JSON 序列化的快照。
 * 过滤：func（phase 函数引用）、hooks、setup_func、notify_func。
 */
export function snapshotWorkflow(wf: WorkflowDefinition): WorkflowSnapshot {
  const phases = wf.phases.map((p) => stripPhaseFuncs(p));
  const snap: WorkflowSnapshot = {
    name: wf.name,
    initial_state: wf.initial_state,
    terminal_states: wf.terminal_states,
    phases,
  };
  if (wf.description !== undefined) snap.description = wf.description;
  if (wf.transitions !== undefined) snap.transitions = wf.transitions;
  if (wf.agents !== undefined) snap.agents = wf.agents;
  if (wf.workspace !== undefined) snap.workspace = wf.workspace;
  if (wf.config !== undefined) snap.config = wf.config;
  return snap;
}

function stripPhaseFuncs(
  p: PhaseDefinition | { parallel: ParallelDefinition }
): PhaseDefinition | { parallel: ParallelDefinition } {
  if (isParallelPhase(p)) {
    return {
      parallel: {
        ...p.parallel,
        phases: p.parallel.phases.map((sub): PhaseDefinition => {
          const { func: _func, ...rest } = sub;
          return rest as PhaseDefinition;
        }),
      },
    };
  }
  const { func: _func, ...rest } = p;
  return rest as PhaseDefinition;
}

/**
 * 写入 manifest（原子）。
 *
 * 写失败走 best-effort：DB 是当前事务边界，manifest 失败不应阻塞 DB 写入。
 * 迁移完成前 DB 仍是主权威；迁移完成后 CI 会用 single-writer 测试确保所有写入
 * 都带 manifest 同步，此处的容错只是启动期容灾。
 */
export function writeManifest(manifest: TaskManifest): void {
  try {
    atomicWriteSync(getManifestPath(manifest.taskId), JSON.stringify(manifest, null, 2) + "\n");
  } catch (e: unknown) {
    log.warn("写入 task manifest 失败 [task=%s]：%s",
      manifest.taskId, e instanceof Error ? e.message : String(e));
  }
}

export function readManifest(taskId: string): TaskManifest | null {
  const p = getManifestPath(taskId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as TaskManifest;
    if (parsed.version !== MANIFEST_VERSION) {
      log.warn("task manifest 版本不匹配 [task=%s version=%s]", taskId, parsed.version);
      return null;
    }
    return parsed;
  } catch (e: unknown) {
    log.warn("读取 task manifest 失败 [task=%s]：%s",
      taskId, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * 合并 patch 到 manifest 并原子写回。manifest 不存在时返回 false（best-effort 跳过）。
 * 追加 transition 请用 appendTransition，语义更明确。
 */
export function updateManifest(
  taskId: string,
  patch: Partial<Omit<TaskManifest, "taskId" | "version" | "transitions" | "workflow" | "workflow_snapshot" | "created_at">>,
): boolean {
  const m = readManifest(taskId);
  if (!m) return false;
  const updated: TaskManifest = { ...m, ...patch };
  writeManifest(updated);
  return true;
}

/**
 * 追加一条 transition 到 manifest.transitions，并更新 status / updated_at / started_at。
 */
export function appendTransition(
  taskId: string,
  record: TransitionRecord,
  patch?: Partial<Pick<TaskManifest, "status" | "updated_at" | "started_at" | "extra" | "failure_count">>,
): boolean {
  const m = readManifest(taskId);
  if (!m) return false;
  const updated: TaskManifest = {
    ...m,
    ...patch,
    transitions: [...m.transitions, record],
  };
  writeManifest(updated);
  return true;
}

/**
 * 扫描 runtime/tasks/ 下所有含 task-manifest.json 的任务 ID。
 */
export function listManifestTaskIds(): string[] {
  const root = join(getAutopilotHome(), "runtime", "tasks");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const taskId of readdirSync(root)) {
    if (!TASK_ID_RE.test(taskId)) continue;
    if (existsSync(getManifestPath(taskId))) out.push(taskId);
  }
  return out;
}
