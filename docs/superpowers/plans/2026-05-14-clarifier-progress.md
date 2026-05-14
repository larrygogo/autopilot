# Clarifier 进度反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 RequirementDetail 上看到 AI 澄清当前是否在跑、跑了多久、第几次 LLM 调用、卡哪儿了，并能展开看本轮 prompt。

**Architecture:** 新建 `src/daemon/clarifier-progress.ts` 内存态 `Map<reqId, ClarifierRoundState>`，状态写函数同步 emit `requirement:clarifier-round-update` 事件。`runClarifierRound` 在 7 个关键点注入状态调用。HTTP `GET /api/requirements/:id/clarifier-round` 给前端首次/重连补拉。前端 RequirementDetail 接 WS 增量 + 1s 本地计时器 + 折叠 trace。

**Tech Stack:** Bun + TypeScript + bun:sqlite + React + WebSocket + bun:test

---

## File Structure

**Create:**
- `src/daemon/clarifier-progress.ts` — 内存态 Map + startRound / setPhase / endRound / getRound / listAllActive / _resetForTest，每次写入 emit
- `tests/clarifier-progress.test.ts` — 上述模块单测 + runClarifierRound 集成测试 + HTTP 端点测试

**Modify:**
- `src/core/events.ts` — `AutopilotEvent` union 加 `requirement:clarifier-round-update`
- `src/daemon/requirement-clarifier.ts` — `_runClarifierRoundInner` 注入 7 处 progress 调用 + outer `runClarifierRound` 的 finally 兜底 endRound
- `src/daemon/routes.ts` — `GET /api/requirements/:id/clarifier-round` 路由块
- `src/web/src/hooks/useApi.ts` — `ClarifierRoundState` 类型 + `api.getClarifierRound`
- `src/web/src/pages/RequirementDetail.tsx` — 替换现有 "AI 正在分析需求…" 区为进度卡 + WS 订阅 + 本地计时器 + 折叠 trace

---

## Task 1: 后端 progress 模块核心

**Files:**
- Create: `src/daemon/clarifier-progress.ts`
- Create: `tests/clarifier-progress.test.ts`

- [ ] **Step 1: 写失败测试 — 基础 startRound / getRound / listAllActive / endRound**

写 `tests/clarifier-progress.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { enableBus, disableBus, onEvent, offEvent } from "../src/core/event-bus";
import type { AutopilotEvent } from "../src/core/events";
import {
  startRound,
  setPhase,
  endRound,
  getRound,
  listAllActive,
  _resetForTest,
  type ClarifierRoundState,
} from "../src/daemon/clarifier-progress";

describe("clarifier-progress: 内存态 + 截断", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("startRound 后 getRound / listAllActive 返回 state，phase=preparing", () => {
    startRound("r1", "");
    const r = getRound("r1");
    expect(r?.req_id).toBe("r1");
    expect(r?.phase).toBe("preparing");
    expect(r?.attempt).toBe(0);
    expect(r?.prompt).toBe("");
    expect(r?.last_parse_error).toBeNull();
    expect(typeof r?.started_at).toBe("number");
    expect(listAllActive()).toHaveLength(1);
  });

  it("endRound('done') 后 getRound 返回 undefined（Map 已删）", () => {
    startRound("r1", "");
    endRound("r1", "done");
    expect(getRound("r1")).toBeUndefined();
    expect(listAllActive()).toHaveLength(0);
  });

  it("endRound 对不存在的 reqId no-op，不抛错", () => {
    expect(() => endRound("nope", "errored")).not.toThrow();
  });

  it("同 reqId 第二次 startRound 覆盖旧 entry，phase 重置 preparing，started_at 更新", async () => {
    startRound("r1", "first");
    const r1 = getRound("r1");
    const t1 = r1!.started_at;

    setPhase("r1", "calling-llm", { attempt: 0, prompt: "P1" });
    expect(getRound("r1")?.phase).toBe("calling-llm");

    // 等一毫秒确保 started_at 不同
    await new Promise(res => setTimeout(res, 2));
    startRound("r1", "second");
    const r2 = getRound("r1");
    expect(r2?.phase).toBe("preparing");
    expect(r2?.prompt).toBe("second");
    expect(r2?.started_at).toBeGreaterThan(t1);
  });

  it("prompt 长度 17000 字符 → 存储 16384 字符 + '…'", () => {
    const long = "a".repeat(17000);
    startRound("r1", long);
    const r = getRound("r1");
    expect(r?.prompt?.length).toBe(16385); // 16384 + '…'
    expect(r?.prompt?.endsWith("…")).toBe(true);
  });

  it("last_parse_error 长度超 16384 → 同样截断", () => {
    startRound("r1", "");
    const long = "x".repeat(17000);
    setPhase("r1", "parsing", { attempt: 1, last_parse_error: long });
    const r = getRound("r1");
    expect(r?.last_parse_error?.length).toBe(16385);
    expect(r?.last_parse_error?.endsWith("…")).toBe(true);
  });

  it("setPhase 不传 patch 仅改 phase 字段，其他字段保留", () => {
    startRound("r1", "p");
    setPhase("r1", "calling-llm", { attempt: 0, prompt: "p" });
    setPhase("r1", "writing");
    const r = getRound("r1");
    expect(r?.phase).toBe("writing");
    expect(r?.prompt).toBe("p");
    expect(r?.attempt).toBe(0);
  });

  it("setPhase 对不存在的 reqId no-op，不创建 entry", () => {
    setPhase("nope", "calling-llm");
    expect(getRound("nope")).toBeUndefined();
  });
});

describe("clarifier-progress: 事件发射", () => {
  beforeEach(() => {
    _resetForTest();
    enableBus();
  });

  it("startRound / setPhase / endRound 各 emit 一次 requirement:clarifier-round-update", () => {
    const events: AutopilotEvent[] = [];
    const handler = (e: AutopilotEvent) => events.push(e);
    onEvent("requirement:clarifier-round-update", handler);

    startRound("r1", "");
    setPhase("r1", "calling-llm", { attempt: 0, prompt: "P" });
    endRound("r1", "done");

    offEvent("requirement:clarifier-round-update", handler);
    disableBus();

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("requirement:clarifier-round-update");
    if (events[0].type === "requirement:clarifier-round-update") {
      expect(events[0].payload.phase).toBe("preparing");
    }
    if (events[1].type === "requirement:clarifier-round-update") {
      expect(events[1].payload.phase).toBe("calling-llm");
      expect(events[1].payload.prompt).toBe("P");
    }
    if (events[2].type === "requirement:clarifier-round-update") {
      expect(events[2].payload.phase).toBe("done");
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认全部失败**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: FAIL — 模块 `src/daemon/clarifier-progress` 不存在；类型 `ClarifierRoundState` 找不到；事件类型 `requirement:clarifier-round-update` 在 AutopilotEvent 里没定义。

- [ ] **Step 3: 在 events.ts 加事件类型（Task 2 会复用，先在这里加上让 Task 1 跑得通）**

修改 `src/core/events.ts`，在 `provider:health-changed` 那行之后、`// /now 推送事件` 之前插入：

