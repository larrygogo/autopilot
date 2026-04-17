// ──────────────────────────────────────────────
// PhaseEditor 客户端校验 —— 和后端 setWorkflowPhases 的规则一致
// 后端校验是最终防线；此层只为即时反馈，避免一次 API 往返。
// ──────────────────────────────────────────────

export interface PhaseItem {
  kind: "phase";
  name: string;
  timeout?: number;
  reject?: string | null;
  extras: Record<string, unknown>;
}

export interface ParallelItem {
  kind: "parallel";
  name: string;
  fail_strategy?: string;
  phases: PhaseItem[];
}

export type Item = PhaseItem | ParallelItem;

export type IssueField = "name" | "timeout" | "reject" | "fail_strategy" | "phases";

export interface Issue {
  /** 顶层 index */
  idx: number;
  /** 并行子阶段 index（child 级时必填） */
  childIdx?: number;
  field: IssueField;
  message: string;
  /** 用户可见的定位标签，如 "phases[1]" / "dev/frontend" */
  path: string;
}

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const STRATEGIES = new Set(["cancel_all", "continue"]);

/**
 * 扫描 items 返回全部问题。空数组表示可以保存。
 */
export function validatePhases(items: Item[]): Issue[] {
  const issues: Issue[] = [];

  if (items.length === 0) {
    issues.push({ idx: 0, field: "phases", message: "至少需要一个阶段", path: "phases" });
    return issues;
  }

  // 收集全部 name，检测重名
  const nameCount = new Map<string, number>();
  const addName = (n: string) => nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  for (const it of items) {
    if (it.kind === "parallel") {
      addName(it.name);
      for (const sub of it.phases) addName(sub.name);
    } else {
      addName(it.name);
    }
  }

  // 可驳回的目标 name 集合：出现在当前顶层 idx 之前的所有阶段名（含并行块内）
  const seenBefore: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];

    if (it.kind === "parallel") {
      checkName(it.name, nameCount, issues, i, undefined, "name", `parallel[${i}] ${it.name || "<匿名>"}`);

      if (it.fail_strategy && !STRATEGIES.has(it.fail_strategy)) {
        issues.push({
          idx: i, field: "fail_strategy",
          message: `fail_strategy 必须是 cancel_all 或 continue`,
          path: `parallel[${i}] ${it.name}`,
        });
      }

      if (!Array.isArray(it.phases) || it.phases.length === 0) {
        issues.push({
          idx: i, field: "phases",
          message: "并行块至少需要一个子阶段",
          path: `parallel[${i}] ${it.name}`,
        });
      }

      for (let j = 0; j < (it.phases ?? []).length; j++) {
        const sub = it.phases[j];
        const label = `${it.name}/${sub.name || "<匿名>"}`;
        checkName(sub.name, nameCount, issues, i, j, "name", label);
        checkTimeout(sub.timeout, issues, i, j, label);
        // 并行内阶段的 reject 用法不受约束（暂不校验），保持简单
      }

      // 并行块名和其子阶段名都加入 seenBefore
      seenBefore.push(it.name);
      for (const sub of it.phases) seenBefore.push(sub.name);
    } else {
      const label = `phases[${i}] ${it.name || "<匿名>"}`;
      checkName(it.name, nameCount, issues, i, undefined, "name", label);
      checkTimeout(it.timeout, issues, i, undefined, label);

      if (it.reject) {
        if (!seenBefore.includes(it.reject)) {
          issues.push({
            idx: i, field: "reject",
            message: `reject 目标「${it.reject}」不存在或在当前阶段之后；驳回只能往回跳`,
            path: label,
          });
        }
      }
      seenBefore.push(it.name);
    }
  }

  return issues;
}

function checkName(
  name: string,
  nameCount: Map<string, number>,
  issues: Issue[],
  idx: number,
  childIdx: number | undefined,
  field: IssueField,
  path: string,
): void {
  if (!name || !name.trim()) {
    issues.push({ idx, childIdx, field, message: "名称不能为空", path });
    return;
  }
  if (!PHASE_NAME_RE.test(name)) {
    issues.push({ idx, childIdx, field, message: "须以小写字母开头，仅含小写字母 / 数字 / _", path });
    return;
  }
  if ((nameCount.get(name) ?? 0) > 1) {
    issues.push({ idx, childIdx, field, message: `名称「${name}」重复`, path });
  }
}

function checkTimeout(
  timeout: number | undefined,
  issues: Issue[],
  idx: number,
  childIdx: number | undefined,
  path: string,
): void {
  if (timeout === undefined || timeout === null) return;  // 可选
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(timeout)) {
    issues.push({
      idx, childIdx, field: "timeout",
      message: "超时必须是正整数（秒）",
      path,
    });
  }
}

// ──────────────────────────────────────────────
// 按位置取 issue —— Row 组件用
// ──────────────────────────────────────────────

export function issuesForTop(issues: Issue[], idx: number): Issue[] {
  return issues.filter((i) => i.idx === idx && i.childIdx === undefined);
}

export function issuesForChild(issues: Issue[], idx: number, childIdx: number): Issue[] {
  return issues.filter((i) => i.idx === idx && i.childIdx === childIdx);
}

export function fieldIssue(issues: Issue[], field: IssueField): Issue | undefined {
  return issues.find((i) => i.field === field);
}
