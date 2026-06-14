# 声明式 phase 判据 / 分支 实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 勾选。
> 配套设计 spec：`docs/superpowers/specs/2026-06-14-declarative-phase-decision.md`（9 决策点已按推荐默认值定稿）。

**Goal:** 给 prompt 模式 phase 加声明式 `decision` 字段，让「调 agent → 判 PASS/REJECT → 驳回回退 → 触顶报人」这条最常见回路零代码（prompt-runner 自己判、自己调已存在的 `jump_trigger`/`retry_<target>`/`max_rejections` 转换），消灭手写 70 行 `run_review` 的断崖。

**Architecture:** 纯判据逻辑收进新 pure 模块 `src/core/phase-decision.ts`（可单测），prompt-runner 跑完 agent 后调它拿一个 `DecisionAction`，再做薄 I/O（transition/forceTransition/runInBackground）。**框架只给"能声明一个判据关卡"的骨；判什么、标记是什么全是用户填的肉**（见记忆 framework-bone-not-flesh）。opt-in、prompt 模式专属，有 `run_<phase>` TS 函数的工作流（dev/ad-hoc/__fix）零影响。

**Tech Stack:** Bun + TypeScript，bun:test，复用现有状态机转换（`reject:` 语法糖已生成 `<phase>_reject`/`retry_<target>`，`max_rejections` 字段已在）。

**定稿决策（spec §9）：** ①`reason_section` 缺省取全文+warn ②`${REJECTION}` 单列 ③本期不改 dev，先 `review_loop` 示例 ④`match` 先 contains、留 regex 字段位 ⑤contains 子串、文档建议独占行。

---

## 关键现状事实（实现前必读，已由主 agent 核实）

- **prompt 模式**：phase 无 `run_<phase>` TS 函数但 yaml 有 `prompt:` → `bindPhaseFunc`（`src/core/registry.ts:454-462`）启用 prompt-runner。
- **自动推进**：phase 函数啥都不做，`runner.ts:213-265` 自动 `complete_trigger` + `runInBackground(next)`；若 phase 函数自己 transition 走了（status ≠ `running_<phase>`），自动推进被守卫跳过。**decision reject/fail 分支正是靠"自己先 transition 走"来抑制自动推进。**
- **转换已就绪**：phase 配 `reject: design` → `buildTransitions` 已生成 `<phase>_reject`（running→`<phase>_rejected`）+ `retry_design`（→pending_design）；`max_rejections` 缺省 10。见 `registry.ts:226-237`、`592-607`。
- **存储**：`rejection_counts`/`rejection_reason` 非真列，`updateTask`（`db.ts:268-310`）把非 `TABLE_COLUMNS` 的 key 自动路由进 `extra` JSON；`getTask` 读时合并回来。照 dev workflow 一样 `updateTask({ rejection_counts: JSON.stringify(...), rejection_reason })` 即可。
- **透传**：`decision` 在文件 YAML 路径经 `expandPhase` 的 `{...phase}`（`registry.ts:217`）自动保留；DB-derive 路径（`registry.ts:793-809`）只 copy 白名单字段，需显式加 `decision`。
- **调用签名**（dev `workflow.ts` 现成范例）：`transition(taskId, trigger, { transitions, note, extraUpdates? })`、`forceTransition(taskId, "failed", reasonStr)`、`buildTransitions(wf)`、`notify(task, msg, "task-failed")`。
- **循环依赖**：runner → registry → prompt-runner；prompt-runner 取 `runInBackground` 必须用 `await import("./runner")`（动态）避免静态环。

---

## Task 1：可发现性止血（独立、零风险、先合）

补全编辑器 prompt 变量提示——很多"难写"其实是"不知道 `${HANDOFF}` 已经有了"。**不依赖 decision，先合**。

**Files:**
- Modify: `src/web/src/components/PhasePipelineEditor.tsx`（`PhaseEditForm` 的 prompt FormRow，约 `:1373-1383`）

- [ ] **Step 1：把 prompt placeholder/说明里的变量清单补全**

