import { existsSync } from "fs";
import { getTask, listTaskPhaseEvents, getDb } from "../core/db";
import { createLogger } from "../core/logger";

const log = createLogger("task-outcome");

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface TopPhase {
  phase: string;
  duration_ms: number;
}

export interface TaskOutcome {
  task_id: string;
  status: "done" | "failed" | "cancelled";
  pr_url: string | null;
  pr_number: number | null;
  diff_stat: DiffStat | null;
  total_duration_ms: number;
  top_phases: TopPhase[];
  workspace_path: string | null;
  failure_reason: string | null;
}

/**
 * 聚合任务终态产出物。非终态返回 null。
 * 永不抛——任何子步骤失败走对应字段的 null/0 兜底。
 */
export async function computeTaskOutcome(taskId: string): Promise<TaskOutcome | null> {
  const task = getTask(taskId);
  if (!task) return null;

  const status = normalizeStatus(task.status);
  if (!status) return null;

  // 1) phase 耗时聚合
  const events = listTaskPhaseEvents(taskId);
  const phaseTotals = new Map<string, number>();
  for (const e of events) {
    if (e.ended_at === null) continue;
    const dur = e.ended_at - e.started_at;
    phaseTotals.set(e.phase, (phaseTotals.get(e.phase) ?? 0) + dur);
  }
  const total_duration_ms = [...phaseTotals.values()].reduce((a, b) => a + b, 0);
  const top_phases: TopPhase[] = [...phaseTotals.entries()]
    .map(([phase, duration_ms]) => ({ phase, duration_ms }))
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 3);

  // 2) PR 链接（从 requirement 拉）
  let pr_url: string | null = null;
  let pr_number: number | null = null;
  const reqId = (task as Record<string, unknown>).requirement_id as string | undefined;
  if (reqId) {
    try {
      const row = getDb()
        .query<{ pr_url: string | null; pr_number: number | null }, [string]>(
          "SELECT pr_url, pr_number FROM requirements WHERE id = ?"
        )
        .get(reqId);
      pr_url = row?.pr_url ?? null;
      pr_number = row?.pr_number ?? null;
    } catch (e: unknown) {
      log.warn("拉 PR 信息失败 [task=%s req=%s]: %s", taskId, reqId, e instanceof Error ? e.message : String(e));
    }
  }

  // 3) workspace + diff_stat
  const workspace_path = ((task as Record<string, unknown>).workspace_path as string | undefined) ?? null;
  let diff_stat: DiffStat | null = null;
  if (workspace_path && existsSync(workspace_path)) {
    const baseBranch = resolveBaseBranch(reqId);
    diff_stat = await computeDiffStat(workspace_path, baseBranch);
  }

  // 4) failure_reason
  let failure_reason: string | null = null;
  if (status === "failed") {
    try {
      const row = getDb()
        .query<{ note: string | null }, [string]>(
          "SELECT note FROM task_logs WHERE task_id = ? AND to_status = 'failed' ORDER BY id DESC LIMIT 1"
        )
        .get(taskId);
      failure_reason = row?.note ?? null;
    } catch {
      // tolerated
    }
  }

  return {
    task_id: taskId,
    status,
    pr_url,
    pr_number,
    diff_stat,
    total_duration_ms,
    top_phases,
    workspace_path,
    failure_reason,
  };
}

function normalizeStatus(s: string): TaskOutcome["status"] | null {
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null;
}

function resolveBaseBranch(reqId: string | undefined): string {
  if (!reqId) return "main";
  try {
    const row = getDb()
      .query<{ default_branch: string | null }, [string]>(
        "SELECT c.default_branch FROM requirements r JOIN workspaces c ON r.workspace_id = c.id WHERE r.id = ?"
      )
      .get(reqId);
    return row?.default_branch ?? "main";
  } catch {
    return "main";
  }
}

async function computeDiffStat(workspacePath: string, baseBranch: string): Promise<DiffStat | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const proc = Bun.spawn(["git", "diff", "--shortstat", `origin/${baseBranch}`], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode !== 0) return null;
    const stdout = await new Response(proc.stdout).text();
    const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return { files: 0, insertions: 0, deletions: 0 };
    return {
      files: parseInt(m[1]!, 10),
      insertions: parseInt(m[2] ?? "0", 10),
      deletions: parseInt(m[3] ?? "0", 10),
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}
