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
  sandbox_path: string | null;
  /** 进终态的原因（task_logs 最后一条进 failed/cancelled 的 note）；done 为 null。 */
  terminal_reason: string | null;
  /** 最近一次评审驳回原话（task.extra.rejection_reason，markdown）；无则 null。 */
  rejection_reason: string | null;
  /** 各评审阶段累计驳回次数（task.extra.rejection_counts）；无则 null。 */
  rejection_counts: Record<string, number> | null;
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

  // 3) sandbox + diff_stat
  // 共用沙盒模型下代码改动在任务 clone 工作树里（repo_path）。对它跑 git diff（add -A +
  // diff --cached <base>）统计 committed + 未提交 + 未跟踪新文件。
  const repo_path = ((task as Record<string, unknown>).repo_path as string | undefined) ?? null;
  const sandbox_path =
    repo_path ?? ((task as Record<string, unknown>).workspace_path as string | undefined) ?? null;
  let diff_stat: DiffStat | null = null;
  if (sandbox_path && existsSync(sandbox_path)) {
    const baseBranch = resolveBaseBranch(reqId);
    diff_stat = computeDiffStat(sandbox_path, baseBranch);
  }

  // 4) terminal_reason：failed / cancelled 都取最后一条进终态的 note（done 为 null）
  let terminal_reason: string | null = null;
  if (status === "failed" || status === "cancelled") {
    try {
      const row = getDb()
        .query<{ note: string | null }, [string]>(
          "SELECT note FROM task_logs WHERE task_id = ? AND to_status IN ('failed', 'cancelled', 'canceled') ORDER BY id DESC LIMIT 1"
        )
        .get(taskId);
      terminal_reason = row?.note ?? null;
    } catch {
      // tolerated
    }
  }

  // 5) 评审驳回详情（workflow 写在 task 顶层动态列里，getTask 已平铺）
  const taskRec = task as Record<string, unknown>;
  const rejection_reason = typeof taskRec.rejection_reason === "string" && taskRec.rejection_reason
    ? taskRec.rejection_reason : null;
  let rejection_counts: Record<string, number> | null = null;
  if (typeof taskRec.rejection_counts === "string" && taskRec.rejection_counts) {
    try {
      const parsed = JSON.parse(taskRec.rejection_counts);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rejection_counts = parsed as Record<string, number>;
      }
    } catch {
      // 坏 JSON 容错为 null
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
    sandbox_path,
    terminal_reason,
    rejection_reason,
    rejection_counts,
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

/**
 * 对任务 clone 工作树统计相对 base 的改动量。共用沙盒模型：先 git add -A（含未跟踪新文件）
 * 再 git diff --cached --shortstat <base> —— 覆盖 committed + 未提交 + 未跟踪。base 优先用
 * origin/<branch>（clone 后远程跟踪 ref 对非默认分支也在），解析不到回退本地分支名。
 */
export function computeDiffStat(workspacePath: string, baseBranch: string): DiffStat | null {
  const run = (args: string[]) => Bun.spawnSync(["git", "-C", workspacePath, ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    run(["add", "-A"]);
    const ref = run(["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`]).exitCode === 0
      ? `origin/${baseBranch}` : baseBranch;
    const proc = run(["diff", "--cached", "--shortstat", ref]);
    if (proc.exitCode !== 0) return null;
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return { files: 0, insertions: 0, deletions: 0 };
    return {
      files: parseInt(m[1]!, 10),
      insertions: parseInt(m[2] ?? "0", 10),
      deletions: parseInt(m[3] ?? "0", 10),
    };
  } catch {
    return null;
  }
}