定位现有（约 `PhasePipelineEditor.tsx:1376`）：
```tsx
            placeholder={`填了 prompt 就不需要写 ts 函数；可用变量：\${TASK_TITLE} \${REQUIREMENT} \${WORKSPACE} \${PHASE}\n例：你是一位资深工程师。请根据 \${REQUIREMENT} 输出方案。`}
```
改为：
```tsx
            placeholder={`填了 prompt 就不需要写 ts 函数。\n可用变量：\${REQUIREMENT} 需求详情 · \${WORKSPACE} 代码目录 · \${HANDOFF} 上游各阶段交付摘要 · \${HANDOFF_<阶段名>} 指定阶段摘要 · \${REJECTION} 上次驳回理由（重做轮自动带） · \${TASK_TITLE} · \${PHASE} · \${TASK.<字段>}\n例：评审 \${HANDOFF_design} 是否满足 \${REQUIREMENT}。`}
```

并在该 FormRow 既有的说明 `<p>` 后补一句（定位现有 `yaml 写 prompt → 框架自动调用...` 那段 `:1382`，在其 `</p>` 前追加）：
```tsx
          {" "}上游产物用 ${HANDOFF}/${HANDOFF_<阶段>} 读，无需 readFileSync。
```

- [ ] **Step 2：构建验证**

Run: `bun run typecheck && bun run build:web`
Expected: 均通过（纯文案改动）。

- [ ] **Step 3：提交**

```bash
git add src/web/src/components/PhasePipelineEditor.tsx
git commit -m "feat(web): prompt 编辑器变量提示补全 \${HANDOFF}/\${REJECTION} 等

很多「prompt 难写」其实是不知道已有变量。补全 placeholder 变量清单 +
一句「上游产物用 \${HANDOFF} 读、无需 readFileSync」。声明式判据 spec 的可发现性止血步。"
```

---

## Task 2：纯判据逻辑模块 `phase-decision.ts`（核心，全可单测）

所有判据/计数/触顶/目标解析的**纯逻辑**收一处，prompt-runner 只做 I/O。

**Files:**
- Create: `src/core/phase-decision.ts`
- Test: `tests/phase-decision.test.ts`

- [ ] **Step 1：先写失败测试**

`tests/phase-decision.test.ts`：
```ts
import { describe, it, expect } from "bun:test";
import {
  evaluatePhaseDecision,
  extractMarkdownSection,
  planDecisionAction,
  type PhaseDecision,
} from "../src/core/phase-decision";

const D: PhaseDecision = { pass: "RESULT: PASS", reject: "RESULT: REJECT", reason_section: "## 驳回理由" };

describe("evaluatePhaseDecision", () => {
  it("pass 命中", () => {
    expect(evaluatePhaseDecision("一切良好\nRESULT: PASS", D)).toEqual({ verdict: "pass" });
  });
  it("reject 命中 → 抽 reason_section", () => {
    const out = "评审\nRESULT: REJECT\n## 驳回理由\n缺测试覆盖\n## 其他\nx";
    expect(evaluatePhaseDecision(out, D)).toEqual({ verdict: "reject", reason: "缺测试覆盖" });
  });
  it("reject 优先于 pass（两词都出现）", () => {
    const out = "RESULT: PASS 但其实 RESULT: REJECT\n## 驳回理由\n有坑";
    expect(evaluatePhaseDecision(out, D).verdict).toBe("reject");
  });
  it("reason_section 缺失 → 取全文截断", () => {
    const out = "RESULT: REJECT 没写理由段";
    const r = evaluatePhaseDecision(out, D);
    expect(r.verdict).toBe("reject");
    if (r.verdict === "reject") expect(r.reason).toContain("没写理由");
  });
  it("都不命中 → ambiguous", () => {
    expect(evaluatePhaseDecision("模型没按格式输出", D)).toEqual({ verdict: "ambiguous" });
  });
  it("match=regex", () => {
    const dr: PhaseDecision = { pass: "通过|PASS", reject: "驳回|REJECT", match: "regex" };
    expect(evaluatePhaseDecision("结论：通过", dr).verdict).toBe("pass");
  });
});

describe("extractMarkdownSection", () => {
  it("抽指定二级标题段到下一个 ## 前", () => {
    expect(extractMarkdownSection("## A\n1\n2\n## B\n3", "## A")).toBe("1\n2");
  });
  it("无该段返回 null", () => {
    expect(extractMarkdownSection("## A\n1", "## Z")).toBeNull();
  });
});

describe("planDecisionAction", () => {
  const meta = { jumpTrigger: "review_reject", jumpTarget: "design", maxRejections: 3 };
  it("pass → kind pass", () => {
    expect(planDecisionAction("RESULT: PASS", D, "review", meta, {})).toEqual({ kind: "pass" });
  });
  it("ambiguous → kind ambiguous", () => {
    expect(planDecisionAction("乱输出", D, "review", meta, {}).kind).toBe("ambiguous");
  });
  it("reject 未触顶 → retry，计数 +1", () => {
    const a = planDecisionAction("RESULT: REJECT\n## 驳回理由\nx", D, "review", meta, { review: 1 });
    expect(a).toMatchObject({ kind: "retry", jumpTrigger: "review_reject", retryTrigger: "retry_design", target: "design", n: 2 });
    if (a.kind === "retry") expect(a.counts.review).toBe(2);
  });
  it("reject 触顶（n≥max）→ fail", () => {
    const a = planDecisionAction("RESULT: REJECT\n## 驳回理由\nx", D, "review", meta, { review: 2 });
    expect(a).toMatchObject({ kind: "fail", n: 3, maxRejections: 3 });
  });
  it("reject 但无 jump 目标 → misconfigured", () => {
    const a = planDecisionAction("RESULT: REJECT", D, "review", { maxRejections: 10 }, {});
    expect(a.kind).toBe("misconfigured");
  });
});
```

