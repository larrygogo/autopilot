/**
 * 声明式 phase 判据 / 分支的纯逻辑。无任何 I/O / DB / 状态机依赖——
 * prompt-runner 调本模块拿一个 DecisionAction，再去做薄 I/O。
 *
 * 框架只给"能声明判据关卡"的骨；判什么标记、reject 理由从哪段抽，全是用户在
 * workflow.yaml 的 decision 段里填的肉。
 */

/** 用户在 yaml phase.decision 里声明的判据。 */
export interface PhaseDecision {
  /** 判定"通过"的标记串（命中 → 走 complete_trigger，框架自动推进） */
  pass: string;
  /** 判定"驳回"的标记串（命中 → 回退 reject 目标重做） */
  reject: string;
  /** 可选：从 agent 输出抽驳回理由的 markdown 二级标题（如 "## 驳回理由"）。缺省取全文截断 */
  reason_section?: string;
  /** 标记匹配方式：contains（默认，子串包含）/ regex（正则） */
  match?: "contains" | "regex";
}

export type DecisionVerdict =
  | { verdict: "pass" }
  | { verdict: "reject"; reason: string }
  | { verdict: "ambiguous" };

/** 驳回理由全文兜底的截断上限 */
const REASON_CAP = 2000;

function markerHit(output: string, marker: string, mode: "contains" | "regex" | undefined): boolean {
  if (!marker) return false;
  if (mode === "regex") {
    try {
      return new RegExp(marker).test(output);
    } catch {
      return false;
    }
  }
  return output.includes(marker);
}

/**
 * 抽某 markdown 二级标题段的正文（到下一个 `^## ` 前 / 文末）。无该段返回 null。
 * heading 形如 "## 驳回理由"（带 ## 前缀）。
 */
export function extractMarkdownSection(output: string, heading: string): string | null {
  const name = heading.replace(/^#+\s*/, "").trim();
  if (!name) return null;
  const headers: Array<{ name: string; start: number; lineEnd: number }> = [];
  for (const m of output.matchAll(/^##\s+(.+?)\s*$/gm)) {
    const idx = m.index ?? 0;
    headers.push({ name: m[1].trim(), start: idx, lineEnd: idx + m[0].length });
  }
  const i = headers.findIndex((h) => h.name === name);
  if (i === -1) return null;
  const cur = headers[i];
  const next = headers[i + 1];
  const body = output.slice(cur.lineEnd, next ? next.start : output.length).trim();
  return body;
}

/** 判定 agent 输出：reject 优先于 pass（避免"PASS 但附带 REJECT 字样"误判通过）。 */
export function evaluatePhaseDecision(output: string, decision: PhaseDecision): DecisionVerdict {
  if (markerHit(output, decision.reject, decision.match)) {
    let reason = "";
    if (decision.reason_section) {
      reason = extractMarkdownSection(output, decision.reason_section) ?? "";
    }
    if (!reason) reason = output.trim().slice(0, REASON_CAP);
    return { verdict: "reject", reason };
  }
  if (markerHit(output, decision.pass, decision.match)) {
    return { verdict: "pass" };
  }
  return { verdict: "ambiguous" };
}

export interface PhaseDecisionMeta {
  /** phase 的 jump_trigger（reject: 语法糖生成，如 review_reject）。缺则视为未配回退目标 */
  jumpTrigger?: string;
  /** phase 的 jump_target（reject: 目标，如 design） */
  jumpTarget?: string;
  /** phase 的 max_rejections（缺省 10） */
  maxRejections?: number;
}

export type DecisionAction =
  | { kind: "pass" }
  | { kind: "ambiguous" }
  | {
      kind: "retry";
      jumpTrigger: string;
      retryTrigger: string;
      target: string;
      counts: Record<string, number>;
      reason: string;
      n: number;
    }
  | { kind: "fail"; counts: Record<string, number>; reason: string; n: number; maxRejections: number }
  | { kind: "misconfigured"; reason: string };

/**
 * 把判据结论翻成一个可执行动作（纯）。prompt-runner 据此做 I/O。
 *
 * @param phaseName 做判定的 phase 名（计数键 = 它自己的名，自包含）
 * @param currentCounts 当前 rejection_counts（来自 task.extra）
 */
export function planDecisionAction(
  output: string,
  decision: PhaseDecision,
  phaseName: string,
  meta: PhaseDecisionMeta,
  currentCounts: Record<string, number>,
): DecisionAction {
  const v = evaluatePhaseDecision(output, decision);
  if (v.verdict === "pass") return { kind: "pass" };
  if (v.verdict === "ambiguous") return { kind: "ambiguous" };

  // reject
  const counts = { ...currentCounts };
  const n = (counts[phaseName] ?? 0) + 1;
  counts[phaseName] = n;
  const maxRejections = meta.maxRejections ?? 10;
  if (n >= maxRejections) {
    return { kind: "fail", counts, reason: v.reason, n, maxRejections };
  }
  if (!meta.jumpTrigger || !meta.jumpTarget) {
    return {
      kind: "misconfigured",
      reason: `phase「${phaseName}」配了 decision.reject 但没有 reject 回退目标（需在 phase 上写 reject: <phase>）`,
    };
  }
  return {
    kind: "retry",
    jumpTrigger: meta.jumpTrigger,
    retryTrigger: `retry_${meta.jumpTarget}`,
    target: meta.jumpTarget,
    counts,
    reason: v.reason,
    n,
  };
}