```typescript
  // Clarifier 进度反馈（内存态，daemon 重启即清）
  | { type: "requirement:clarifier-round-update"; payload: import("../daemon/clarifier-progress").ClarifierRoundState }
```

完整段落上下文：

```typescript
  | { type: "requirement:clarifier-error"; payload: { id: string; reason: string } }
  // Provider 健康度（反应式）
  | { type: "provider:health-changed"; payload: { provider: string; healthy: boolean; reason?: string; ts: number } }
  // Clarifier 进度反馈（内存态，daemon 重启即清）
  | { type: "requirement:clarifier-round-update"; payload: import("../daemon/clarifier-progress").ClarifierRoundState }
  // /now 推送事件
```

- [ ] **Step 4: 实现 clarifier-progress.ts**

写 `src/daemon/clarifier-progress.ts`：

```typescript
/**
 * Clarifier 单轮进度的内存态。
 *
 * 每个 reqId 至多一个活跃 round（同 reqId 重复 startRound 覆盖）。
 * round 完结时（done / aborted / errored）emit 最后一次事件后立刻从 Map 删除 ——
 * trace 不持久化，daemon 重启即清。
 *
 * 用户痛点：dogfood 多次反馈"不知道 AI 在想什么"。此模块给前端实时反馈
 * 当前 round 处于哪个阶段、第几次 LLM 调用、本轮 prompt 是什么。
 */

import { emit } from "../core/event-bus";

export interface ClarifierRoundState {
  req_id: string;
  /** epoch ms，本轮开始时间 */
  started_at: number;
  phase: "preparing" | "calling-llm" | "parsing" | "writing" | "done" | "aborted" | "errored";
  /** 0 = 第一次尝试；1 = 重试（最多 2 次） */
  attempt: 0 | 1;
  /** 本轮 prompt，截断到 16384 字符 */
  prompt: string | null;
  /** attempt 0 失败时的 parse error，给 attempt 1 用户看；截断到 16384 字符 */
  last_parse_error: string | null;
}

const MAX_LEN = 16384;

function truncate(s: string | null | undefined): string | null {
  if (s == null) return null;
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN) + "…";
}

const _rounds = new Map<string, ClarifierRoundState>();

export function startRound(reqId: string, prompt: string): void {
  const state: ClarifierRoundState = {
    req_id: reqId,
    started_at: Date.now(),
    phase: "preparing",
    attempt: 0,
    prompt: truncate(prompt),
    last_parse_error: null,
  };
  _rounds.set(reqId, state);
  emit({ type: "requirement:clarifier-round-update", payload: state });
}

export function setPhase(
  reqId: string,
  phase: ClarifierRoundState["phase"],
  patch?: Partial<Pick<ClarifierRoundState, "attempt" | "prompt" | "last_parse_error">>,
): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  const next: ClarifierRoundState = {
    ...prev,
    phase,
    ...(patch?.attempt !== undefined ? { attempt: patch.attempt } : {}),
    ...(patch?.prompt !== undefined ? { prompt: truncate(patch.prompt) } : {}),
    ...(patch?.last_parse_error !== undefined ? { last_parse_error: truncate(patch.last_parse_error) } : {}),
  };
  _rounds.set(reqId, next);
  emit({ type: "requirement:clarifier-round-update", payload: next });
}

export function endRound(reqId: string, finalPhase: "done" | "aborted" | "errored"): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  const final: ClarifierRoundState = { ...prev, phase: finalPhase };
  // emit 终态后立刻删除：前端拿到终态事件 → setRound(null)
  emit({ type: "requirement:clarifier-round-update", payload: final });
  _rounds.delete(reqId);
}

export function getRound(reqId: string): ClarifierRoundState | undefined {
  return _rounds.get(reqId);
}

export function listAllActive(): ClarifierRoundState[] {
  return [..._rounds.values()];
}

export function _resetForTest(): void {
  _rounds.clear();
}
```