Run: `bun test tests/phase-decision.test.ts` → Expected: FAIL（模块不存在）。

- [ ] **Step 2：实现 `src/core/phase-decision.ts`**

```ts
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
    try { return new RegExp(marker).test(output); } catch { return false; }
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
```

- [ ] **Step 3：跑测试通过**

Run: `bun test tests/phase-decision.test.ts` → Expected: PASS（全部）。

- [ ] **Step 4：提交**

```bash
git add src/core/phase-decision.ts tests/phase-decision.test.ts
git commit -m "feat(core): phase-decision 纯判据逻辑模块

evaluatePhaseDecision（reject 优先 / reason_section 抽取 / contains|regex）+
planDecisionAction（计数+1 / 触顶 fail / 回退 retry / 缺目标 misconfigured）。
纯函数零 I/O，全单测覆盖。prompt-runner 后续只做薄 I/O。"
```

---

## Task 3：`PhaseDefinition.decision` 类型 + DB-derive 透传

**Files:**
- Modify: `src/core/registry.ts`（PhaseDefinition 类型 `:24-65`；DB-derive merge `:793-809`）

- [ ] **Step 1：类型声明 + import**

`registry.ts` 顶部 import 区加：
```ts
import type { PhaseDecision } from "./phase-decision";
```
PhaseDefinition 接口里（`gate_message?` 之后、`handoff?` 之前）加：
```ts
  /**
   * 声明式判据 / 分支（仅 prompt 模式 phase 生效）。prompt-runner 跑完 agent 后按此判
   * pass/reject：pass → 框架自动推进；reject → 回退 reject: 目标重做、数驳回、触顶转 failed。
   * 复用 reject:/max_rejections 已生成的转换，不新增状态机机制。详见 phase-decision.ts。
   */
  decision?: PhaseDecision;
```

- [ ] **Step 2：DB-derive 路径透传 decision**

在 `registry.ts:801`（`if (typeof phaseObj.reject === "string")` 块）之后加：
```ts
    if (phaseObj.decision && typeof phaseObj.decision === "object") {
      merged.decision = phaseObj.decision as PhaseDecision;
    }
```

- [ ] **Step 3：验证类型**

Run: `bun run typecheck` → Expected: 通过。

- [ ] **Step 4：提交**

```bash
git add src/core/registry.ts
git commit -m "feat(core): PhaseDefinition.decision 类型 + DB-derive 透传

文件 YAML 路径经 expandPhase {...phase} 自动带 decision；DB-derive（派生工作流
覆写）路径只 copy 白名单字段，显式补 decision 透传。"
```

---

