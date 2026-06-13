/**
 * 需求页 run 历史切换器的纯逻辑（v2 R6，可单测）。
 *
 * run = 现 Task 的语义降级（需求的执行历史项）。一个需求按 seq 升序排着：
 *  - execution 轮：主执行（dev 的 design→submit_pr）。第一次叫「执行」，重跑后叫「执行 #N」
 *  - fix 轮：fix_revision 触发的修复 run，叫「修复轮 #M」
 * N/M 是「同 kind 内第几个」的次序号，不是全局 seq —— 用户看到的是「第几次执行 / 第几轮修复」，
 * 不是数据库行号。内核名（TASK xxx · kind · seq）由 UI 在 tooltip 叠加露出，不在此替换。
 */

export interface RunLike {
  id: string;
  kind?: string | null;
  seq?: number | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  /** 部分 workflow 把交付 PR 落到 task.extra，存在时优先展示「✓ PR #号」 */
  pr_url?: string | null;
  pr_number?: number | null;
}

export type RunOutcomeTone = "done" | "failed" | "cancelled" | "active";

export interface RunOutcome {
  /** 状态点的语义色调（中性灰逻辑由组件按 tone 决定，不引入新色） */
  tone: RunOutcomeTone;
  /** 业务话结果文案 */
  text: string;
  /** done 且有交付 PR 时的跳转地址（点击在新标签打开） */
  prUrl?: string;
}

/** kind 规整：缺省 / 未知一律当 execution（历史数据无 kind 列时的兜底） */
export function normKind(kind?: string | null): "execution" | "fix" {
  return kind === "fix" ? "fix" : "execution";
}

/**
 * 计算每个 run 的业务标签（line-1 文案）。
 * 入参 runs 必须已按 seq 升序（listTasksByRequirement 的契约）；据此算同 kind 内的次序号。
 * 返回 Map<taskId, label>。
 */
export function computeRunLabels(runs: RunLike[]): Map<string, string> {
  const out = new Map<string, string>();
  let execCount = 0;
  let fixCount = 0;
  // 先数一遍 execution 总数 —— 只有一次执行时叫「执行」，多次才带 #N
  const totalExec = runs.filter((r) => normKind(r.kind) === "execution").length;
  for (const r of runs) {
    if (normKind(r.kind) === "fix") {
      fixCount += 1;
      out.set(r.id, `修复轮 #${fixCount}`);
    } else {
      execCount += 1;
      out.set(r.id, totalExec > 1 ? `执行 #${execCount}` : "执行");
    }
  }
  return out;
}

/** 单个 run 的业务标签（便捷封装；多次调用建议用 computeRunLabels 一次算好） */
export function runLabel(runs: RunLike[], taskId: string): string {
  return computeRunLabels(runs).get(taskId) ?? "执行";
}

const TERMINAL_FAILED = new Set(["failed"]);
const TERMINAL_CANCELLED = new Set(["cancelled", "canceled"]);

/**
 * 计算 run 的终态结果（line-2 文案 + 状态点色调）。
 *  - done + 有 pr_url → ✓ PR #号（可点跳转）
 *  - done 无 pr → ✓ 已交付
 *  - failed → ✗ 失败
 *  - cancelled → ⊘ 已取消
 *  - 其余（running/awaiting/pending…）→ ◴ 执行中… / 修复中…（按 kind）
 */
export function runOutcome(run: RunLike): RunOutcome {
  const s = run.status;
  if (s === "done") {
    if (run.pr_url) {
      const num = run.pr_number != null ? `#${run.pr_number}` : "PR";
      return { tone: "done", text: `✓ PR ${num}`, prUrl: run.pr_url };
    }
    return { tone: "done", text: "✓ 已交付" };
  }
  if (TERMINAL_FAILED.has(s)) return { tone: "failed", text: "✗ 失败" };
  if (TERMINAL_CANCELLED.has(s)) return { tone: "cancelled", text: "⊘ 已取消" };
  // 非终态：按 kind 区分「执行中」/「修复中」
  return {
    tone: "active",
    text: normKind(run.kind) === "fix" ? "◴ 修复中…" : "◴ 执行中…",
  };
}