- [ ] **Step 5: 跑测试确认全部通过**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: PASS — 8 个用例全过（基础读写 / 删除 / no-op / 覆盖 / 截断 / 事件发射）

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS — 无类型错误

- [ ] **Step 7: Commit**

```bash
git add src/daemon/clarifier-progress.ts src/core/events.ts tests/clarifier-progress.test.ts
git commit -m "feat(clarifier-progress): 内存态 round state + emit 事件

新模块 src/daemon/clarifier-progress.ts 持有 Map<reqId, ClarifierRoundState>，
startRound / setPhase / endRound 每次写入同步 emit requirement:clarifier-round-update。
endRound emit 终态后立刻从 Map 删除（trace 不持久）。
prompt / last_parse_error 写入前截断到 16384 字符 + '…'。

core/events.ts 加事件类型 requirement:clarifier-round-update。

测试覆盖：基础读写、删除、no-op、同 reqId 覆盖、截断、事件发射。"
```

---

## Task 2: 注入 `runClarifierRound` 7 个进度点

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts`
- Modify: `tests/clarifier-progress.test.ts` (新增 describe 块)

- [ ] **Step 1: 写失败的集成测试**

向 `tests/clarifier-progress.test.ts` 末尾追加：

```typescript
// ─── runClarifierRound 集成测试 ─────────────────────────────────
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { up as m015 } from "../src/migrations/015-clarifier-error";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  setRequirementStatus,
  setActiveQuestionId,
} from "../src/core/requirements";
import { createQuestion } from "../src/core/requirement-questions";
import {
  runClarifierRound,
  _setClarifyFnForTest,
  _resetInflightForTest,
} from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("clarifier-progress: 集成 runClarifierRound", () => {
  beforeEach(() => {
    initSchema();
    _resetForTest();
    _resetInflightForTest();
    enableBus();
  });

  it("成功路径：preparing → calling-llm(att=0) → writing → done", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") {
        phases.push(e.payload.phase);
      }
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () =>
      JSON.stringify({
        new_spec_md: "改了",
        summary: "x",
        next_question: { agent_text: "Q1?", suggestions: [] },
        done: false,
      }),
    );

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);
    _setClarifyFnForTest(null);
    disableBus();

    expect(phases).toEqual(["preparing", "calling-llm", "writing", "done"]);
    expect(getRound("r1")).toBeUndefined(); // done 后立即删
  });

  it("parse 第一次失败、第二次成功：preparing → calling-llm(att=0) → parsing → calling-llm(att=1) → writing → done", async () => {
    const updates: { phase: string; attempt: number; last_parse_error: string | null }[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") {
        updates.push({
          phase: e.payload.phase,
          attempt: e.payload.attempt,
          last_parse_error: e.payload.last_parse_error,
        });
      }
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return calls === 1
        ? "不是 JSON"
        : JSON.stringify({
            new_spec_md: "改了",
            summary: "x",
            next_question: { agent_text: "Q?", suggestions: [] },
            done: false,
          });
    });

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);
    _setClarifyFnForTest(null);
    disableBus();

    const seq = updates.map(u => `${u.phase}/att${u.attempt}`);
    expect(seq).toEqual([
      "preparing/att0",
      "calling-llm/att0",
      "parsing/att1",
      "calling-llm/att1",
      "writing/att1",
      "done/att1",
    ]);
    const parsingUpdate = updates.find(u => u.phase === "parsing");
    expect(parsingUpdate?.last_parse_error).toBeTruthy();
  });

  it("两次都失败：preparing → calling-llm(att=0) → parsing → calling-llm(att=1) → errored", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") phases.push(e.payload.phase);
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => "totally not JSON");

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);
    _setClarifyFnForTest(null);
    disableBus();

    expect(phases).toEqual([
      "preparing",
      "calling-llm",
      "parsing",
      "calling-llm",
      "errored",
    ]);
    expect(getRound("r1")).toBeUndefined();
  });

  it("active_question_id race 早 abort：preparing → calling-llm → aborted（不写 writing/done）", async () => {
    const phases: string[] = [];
    const handler = (e: AutopilotEvent) => {
      if (e.type === "requirement:clarifier-round-update") phases.push(e.payload.phase);
    };
    onEvent("requirement:clarifier-round-update", handler);

    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "qst-pre", requirement_id: "r1", agent_text: "Q?", suggestions: [] });
    setActiveQuestionId("r1", "qst-pre");

    // mock LLM 返回前模拟并发 round 改了 active
    _setClarifyFnForTest(async () => {
      createQuestion({ id: "qst-concurrent", requirement_id: "r1", agent_text: "并发的", suggestions: [] });
      setActiveQuestionId("r1", "qst-concurrent");
      return JSON.stringify({
        new_spec_md: "改了",
        summary: "x",
        next_question: { agent_text: "Q?", suggestions: [] },
        done: false,
      });
    });

    await runClarifierRound("r1");

    offEvent("requirement:clarifier-round-update", handler);
    _setClarifyFnForTest(null);
    disableBus();

    expect(phases).toEqual(["preparing", "calling-llm", "aborted"]);
    expect(getRound("r1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认全部失败**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: FAIL — 集成测试断言 phase 序列与实际不符（当前实现完全没调 progress API）

- [ ] **Step 3: 修改 `src/daemon/requirement-clarifier.ts` 注入 7 个 progress 点**

读 `src/daemon/requirement-clarifier.ts` 找当前 `_runClarifierRoundInner` 的结构。

在文件顶部 import 段加：

```typescript
import {
  startRound,
  setPhase,
  endRound,
} from "./clarifier-progress";
```

修改 `_runClarifierRoundInner` 函数体，在以下位置插入调用（按代码顺序）：

**位置 A** — 通过 `req.status === "clarifying"` 校验后、`initialActiveQid = req.active_question_id;` 之前，加：

```typescript
  startRound(reqId, "");
```

**位置 B** — 找到 project 检查后早 return 那段：

```typescript
  if (!project) {
    log.warn("clarifier: req=%s 找不到项目，跳过", reqId);
    return;
  }
```

把它改成：

```typescript
  if (!project) {
    log.warn("clarifier: req=%s 找不到项目，跳过", reqId);
    endRound(reqId, "aborted");
    return;
  }
```

**位置 C** — `const prompt = buildPrompt(...)` 之后、`let result: ClarifyResult | null = null;` 之前，加：

```typescript
  setPhase(reqId, "calling-llm", { attempt: 0, prompt });
```

**位置 D** — for 循环里的 catch 块（`lastError = ...` 那段）改造。原来：

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await _clarifyFn(prompt, reqId);
      result = parseClarifyResult(raw);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn("clarifier: req=%s 第 %d 次解析失败: %s", reqId, attempt + 1, lastError.message);
    }
  }