## Task 4：`${REJECTION}` / `${REJECTION_COUNT}` 模板变量

驳回回退后目标 phase 重做时拿到上次理由（取代 dev 手写 rejectionHistory）。

**Files:**
- Modify: `src/core/prompt-runner.ts`（`expandPromptTemplate` `:85-127`）
- Test: `tests/prompt-runner-template.test.ts`（若已存在则追加；否则新建）

- [ ] **Step 1：失败测试**

新建/追加 `tests/prompt-runner-template.test.ts`：
```ts
import { describe, it, expect } from "bun:test";
import { expandPromptTemplate } from "../src/core/prompt-runner";

describe("expandPromptTemplate · REJECTION", () => {
  const base = { taskId: "t1", phase: "design", workspaceRoot: "/tmp/x" };
  it("有驳回理由 → ${REJECTION} 注入；${REJECTION_COUNT} = 计数之和", () => {
    const out = expandPromptTemplate("上次驳回：${REJECTION}（第${REJECTION_COUNT}次）", {
      ...base,
      task: { rejection_reason: "缺测试", rejection_counts: JSON.stringify({ review: 2 }) },
    });
    expect(out).toBe("上次驳回：缺测试（第2次）");
  });
  it("无驳回 → ${REJECTION} 空串、${REJECTION_COUNT}=0", () => {
    const out = expandPromptTemplate("理由[${REJECTION}]次${REJECTION_COUNT}", { ...base, task: {} });
    expect(out).toBe("理由[]次0");
  });
});
```
Run: `bun test tests/prompt-runner-template.test.ts` → Expected: FAIL（变量未解析，原样保留）。

- [ ] **Step 2：在 `expandPromptTemplate` 的 `builtins` 里加两个变量**

`prompt-runner.ts` 的 `builtins` 对象（`:100-107`）追加：
```ts
    REJECTION: String(ctx.task["rejection_reason"] ?? ""),
    REJECTION_COUNT: String(sumRejectionCounts(ctx.task["rejection_counts"])),
```
并在文件内（`expandPromptTemplate` 之上）加 helper：
```ts
/** rejection_counts（task.extra 里的 JSON 串）所有值求和 = 总驳回轮数。 */
function sumRejectionCounts(raw: unknown): number {
  try {
    const o = JSON.parse(String(raw ?? "{}")) as Record<string, number>;
    return Object.values(o).reduce((a, b) => a + (Number(b) || 0), 0);
  } catch {
    return 0;
  }
}
```
> 注：`${REJECTION}` 走 `${VAR}` 正则（`:110`）的 `builtins[key]` 分支即可命中，无需改正则。

- [ ] **Step 3：测试通过**

Run: `bun test tests/prompt-runner-template.test.ts` → Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add src/core/prompt-runner.ts tests/prompt-runner-template.test.ts
git commit -m "feat(core): \${REJECTION}/\${REJECTION_COUNT} 模板变量

驳回回退后目标 phase 用 \${REJECTION} 拿上次理由（取代 dev 手写 rejectionHistory）。
\${REJECTION_COUNT}=rejection_counts 之和（总驳回轮数）。单列、YAGNI（spec 决策点 2）。"
```

---

## Task 5：prompt-runner 执行判据（薄 I/O）

跑完 agent → `planDecisionAction` → 执行（transition/forceTransition/runInBackground/notify）。

**Files:**
- Modify: `src/core/prompt-runner.ts`（import 区、`makePromptRunner` options + 末尾、`tryMakePromptRunnerForPhase`）

- [ ] **Step 1：补 import**

`prompt-runner.ts` import 区加（注意 `runInBackground` 动态 import，不在此处静态引）：
```ts
import { updateTask } from "./db";
import { transition, forceTransition } from "./state-machine";
import { buildTransitions, type PhaseDefinition } from "./registry";
import { notify } from "./notify";
import { planDecisionAction, type PhaseDecision } from "./phase-decision";
```
> `getTask`/`getWorkflow`/`getTaskArtifactsDir` 等已 import。`buildTransitions` 与已有 `getWorkflow` 同出 `./registry`，合并即可。

- [ ] **Step 2：`makePromptRunner` options 加 `decision`**

签名 options（`:259-264`）加：
```ts
    decision?: PhaseDecision;
