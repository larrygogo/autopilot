import { existsSync } from "fs";
import { getTask, listTaskPhaseEvents, getDb } from "../core/db";
import { listTaskRepos } from "../core/sandbox";
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

  // 2) PR 链接（取**本 run 自己的** pr_url —— 存于 task.extra，deliverPr 在 submit_pr 时回填）。
  //    刻意不从 requirement 拉：多 run 下 requirement.pr_url 只反映最新 run，否则历史 / 失败 run
  //    会借显最新 run 的 PR（dogfood req-023：失败的 run#1 误显 run#2 交付的 PR #96）。
  //    task 无独立 pr_number 列，从 url 解析。
  const reqId = (task as Record<string, unknown>).requirement_id as string | undefined;
  const ownPrUrl = (task as Record<string, unknown>).pr_url as string | undefined;
  const pr_url: string | null = ownPrUrl ?? null;
  const pr_number: number | null = pr_url ? (Number(pr_url.match(/\/pull\/(\d+)/)?.[1]) || null) : null;

  // 3) sandbox + diff_stat
  // 统一 multi-clone 布局：按 .worktree.json 的 repos 逐库统计（add -A + diff --cached
  // origin/<base>，覆盖 committed + 未提交 + 未跟踪）后求和。单库 = 长度 1；旧 mode=clone
  // 任务 listTaskRepos 返回根路径单项，行为与原 repo_path 直跑一致。
  // 无布局元数据（极旧任务）回退 repo_path 直跑。
  const repo_path = ((task as Record<string, unknown>).repo_path as string | undefined) ?? null;
  const sandbox_path =
    repo_path ?? ((task as Record<string, unknown>).workspace_path as string | undefined) ?? null;
  let diff_stat: DiffStat | null = null;
  let repos: ReturnType<typeof listTaskRepos> = [];
  try {
    repos = listTaskRepos(taskId).filter((r) => existsSync(r.path));
  } catch { /* 布局元数据读取失败 → 走 repo_path 兜底 */ }
  if (repos.length > 0) {
    for (const r of repos) {
      const s = computeDiffStat(r.path, r.base);
      if (!s) continue;
      if (!diff_stat) diff_stat = { files: 0, insertions: 0, deletions: 0 };
      diff_stat.files += s.files;
      diff_stat.insertions += s.insertions;
      diff_stat.deletions += s.deletions;
    }
  } else if (sandbox_path && existsSync(sandbox_path)) {
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

export interface FileDiff {
  file: string;
  insertions: number;
  deletions: number;
  /** 该文件的 unified diff（单文件超 60KB 截断；二进制为空串） */
  patch: string;
}

/**
 * 按文件返回任务 clone 工作树相对 base 的 diff（验收视图用）。
 * 取数方式与 computeDiffStat 一致（add -A + diff --cached origin/<base>）。
 */
export function computeFileDiffs(workspacePath: string, baseBranch: string): FileDiff[] {
  const run = (args: string[]) => Bun.spawnSync(["git", "-C", workspacePath, ...args], { stdout: "pipe", stderr: "pipe" });
  const text = (p: ReturnType<typeof Bun.spawnSync>) => (p.stdout ? new TextDecoder().decode(p.stdout) : "");
  try {
    run(["add", "-A"]);
    const ref = run(["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`]).exitCode === 0
      ? `origin/${baseBranch}` : baseBranch;
    const numstatProc = run(["diff", "--cached", "--numstat", "--no-ext-diff", ref]);
    if (numstatProc.exitCode !== 0) return [];
    const stats = new Map<string, { insertions: number; deletions: number }>();
    for (const line of text(numstatProc).split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      stats.set(m[3]!, {
        insertions: m[1] === "-" ? 0 : parseInt(m[1]!, 10),
        deletions: m[2] === "-" ? 0 : parseInt(m[2]!, 10),
      });
    }
    const fullProc = run(["diff", "--cached", "--no-ext-diff", ref]);
    const full = text(fullProc);
    // 按 "diff --git a/<path> b/<path>" 切块，块归属到 b 侧路径（新增/改名取目标名）
    const patches = new Map<string, string>();
    const blocks = full.split(/^(?=diff --git )/m);
    for (const block of blocks) {
      const head = block.match(/^diff --git a\/.+? b\/(.+)$/m);
      if (!head) continue;
      patches.set(head[1]!, block.length > 60_000 ? block.slice(0, 60_000) + "\n… (diff 过长已截断)" : block);
    }
    return [...stats.entries()].map(([file, s]) => ({
      file,
      insertions: s.insertions,
      deletions: s.deletions,
      patch: patches.get(file) ?? "",
    }));
  } catch {
    return [];
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