```

改为：

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) {
        setPhase(reqId, "calling-llm", { attempt: 1 });
      }
      const raw = await _clarifyFn(prompt, reqId);
      result = parseClarifyResult(raw);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn("clarifier: req=%s 第 %d 次解析失败: %s", reqId, attempt + 1, lastError.message);
      if (attempt === 0) {
        setPhase(reqId, "parsing", { attempt: 1, last_parse_error: lastError.message });
      }
    }
  }
```

**位置 E** — `if (!result)` 块里 emit clarifier-error 那段。原来：

```typescript
  if (!result) {
    const reason = lastError?.message ?? "unknown error";
    updateRequirement(reqId, { clarifier_error: reason });
    emit({
      type: "requirement:clarifier-error",
      payload: { id: reqId, reason },
    });
    return;
  }
```

改为：

```typescript
  if (!result) {
    const reason = lastError?.message ?? "unknown error";
    updateRequirement(reqId, { clarifier_error: reason });
    emit({
      type: "requirement:clarifier-error",
      payload: { id: reqId, reason },
    });
    endRound(reqId, "errored");
    return;
  }
```

**位置 F** — status race 与 activeQid race 检查的 early return 那段。原来：

```typescript
  const reqAfter = getRequirementById(reqId);
  if (!reqAfter || reqAfter.status !== "clarifying") {
    log.info("clarifier: req=%s 状态已变（%s），AI 结果丢弃", reqId, reqAfter?.status ?? "deleted");
    return;
  }
  if (reqAfter.active_question_id !== initialActiveQid) {
    log.info(
      "clarifier: req=%s active_question_id 已被并发 round 改动（%s → %s），放弃本轮结果",
      reqId,
      initialActiveQid ?? "null",
      reqAfter.active_question_id ?? "null",
    );
    return;
  }
```

改为：

```typescript
  const reqAfter = getRequirementById(reqId);
  if (!reqAfter || reqAfter.status !== "clarifying") {
    log.info("clarifier: req=%s 状态已变（%s），AI 结果丢弃", reqId, reqAfter?.status ?? "deleted");
    endRound(reqId, "aborted");
    return;
  }
  if (reqAfter.active_question_id !== initialActiveQid) {
    log.info(
      "clarifier: req=%s active_question_id 已被并发 round 改动（%s → %s），放弃本轮结果",
      reqId,
      initialActiveQid ?? "null",
      reqAfter.active_question_id ?? "null",
    );
    endRound(reqId, "aborted");
    return;
  }
```

**位置 G** — 通过所有 race 检查、即将开始写 DB 之前。在两个 race 检查 + 紧跟的 `const oldSpec = ...` 那行之前加：

```typescript
  setPhase(reqId, "writing");
```

**位置 H** — `_runClarifierRoundInner` 函数尾（成功完成处）。原来函数末尾：

```typescript
  setActiveQuestionId(reqId, qId);
  emit({ type: "requirement:questions-updated", payload: { id: reqId } });
  log.info("clarifier: req=%s 提出下一个问题 qid=%s", reqId, qId);
}
```

改为：

```typescript
  setActiveQuestionId(reqId, qId);
  emit({ type: "requirement:questions-updated", payload: { id: reqId } });
  log.info("clarifier: req=%s 提出下一个问题 qid=%s", reqId, qId);
  endRound(reqId, "done");
}
```

**位置 H2** — 同函数里 `done=true` 分支也需要 endRound。原来：

```typescript
  if (result.done) {
    setActiveQuestionId(reqId, null);
    setRequirementStatus(reqId, "awaiting_approval");
    log.info("clarifier: req=%s 澄清完成，进入 awaiting_approval", reqId);
    return;
  }
```