```

- [ ] **Step 3：agent 循环 + handoff 写完后，加判据执行块**

在 `makePromptRunner` 返回函数体内、handoff 写入块（`:343-369`）之后、函数结束前追加：
```ts
    // ── 声明式判据 / 分支（spec 2026-06-14）──
    // pass：什么都不做，runner 自动 complete_trigger 推进。
    // reject：自己先 transition 走（抑制 runner 自动推进），回退重做 / 触顶 failed。
    if (options.decision) {
      const phaseDef = wf.phases.find(
        (p) => !("parallel" in p) && (p as PhaseDefinition).name === phaseName,
      ) as PhaseDefinition | undefined;
      const taskNow = getTask(taskId);
      const counts = parseRejectionCounts(taskNow as Record<string, unknown> | null);
      const action = planDecisionAction(finalText, options.decision, phaseName, {
        jumpTrigger: phaseDef?.jump_trigger,
        jumpTarget: phaseDef?.jump_target,
        maxRejections: phaseDef?.max_rejections,
      }, counts);

      if (action.kind === "ambiguous") {
        throw new Error(
          `phase「${phaseName}」无法解析判据结论：agent 输出既未含 pass 标记「${options.decision.pass}」也未含 reject 标记「${options.decision.reject}」`,
        );
      }
      if (action.kind === "misconfigured") {
        throw new Error(action.reason);
      }
      if (action.kind === "fail") {
        try {
          await notify(
            taskNow,
            `「${phaseDef?.label ?? phaseName}」反复驳回 ${action.n} 次（≥ ${action.maxRejections}），已暂停等待人工。最近理由：${action.reason.slice(0, 200)}`,
            "task-failed",
          );
        } catch { /* notify 失败不阻塞 */ }
        updateTask(taskId, { rejection_counts: JSON.stringify(action.counts), rejection_reason: action.reason });
        forceTransition(taskId, "failed", `${phaseName} 判据驳回 ${action.n} 次，已暂停等待人工`);
        return;
      }
      if (action.kind === "retry") {
        const transitions = buildTransitions(wf);
        updateTask(taskId, { rejection_counts: JSON.stringify(action.counts), rejection_reason: action.reason });
        transition(taskId, action.jumpTrigger, { transitions, note: `判据驳回（第${action.n}次）` });
        transition(taskId, action.retryTrigger, { transitions, note: `回退 ${action.target} 重做（第${action.n}次）` });
        const { runInBackground } = await import("./runner"); // 动态 import 破循环依赖
        runInBackground(taskId, action.target);
        return;
      }
      // action.kind === "pass" → 落空，runner 自动推进
    }
```
并在文件内加 helper（与 dev `getRejectionCounts` 同义）：
```ts
function parseRejectionCounts(task: Record<string, unknown> | null): Record<string, number> {
  if (!task) return {};
  try {
    return JSON.parse(String(task["rejection_counts"] ?? "{}")) as Record<string, number>;
  } catch {
    return {};
  }
}
```

- [ ] **Step 4：`tryMakePromptRunnerForPhase` 传 decision**

`:383-387` 的 `makePromptRunner(... { agent, timeoutSec, handoff })` 加：
```ts
    decision: (phase as Record<string, unknown>)["decision"] as PhaseDecision | undefined,
```

- [ ] **Step 5：类型 + 现有测试回归**

Run: `bun run typecheck && bun test tests/prompt-runner-template.test.ts tests/phase-decision.test.ts`
Expected: 通过；注意检查无 import 循环报错（`await import("./runner")` 应消除）。

- [ ] **Step 6：提交**

```bash
git add src/core/prompt-runner.ts
git commit -m "feat(core): prompt-runner 执行声明式判据分支

跑完 agent → planDecisionAction → 薄 I/O：pass 落空（runner 自动推进）/
reject 回退重做（transition jump+retry + runInBackground）/ 触顶 forceTransition
failed + notify / ambiguous|misconfigured throw。runInBackground 动态 import 破循环。
有 ts 函数的 phase 不进此路径，dev/ad-hoc/__fix 零影响。"
```

---

## Task 6：registry lint（配置错误前置报错）

**Files:**
- Modify: `src/core/registry.ts`（`expandPhase`，`reject`/`gate` 处理之后）
- Test: `tests/registry-decision-lint.test.ts`

- [ ] **Step 1：失败测试**

`tests/registry-decision-lint.test.ts`：
```ts
import { describe, it, expect } from "bun:test";
import { loadWorkflowFromYaml } from "../src/core/registry";

// loadWorkflowFromYaml(name, yamlText) —— 若项目里该入口名不同，用 registry 实际的 YAML 解析入口
function load(yaml: string) {
  return loadWorkflowFromYaml("lint_test", yaml);
}

describe("decision 配置 lint", () => {
  it("decision 但无 reject 目标 → 报错", () => {
    const yaml = `name: lint_test
phases:
  - name: review
    prompt: "判"
    decision: { pass: "P", reject: "R" }
`;
    expect(() => load(yaml)).toThrow(/reject.*目标|reject: <phase>/);
  });
  it("decision × gate 互斥 → 报错", () => {
    const yaml = `name: lint_test
phases:
  - name: design
    prompt: "做"
  - name: review
    reject: design
    gate: true
    prompt: "判"
    decision: { pass: "P", reject: "R" }
`;
    expect(() => load(yaml)).toThrow(/gate.*decision|互斥/);
  });
  it("decision 缺 pass/reject 字段 → 报错", () => {
    const yaml = `name: lint_test
phases:
  - name: design
    prompt: "做"
  - name: review
    reject: design
    prompt: "判"
    decision: { pass: "P" }
`;
    expect(() => load(yaml)).toThrow(/decision.*pass.*reject|reject 字段/);
  });
  it("合法 decision → 不报错", () => {
    const yaml = `name: lint_test
phases:
  - name: design
    prompt: "做"
  - name: review
    reject: design
    prompt: "判"
    decision: { pass: "P", reject: "R" }
`;
    expect(() => load(yaml)).not.toThrow();
  });
});
```
> 实现前先确认 registry 暴露的 YAML 加载入口实际名（grep `loadWorkflowFromYaml`/`parseWorkflowYaml`），测试 import 对齐。

Run: `bun test tests/registry-decision-lint.test.ts` → Expected: FAIL（暂不报错）。

- [ ] **Step 2：在 `expandPhase` 加 lint**

`registry.ts` 的 `expandPhase`，在 gate 相关处理之后、`return expanded as ...` 之前加：
```ts
  // 声明式判据 lint（author-time 配置错误前置报错）
  const decision = expanded["decision"] as Record<string, unknown> | undefined;
  if (decision !== undefined) {
    if (typeof decision !== "object" || decision === null) {
      throw new Error(`阶段 ${name} 的 decision 必须是对象`);
    }
    if (typeof decision["pass"] !== "string" || typeof decision["reject"] !== "string") {
      throw new Error(`阶段 ${name} 的 decision 必须同时含 pass 与 reject 字段（标记串）`);
    }
    if (expanded["gate"] === true) {
      throw new Error(`阶段 ${name} 不能同时配 gate 与 decision（gate=人工判，decision=agent 自动判，互斥）`);
    }
    if (!expanded["jump_target"]) {
      throw new Error(`阶段 ${name} 配了 decision.reject，但缺 reject 回退目标——请在该 phase 上写 reject: <目标阶段>`);
    }
  }
```
> `jump_target` 在 reject 语法糖处理（`:226-237`）已生成，故 lint 放其后能读到。

- [ ] **Step 3：测试通过**

Run: `bun test tests/registry-decision-lint.test.ts` → Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add src/core/registry.ts tests/registry-decision-lint.test.ts
git commit -m "feat(core): decision 配置 lint

author-time 前置报错：decision 缺 pass/reject、decision×gate 互斥、
decision.reject 无回退目标（缺 reject:）。"
```

---

## Task 7：`review_loop` 示例工作流 + 集成测试

声明式判据的活范例 + 端到端验证（spec 决策点 3：先示例不改 dev）。

**Files:**
- Create: `examples/workflows/review_loop/workflow.yaml`
- Create: `examples/workflows/review_loop/workflow.ts`（可为空壳或省略——全 prompt 模式无需 ts）
- Test: `tests/review-loop-decision.test.ts`