改为：

```typescript
  if (result.done) {
    setActiveQuestionId(reqId, null);
    setRequirementStatus(reqId, "awaiting_approval");
    log.info("clarifier: req=%s 澄清完成，进入 awaiting_approval", reqId);
    endRound(reqId, "done");
    return;
  }
```

**位置 H3** — `if (!result.next_question)` 早 return 那段。原来：

```typescript
  if (!result.next_question) {
    log.warn("clarifier: req=%s done=false 但 next_question 为空，跳过", reqId);
    return;
  }
```

改为：

```typescript
  if (!result.next_question) {
    log.warn("clarifier: req=%s done=false 但 next_question 为空，跳过", reqId);
    endRound(reqId, "aborted");
    return;
  }
```

**位置 I** — 在 outer `runClarifierRound` 的 `finally` 兜底（防 `_runClarifierRoundInner` 抛错跳过任何 endRound）。

读现有 outer：

```typescript
export async function runClarifierRound(reqId: string): Promise<void> {
  log.info(...);
  if (_inflightRounds.has(reqId)) {...; return;}
  _inflightRounds.add(reqId);
  try {
    await _runClarifierRoundInner(reqId);
  } finally {
    _inflightRounds.delete(reqId);
    log.info(...);
  }
}
```

把 `finally` 块改成：

```typescript
  } finally {
    _inflightRounds.delete(reqId);
    // 兜底：inner 抛错跳过 endRound 时清理。Map 里没 entry 时是 no-op。
    endRound(reqId, "errored");
    log.info("clarifier: req=%s 释放锁，inflight=[%s]", reqId, [..._inflightRounds].join(","));
  }
```

注意：`endRound` 对不存在的 reqId 是 no-op（Task 1 测试覆盖），所以这里安全。

- [ ] **Step 4: 跑集成测试确认通过**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: PASS — 4 个集成用例（成功 / 重试成功 / 两次失败 / race abort）全部按 phase 序列断言通过

- [ ] **Step 5: 跑全量测试确保没破其他**

Run: `bun test`
Expected: PASS — 之前的 495 加上 Task 1 的 8 + Task 2 的 4 共 507。允许的小波动取决于已有用例数，但 0 fail。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/requirement-clarifier.ts tests/clarifier-progress.test.ts
git commit -m "feat(clarifier-progress): runClarifierRound 注入 7 个进度点

_runClarifierRoundInner 在以下位置调 clarifier-progress：
- 通过 status 校验后 startRound（phase=preparing）
- buildPrompt 后 setPhase(calling-llm, attempt=0, prompt)
- 解析失败 setPhase(parsing, attempt=1, last_parse_error)
- 进入 attempt=1 setPhase(calling-llm, attempt=1)
- race check 通过后 setPhase(writing)
- 写 question 完 endRound(done) / done=true 分支同
- project 缺失 / status race / activeQid race / next_question 空 → endRound(aborted)
- LLM 两次失败 → endRound(errored)

outer runClarifierRound 的 finally 调 endRound(errored) 兜底
（inner 抛错跳过任何 endRound 时清理；对已删 entry no-op）。

集成测试覆盖成功 / 重试成功 / 两次失败 / race abort 四条路径。"
```

---

## Task 3: HTTP API `GET /api/requirements/:id/clarifier-round`

**Files:**
- Modify: `src/daemon/routes.ts`
- Modify: `tests/clarifier-progress.test.ts`

- [ ] **Step 1: 写失败测试**

向 `tests/clarifier-progress.test.ts` 末尾追加：

```typescript
// ─── HTTP /api/requirements/:id/clarifier-round ─────────────────
import { handleRequest } from "../src/daemon/routes";

describe("HTTP GET /api/requirements/:id/clarifier-round", () => {
  beforeEach(() => {
    initSchema();
    _resetForTest();
  });

  it("当前有 round → 200 { round: <state> }", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    startRound("r1", "P");

    const res = await handleRequest(new Request("http://localhost/api/requirements/r1/clarifier-round"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { round: ClarifierRoundState | null };
    expect(body.round?.req_id).toBe("r1");
    expect(body.round?.phase).toBe("preparing");
    expect(body.round?.prompt).toBe("P");
  });

  it("当前无 round → 200 { round: null }", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });

    const res = await handleRequest(new Request("http://localhost/api/requirements/r1/clarifier-round"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { round: ClarifierRoundState | null };
    expect(body.round).toBeNull();
  });

  it("requirement 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/requirements/nope/clarifier-round"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: FAIL — 路由不存在，前两个用例返 404；第三个用例可能误中通配 404 但 body 不对。

- [ ] **Step 3: 在 routes.ts 加路由**

读 `src/daemon/routes.ts` 找 `POST /api/requirements/:id/retry-clarify` 那段（搜 `retry-clarify`）。

在 import 段加：

```typescript
import { getRound } from "./clarifier-progress";
```

在 `retry-clarify` 路由块**之前**插入：

```typescript
    // GET /api/requirements/:id/clarifier-round
    const clarifierRoundMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/clarifier-round$/);
    if (method === "GET" && clarifierRoundMatch) {
      const id = decodeURIComponent(clarifierRoundMatch[1]);
      if (!getRequirementById(id)) return error("requirement not found", 404);
      return json({ round: getRound(id) ?? null });
    }
```

注意路由顺序：必须在 `/api/requirements/:id` GET 详情之前，否则被吞掉。在 `retry-clarify` 之前是安全位置。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/clarifier-progress.test.ts`
Expected: PASS — 3 个 HTTP 用例（有 round / null / 404）全过

- [ ] **Step 5: 跑全量测试**

Run: `bun test`
Expected: PASS — 之前的 + 3，0 fail

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/routes.ts tests/clarifier-progress.test.ts
git commit -m "feat(clarifier-progress): GET /api/requirements/:id/clarifier-round

前端首次加载 / WS 重连时拉当前 round 状态。
返回 { round: ClarifierRoundState | null }。
requirement 不存在返 404。"
```

---

## Task 4: 前端 useApi 加类型 + helper

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1: 加类型 + helper**

读 `src/web/src/hooks/useApi.ts`，找 SpecRevision 类型定义那段（搜 `export interface SpecRevision`）。

在 SpecRevision 后面（紧邻它的下一空行）加：

```typescript
export interface ClarifierRoundState {
  req_id: string;
  started_at: number;
  phase: "preparing" | "calling-llm" | "parsing" | "writing" | "done" | "aborted" | "errored";
  attempt: 0 | 1;
  prompt: string | null;
  last_parse_error: string | null;
}
```

找 `api` 对象内 `listSpecRevisions` 这一项（搜 `listSpecRevisions:`）。在它之后加：

```typescript
  getClarifierRound: (id: string) =>
    request<{ round: ClarifierRoundState | null }>(`/api/requirements/${encodeURIComponent(id)}/clarifier-round`)
      .then((r) => r.round),
```

- [ ] **Step 2: 加到 NEW_API_PATTERNS**

找 `NEW_API_PATTERNS: RegExp[]` 数组，在 `/^\/api\/requirements\/[\w.\-]+\/spec-revisions$/,` 那行之后加：

```typescript
  /^\/api\/requirements\/[\w.\-]+\/clarifier-round$/,
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: build:web 确认 Vite/TS 没出问题**

Run: `bun run build:web`
Expected: 成功输出 web-dist，无 error

- [ ] **Step 5: Commit**

```bash
git add src/web/src/hooks/useApi.ts
git commit -m "feat(web): useApi 加 ClarifierRoundState 类型 + getClarifierRound

api.getClarifierRound(id) 调 GET /api/requirements/:id/clarifier-round
解 envelope 直接返回 round 或 null。
NEW_API_PATTERNS 加新 endpoint pattern（404 时给重启 daemon 提示）。"
```

---

## Task 5: 前端 RequirementDetail 进度卡 + WS 订阅 + 计时器 + trace 折叠

**Files:**
- Modify: `src/web/src/pages/RequirementDetail.tsx`

- [ ] **Step 1: 在 imports 段加类型 + Card 等组件 import 检查**

读 `src/web/src/pages/RequirementDetail.tsx` 顶部。`Card` / `Button` / `Loader2` / `cn` 应该已经 import 过。把现有从 `@/hooks/useApi` import 的那行扩展，加 `ClarifierRoundState`：

把：

```typescript
import { api, type Requirement, type RequirementFeedback, type RequirementSubPr, type Question, type Project, type Codebase, type ProviderItem } from "@/hooks/useApi";
```

改成：

```typescript
import { api, type Requirement, type RequirementFeedback, type RequirementSubPr, type Question, type Project, type Codebase, type ProviderItem, type ClarifierRoundState } from "@/hooks/useApi";
```

确认 `lucide-react` 那行已有 `ChevronRight`（若没有则加上）。

- [ ] **Step 2: 在主组件 state 区加 round state**

找 `RequirementDetail` 主函数体内 `const [questions, setQuestions] = useState<Question[]>([]);` 之类的 state 声明区。在某处（建议紧贴 `loading` / `req` 那批 state 后面）加：

```typescript
  const [round, setRound] = useState<ClarifierRoundState | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
```

- [ ] **Step 3: 首次加载时 fetch round**

找 `refresh` 函数（或类似的初次加载 Promise.all 那段）。它当前并行拉 listRepos / listRequirementSubPrs / listQuestions 等。在那个 Promise.all 中加 `api.getClarifierRound(id)`：

定位代码片段（搜 `api.listRequirementSubPrs`）：

```typescript
        api.listRepos(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
        api.listQuestions(id).catch(() => [] as Question[]),
```

注意：经 PR #59 后 listRepos 已改为 listCodebases。以实际代码为准。在这个 Promise.all 列表末尾加一项：

```typescript
        api.getClarifierRound(id).catch(() => null),
```

然后调用方 `.then(([repos, subPrs, qList]) => ...)` 也要扩展接收第 4 项。改成 `.then(([repos, subPrs, qList, rd]) => { ... setRound(rd); ... })`。

如果当前代码 destructure 形式不同（比如各自 await 而非 Promise.all），就在合适位置 await `api.getClarifierRound(id).catch(() => null)` 然后 setRound。

- [ ] **Step 4: 订阅 WS clarifier-round-update 事件**

找现有 WebSocket useEffect（搜 `subscribe(` 或 `useWebSocket`）。当前订阅了 `requirement:*` 频道。WS handler 已经处理 spec-revised / active-question-changed / clarifier-error 等。在它的 switch / if 链里加 `clarifier-round-update` 分支：

定位 handler 函数体内类似：

```typescript
        if (event.type === "requirement:spec-revised") { ... }
```

之后加：

```typescript
        if (event.type === "requirement:clarifier-round-update") {
          if (event.payload.req_id !== id) return;
          const phase = event.payload.phase;
          if (phase === "done" || phase === "aborted" || phase === "errored") {
            setRound(null);
          } else {
            setRound(event.payload);
          }
          return;
        }
```

`return` 是为避免 fall-through 触发后续 refresh（本事件不需要拉全量）。如果现有结构是 switch，按现有 pattern 写。

- [ ] **Step 5: 1s 本地计时器**

在 state 声明后、return 之前找合适位置加 useEffect：

```typescript
  useEffect(() => {
    if (!round) {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(Math.floor((Date.now() - round.started_at) / 1000));
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - round.started_at) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [round]);
```

- [ ] **Step 6: 进度卡组件**

紧邻 `RequirementDetail` 主函数前（与 `ClarifierOverrideDialog` 同级位置），加：

```typescript
const PHASE_LABEL: Record<ClarifierRoundState["phase"], string> = {
  preparing: "准备 prompt",
  "calling-llm": "调用 LLM 中",
  parsing: "解析返回（重试中）",
  writing: "写入 spec / 问题",
  done: "完成",
  aborted: "已中止",
  errored: "出错",
};

function ClarifierProgressCard({
  round,
  elapsedSec,
  traceOpen,
  onToggleTrace,
}: {
  round: ClarifierRoundState;
  elapsedSec: number;
  traceOpen: boolean;
  onToggleTrace: () => void;
}): React.ReactNode {
  const attemptLabel = round.attempt === 0 ? "第 1 次" : "第 2 次（重试）";
  return (
    <Card className="mb-6 p-5">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            AI 正在思考…
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
            {attemptLabel} LLM 调用 · 阶段：{PHASE_LABEL[round.phase]}
          </div>
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground shrink-0">
          已用 {elapsedSec}s
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleTrace}
        className="mt-3 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground hover:text-accent"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", traceOpen && "rotate-90")} />
        技术细节
      </button>

      {traceOpen && (
        <div className="mt-3 space-y-3">
          {round.last_parse_error && (
            <div className="border-[1.5px] border-l-4 border-foreground/30 border-l-destructive bg-card px-3 py-2 rounded-none">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive mb-1">
                上次解析失败
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {round.last_parse_error}
              </pre>
            </div>
          )}
          {round.prompt && (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
                本轮 Prompt
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground bg-muted/20 p-2 max-h-[400px] overflow-y-auto rounded-none border border-dashed border-foreground/25">
                {round.prompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 7: 替换现有 "AI 正在分析" 区**

找现有渲染段（搜 `AI 正在分析需求`）：

```jsx
      {!req.clarifier_error && req.status === "clarifying" && questions.length === 0 && (
        <Card className="mb-6 p-5">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
            <span className="flex-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              AI 正在分析需求，生成澄清问题…
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={retryingClarify}
              onClick={async () => { ... }}
              className="shrink-0"
            >
              {retryingClarify ? "重试中…" : "↻ 重试"}
            </Button>
          </div>
        </Card>
      )}
```

把它替换为两个分支：进度卡（round 在跑） + idle 兜底（round=null 但仍 clarifying）：

```jsx
      {!req.clarifier_error && req.status === "clarifying" && round && (
        round.phase === "preparing" || round.phase === "calling-llm" || round.phase === "parsing" || round.phase === "writing"
      ) && (
        <ClarifierProgressCard
          round={round}
          elapsedSec={elapsedSec}
          traceOpen={traceOpen}
          onToggleTrace={() => setTraceOpen((v) => !v)}
        />
      )}

      {!req.clarifier_error && req.status === "clarifying" && !round && questions.length === 0 && (
        <Card className="mb-6 p-5">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
            <span className="flex-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              AI 正在分析需求，生成澄清问题…
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={retryingClarify}
              onClick={async () => {
                if (!id) return;
                setRetryingClarify(true);
                try {
                  const res = await fetch(`/api/requirements/${encodeURIComponent(id)}/retry-clarify`, { method: "POST" });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                  }
                  toast.success("已重新触发 AI 澄清");
                  void refresh({ silent: true });
                } catch (e: unknown) {
                  toast.error("重试失败", (e as Error)?.message ?? String(e));
                } finally {
                  setRetryingClarify(false);
                }
              }}
              className="shrink-0"
            >
              {retryingClarify ? "重试中…" : "↻ 重试"}
            </Button>
          </div>
        </Card>
      )}
```

注意第二段是把现有 idle 卡完全保留，仅在 `!round` 时显示（round=null 表示 daemon 没在跑或本会话还没收到状态）。

- [ ] **Step 8: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 9: build:web**

Run: `bun run build:web`
Expected: 成功输出 web-dist

- [ ] **Step 10: 跑全量测试（前端改动不该破坏单测）**

Run: `bun test`
Expected: 与 Task 3 末尾相同的 pass 数 + 0 fail

- [ ] **Step 11: Commit**

```bash
git add src/web/src/pages/RequirementDetail.tsx
git commit -m "feat(web): RequirementDetail 进度卡 + 计时器 + trace 折叠

替换原 'AI 正在分析需求' spinner 为：
1. 当 round 在跑 (preparing/calling-llm/parsing/writing) 显示进度卡：
   - 阶段中文文案、第 N 次 LLM 调用、本地 1s tick 计时
   - '技术细节' 折叠展开 prompt 全文 + attempt 1 时露 last_parse_error
2. round=null 但仍 clarifying 时回退 idle 文案 + 重试按钮（兜底
   daemon 刚重启 / WS 断连未补拉 / 本会话首次进入但还没收事件）

WS 订阅 requirement:clarifier-round-update：
- payload.req_id !== 当前 id → 忽略
- phase ∈ {done, aborted, errored} → setRound(null)
- 其他 phase → setRound(payload)

refresh 时 Promise.all 加 api.getClarifierRound(id) 拉初始状态。"
```

---

## Task 6: 启 daemon 跑一次端到端 dogfood + Library 验收

**Files:** 无修改，纯验证。

- [ ] **Step 1: 重启 daemon**

Run: `bun run dev daemon restart`
Expected: daemon 退出 + 新进程启动 + status `uptime` 重置到几秒内

- [ ] **Step 2: 确认 daemon status**

Run: `bun run dev daemon status`
Expected: `daemon 运行中`，uptime < 30s

- [ ] **Step 3: GET 一个不存在的 req → 应 404**

Run (PowerShell):
```powershell
try { irm http://127.0.0.1:6180/api/requirements/no-such/clarifier-round } catch { "404 expected: $($_.ErrorDetails.Message)" }
```
Expected: 输出含 "requirement not found"

- [ ] **Step 4: GET 一个真实 req（当前空闲）→ round=null**

先取一个已存在的 req id（如 req-006）：

Run (PowerShell):
```powershell
$base = "http://127.0.0.1:6180"
irm "$base/api/requirements/req-006/clarifier-round" | ConvertTo-Json
```
Expected: `{ "round": null }`（除非此刻正好在跑 round，那就是个 ClarifierRoundState 对象）

- [ ] **Step 5: 主动触发 retry-clarify，立即查 round**

Run (PowerShell)：
```powershell
$base = "http://127.0.0.1:6180"
# 假设 req-006 当前 status=clarifying。如不是，替换成一个 clarifying 的 req id。
irm "$base/api/requirements/req-006/retry-clarify" -Method POST
# 立刻查
irm "$base/api/requirements/req-006/clarifier-round" | ConvertTo-Json -Depth 5
```
Expected: 第二个 irm 返回 `{ "round": { "req_id": "req-006", "phase": "calling-llm" 或 "preparing" 或 "writing", "attempt": 0, "started_at": <recent>, "prompt": "...", "last_parse_error": null } }`。phase 取决于 LLM call 进度。

如果 round.phase=null 或 round 本身为 null：说明 round 已经在几秒内跑完。OK，可以多试几次或换一个慢一些 prompt 的 req。

- [ ] **Step 6: 看 daemon 日志确认 progress 调用**

Run:
```bash
tail -30 ~/.autopilot/runtime/logs/daemon.log | grep -E "req-006|clarifier"
```
Expected: 出现 "clarifier: req=req-006 进入 runClarifierRound" + 后续 "提出下一个问题" 等日志（这些是 PR #61 加的）

- [ ] **Step 7: 退出 worktree（如本计划是在 worktree 里执行）**

如果当前 cwd 在 `.claude/worktrees/`，本步骤跳过；execution 框架最后会处理 worktree。
Otherwise 收尾用 `git status` 确认无 uncommitted 改动。

---

## 自检 (Plan Self-Review)

### Spec 覆盖

| Spec 节 | 实现 Task |
|---|---|
| §1 后端 progress 模块（state + 5 函数 + 截断 + 覆盖 + emit） | Task 1 |
| §2 runClarifierRound 7 个注入点 + finally 兜底 | Task 2 |
| §3 GET API | Task 3 |
| §4 前端 useApi + RequirementDetail 进度卡 + WS + 计时器 + trace 折叠 | Task 4 + Task 5 |
| §5 边界（daemon 重启 / WS 断连 / 覆盖 / 截断 / bus no-op） | Task 1（覆盖 + 截断）、Task 2（race abort）、Task 5（daemon 重启回退 idle）；WS 断连恢复依赖 Task 5 step 3 的 refresh 路径（重连后 useWebSocket 触发组件重渲染 → refresh 会重拉 round） |
| Spec §5 / 测试章 列出的所有 case | Task 1（前 7 个 case） + Task 2（成功/重试成功/两次失败/race abort）+ Task 3（HTTP 200/null/404） |

无缺口。

### Placeholder Scan

人工搜：无 "TBD" / "TODO" / "略" / "类似 Task N" / "implement later"。Task 5 Step 3 里 "以实际代码为准"是 fallback 描述，因为 PR #59 后 listRepos 改名了；实际操作时只需读现有代码定位 Promise.all 即可，不算 placeholder。

### Type 一致性

- `ClarifierRoundState` 前后端字段一致：`req_id` / `started_at` / `phase` / `attempt` / `prompt` / `last_parse_error`。
- phase union 8 个值前后端一致。
- 后端 `startRound(reqId, prompt)` 签名与 Task 2 调用一致。
- 后端 `setPhase(reqId, phase, patch?)` 签名与 Task 2 调用一致。
- 前端 `api.getClarifierRound` 返 `Promise<ClarifierRoundState | null>`，Task 5 用法对得上。

无不一致。