- [ ] **Step 1：写示例 workflow.yaml**

`examples/workflows/review_loop/workflow.yaml`：
```yaml
name: review_loop
label: 评审回路示例
description: 最小声明式判据示例——设计 → 评审（agent 判 PASS/REJECT）→ 通过则交付、驳回则回设计重做。全 prompt 模式、零 ts。
requires: { git: false }
delivers: artifacts
phases:
  - name: design
    timeout: 600
    handoff: true
    prompt: |
      你是方案设计者。根据 ${REQUIREMENT} 输出一份简短方案。
      ${REJECTION}
  - name: review
    timeout: 600
    reject: design
    max_rejections: 3
    prompt: |
      评审下面的方案是否满足 ${REQUIREMENT}：

      ${HANDOFF_design}

      最后必须独占一行输出 REVIEW_RESULT: PASS 或 REVIEW_RESULT: REJECT。
      若驳回，在 "## 驳回理由" 标题下写明问题。
    decision:
      pass: "REVIEW_RESULT: PASS"
      reject: "REVIEW_RESULT: REJECT"
      reason_section: "## 驳回理由"
```

- [ ] **Step 2：集成测试（mock agent，验证三条路径状态流转）**

`tests/review-loop-decision.test.ts`：用项目既有的 temp-DB + agent stub 模式（参考 `tests/clarifier-*.test.ts` / `tests/agent-inline.test.ts` 的夹具搭法）写三个用例：
1. review agent 输出含 `REVIEW_RESULT: PASS` → 任务推进到 review 之后（complete_trigger 生效，状态离开 `running_review`）。
2. review 输出 `REVIEW_RESULT: REJECT` + `## 驳回理由` → 状态回到 `pending_design`/`running_design`，`task.extra.rejection_reason` = 理由，`rejection_counts.review` = 1。
3. 连续 REJECT 至 `max_rejections=3` → 状态 `failed`，`status_reason` 含"判据驳回"。

> 测试用 agent stub 让 `agentForPhase(...).run()` 返回构造文本（mock `../src/agents/registry` 的 agentForPhase，或用项目既有 stub 工具）。断言读 `getTask(taskId).status` 与 extra 字段。
> 实现者先 grep 一个现成 prompt-runner / runner 集成测试（如有）对齐夹具；无则参照 `agent-inline.test.ts` 搭最小 runner 调用。

Run: `bun test tests/review-loop-decision.test.ts` → Expected: 起初 FAIL，补齐夹具与（如缺）示例发现后 PASS。

- [ ] **Step 3：确认示例能被发现 / 加载**

Run: `bun test tests/review-loop-decision.test.ts && bun run typecheck`
Expected: 通过。（示例工作流仅作 fixture，不要求装进 `~/.autopilot`。）

- [ ] **Step 4：提交**

```bash
git add examples/workflows/review_loop tests/review-loop-decision.test.ts
git commit -m "feat(examples): review_loop 声明式判据示例 + 集成测试

最小评审回路（design → review 判 PASS/REJECT → 通过交付 / 驳回回设计），
全 prompt 模式零 ts，作声明式判据的活范例 + 端到端三路径（pass/reject/触顶）测试。
dev 暂不改（spec 决策点 3）。"
```

---

## Task 8：Web 编辑器「判据 / 分支」段

把 decision 这块骨露成 affordance（prompt 模式 phase 才显示）。

**Files:**
- Modify: `src/web/src/components/PhasePipelineEditor.tsx`（`PhaseEditForm`，prompt FormRow 附近 `:1373+`）
- Modify: `src/web/src/hooks/useApi.ts`（若 PhaseRaw / 类型需加 decision 字段）

- [ ] **Step 1：PhaseRaw 类型加 decision（若有强类型）**

grep `PhaseRaw` 定义，给它加可选：
```ts
  decision?: { pass?: string; reject?: string; reason_section?: string; match?: "contains" | "regex" };
```

- [ ] **Step 2：PhaseEditForm 加「判据 / 分支」段**

在 prompt FormRow 之后插入（仅当该 phase 是 prompt 模式 / 无 ts 函数时显示，复用现有 `hasPrompt` 判定逻辑）：
```tsx
{typeof raw.prompt === "string" && raw.prompt.trim() && (
  <section className="mt-3 space-y-2 border-t border-border pt-3">
    <div className="text-[10px] font-medium text-muted-foreground">判据 / 分支（可选）</div>
    <p className="text-[10px] text-muted-foreground">
      让框架按 agent 输出自动判通过 / 驳回。判什么、用什么标记由你定；驳回会回退到下方「驳回目标」重做。
    </p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <FormRow label="通过标记">
        <Input
          value={raw.decision?.pass ?? ""}
          placeholder="如 REVIEW_RESULT: PASS"
          onChange={(e) => onChange({ decision: { ...(raw.decision ?? {}), pass: e.target.value || undefined } })}
        />
      </FormRow>
      <FormRow label="驳回标记">
        <Input
          value={raw.decision?.reject ?? ""}
          placeholder="如 REVIEW_RESULT: REJECT"
          onChange={(e) => onChange({ decision: { ...(raw.decision ?? {}), reject: e.target.value || undefined } })}
        />
      </FormRow>
    </div>
    <FormRow label="驳回理由段（可选）">
      <Input
        value={raw.decision?.reason_section ?? ""}
        placeholder="如 ## 驳回理由（留空取全文）"
        onChange={(e) => onChange({ decision: { ...(raw.decision ?? {}), reason_section: e.target.value || undefined } })}
      />
    </FormRow>
    <p className="text-[10px] text-muted-foreground">
      驳回目标 = 下方「驳回」字段（reject:）；驳回次数上限走 max_rejections（默认 10），触顶暂停报人。
    </p>
  </section>
)}
```
> 与现有 reject/max_rejections 字段并存：本段只配「判据」，回退目标仍由现有 reject 下拉提供（保持单一真相）。空 pass+reject → 不下发 decision（onChange 时若两者皆空可清空 decision，避免下发半截配置触发 lint）。

- [ ] **Step 3：清理空 decision（避免半截配置）**

在 onChange 写回处保证：pass 与 reject 都为空时删 decision 字段（传 `{ decision: undefined }`）。可在 PhaseEditForm 的 update 包一层归一化。

- [ ] **Step 4：构建验证**

Run: `bun run typecheck && bun run build:web` → Expected: 通过。

- [ ] **Step 5：提交**

```bash
git add src/web/src/components/PhasePipelineEditor.tsx src/web/src/hooks/useApi.ts
git commit -m "feat(web): 工作流编辑器「判据 / 分支」段

prompt 模式 phase 可视化配 decision（通过/驳回标记 + 驳回理由段），回退目标复用
现有 reject 字段。把声明式判据这块骨露成 affordance。"
```

---

## 全量回归

- [ ] **Step：跑全测 + typecheck + build**

Run: `bun test && bun run typecheck && bun run build:web`
Expected: 全绿。重点确认：dev/ad-hoc/__fix（有 ts 函数）行为不变、纯 prompt 无 decision 行为不变。

---

## Self-Review（写完即对照 spec）

- **spec 覆盖**：decision 字段(T3) / prompt-runner 判据(T2+T5) / `${REJECTION}`(T4) / lint(T6) / 示例(T7) / 编辑器(T8) / 可发现性止血(T1) —— 全部有任务。✓
- **类型一致**：`PhaseDecision`(phase-decision.ts) ← registry 引用、prompt-runner 引用；`DecisionAction` kind 字面量在 T2 定义、T5 消费一致。✓
- **决策点落地**：①reason 缺省取全文(T2 evaluatePhaseDecision) ②`${REJECTION}` 单列(T4) ③先 review_loop 不改 dev(T7) ④match contains 默认+regex 字段位(T2) ⑤contains 子串(T2)。✓
- **边界（骨非肉）**：全程只加"声明判据的能力 + affordance + 示例"，无内置 skill 库 / 内置 check 内容。✓
- **占位符扫描**：T7 集成测试夹具搭法依赖项目既有测试模式（已注明先 grep 对齐入口名 `loadWorkflowFromYaml` / agent stub），属实现期确认项而非占位逻辑。
