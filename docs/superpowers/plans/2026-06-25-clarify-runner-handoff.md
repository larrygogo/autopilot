# Clarify Runner Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 clarify 阶段由 runner 自主决定「发问」还是「推进 spec」——agent 输出哨兵 JSON，runner 解析后产对应事件，不再依赖 reqgenie 大脑转发。

**Architecture:** clarify agent 在 prompt 末尾约定输出结构化哨兵 `<<<CLARIFY_RESULT>>>{"status":"need_input","questions":[...]}` 或 `{"status":"ready"}`；rounds.ts 解析哨兵产 `clarification_requested` 或新增 `stage_advance` 事件；session-loop.ts 处理 `stage_advance` 触发下一轮进 spec，同时加「重连幂等去重」避免重复建飞书卡。

**Tech Stack:** Bun, TypeScript strict, `bun:test`（vitest 语法兼容）

## Global Constraints

- TypeScript strict 模式；catch 块用 `catch (e: unknown)`，不得用 `catch (e: any)`
- 只动 `src/daemon/runner/` 下的文件与 `tests/runner-*.test.ts`；禁动 `src/core/executor`
- commit message 用中文
- `bun run typecheck` 净，`bun test` 全绿，既有测试不回归
- `stage_advance` 事件对 reqgenie 非自托管 backend 无害：reqgenie 只对自托管 + clarify→spec 才消费此事件，其他 backend 忽略即可，无需额外判断
- `runner-protocol-contract.test.ts` 的静态扫描测试（`RUNNER_EMITTED_EVENTS` 清单）需同步更新

---

### Task 1: types.ts — 加 stage_advance 事件类型 + wire 往返

**Files:**
- Modify: `src/daemon/runner/types.ts`

**Interfaces:**
- Produces:
  - `SessionEventType` 新增 `"stage_advance"` 字面量
  - `SessionEvent` 新增可选 `to_stage?: string`
  - `wireToSessionEvent` 从 `payload.to_stage` 提平到 `ev.to_stage`
  - `sessionEventToWireBody` 把 `to_stage` 写进 `payload.to_stage`

- [ ] **Step 1: 写失败测试**

在 `tests/runner-protocol-contract.test.ts` 末尾追加（先运行确认失败）：

```typescript
// ── stage_advance 协议往返 ──────────────────────────────────────────────
import { wireToSessionEvent, sessionEventToWireBody } from "../src/daemon/runner/types";
import type { WireEvent } from "../src/daemon/runner/types";

test("stage_advance：wireToSessionEvent 从 payload.to_stage 提平", () => {
  const w: WireEvent = { seq: 5, event_type: "stage_advance", payload: { to_stage: "spec" } };
  const ev = wireToSessionEvent(w);
  expect(ev.type).toBe("stage_advance");
  expect(ev.to_stage).toBe("spec");
});

test("stage_advance：sessionEventToWireBody 把 to_stage 写进 payload", () => {
  const ev = { seq: 0, type: "stage_advance" as const, to_stage: "spec" };
  const body = sessionEventToWireBody(ev);
  expect(body.event_type).toBe("stage_advance");
  expect(body.payload.to_stage).toBe("spec");
  expect("seq" in body).toBe(false);
});

test("clarification_requested：questions[] 经 wire 往返不丢失", () => {
  const ev = { seq: 0, type: "clarification_requested" as const, questions: ["q1", "q2"] };
  const body = sessionEventToWireBody(ev);
  expect(body.payload.questions).toEqual(["q1", "q2"]);
  // 反向：wire → flat（模拟 backend 喂来）
  const w2: WireEvent = { seq: 3, event_type: "clarification_requested", payload: { questions: ["a", "b"] } };
  const flat = wireToSessionEvent(w2);
  expect(flat.questions).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```
bun test tests/runner-protocol-contract.test.ts
```

预期：3 个新测试 FAIL（`to_stage` 字段不存在 / questions 未透传）

- [ ] **Step 3: 修改 types.ts**

在 `src/daemon/runner/types.ts` 中：

3a. `SessionEventType` 加 `"stage_advance"`：
```typescript
export type SessionEventType =
  | "assistant_message"
  | "clarification_requested"
  | "stage_advance"           // ← 新增
  | "stage_artifact"
  | "gate_opened"
  | "gate_decided"
  | "user_message"
  | "pr_created"
  | "limit_hit"
  | "session_failed";
```

3b. `SessionEvent` 加可选 `to_stage`（放在 `rework_target_stage` 下方）：
```typescript
export interface SessionEvent {
  seq: number;
  type: SessionEventType;
  text?: string;
  gate_id?: string;
  decision?: "approved" | "rejected";
  rework_target_stage?: SessionStage;
  to_stage?: string;           // ← 新增：stage_advance 携带的目标 stage
  questions?: string[];        // ← 新增：clarification_requested 的问题列表
  artifact?: { kind: string; content: string };
  pr?: { repo: string; branch_name: string; pr_url: string };
  [key: string]: unknown;
}
```

3c. `wireToSessionEvent` 加两行提平（在 `artifact` 提平之前）：
```typescript
if (typeof p.to_stage === "string") ev.to_stage = p.to_stage;
if (Array.isArray(p.questions)) ev.questions = p.questions as string[];
```

3d. `sessionEventToWireBody` 解构加 `to_stage, questions` 并写入 payload：
```typescript
export function sessionEventToWireBody(ev: SessionEvent): { event_type: string; stage?: string; actor: string; payload: Record<string, unknown> } {
  const { seq: _seq, type, text, gate_id, decision, rework_target_stage, to_stage, questions, artifact, pr, ...rest } = ev;
  const payload: Record<string, unknown> = { ...rest };
  if (text !== undefined) payload.message = text;
  if (gate_id !== undefined) payload.gate_id = gate_id;
  if (decision !== undefined) payload.decision = decision;
  if (rework_target_stage !== undefined) payload.rework_target_stage = rework_target_stage;
  if (to_stage !== undefined) payload.to_stage = to_stage;
  if (questions !== undefined) payload.questions = questions;
  if (artifact) { payload.kind = artifact.kind; payload.content = artifact.content; }
  if (pr) { payload.repo = pr.repo; payload.branch_name = pr.branch_name; payload.pr_url = pr.pr_url; }
  return { event_type: type, actor: "agent", payload };
}
```

- [ ] **Step 4: 运行测试，确认通过**

```
bun test tests/runner-protocol-contract.test.ts
```

预期：所有测试 PASS（含新增 3 个）

- [ ] **Step 5: typecheck**

```
bun run typecheck
```

预期：0 errors

- [ ] **Step 6: Commit**

```
git add src/daemon/runner/types.ts tests/runner-protocol-contract.test.ts
git commit -m "feat(runner): types 加 stage_advance + to_stage/questions wire 往返"
```

---

### Task 2: rounds.ts — clarify round 重写（哨兵解析 + 三分支产出）

**Files:**
- Modify: `src/daemon/runner/rounds.ts`

**Interfaces:**
- Produces（仅限本文件内使用，供 Task 3 测试验证行为）：
  - `parseClarifyResult(text: string): { status: "need_input"; questions: string[] } | { status: "ready" } | null`
  - `stripSentinel(text: string): string`
  - `runStageRound` clarify 分支新行为：
    - need_input + questions 非空 → `[{type:"assistant_message",text:stripped},{type:"clarification_requested",questions}]`
    - ready → `[{type:"assistant_message",text:stripped},{type:"stage_advance",to_stage:"spec"}]`
    - 解析失败/无哨兵 → `[{type:"assistant_message",text}]`（保守兜底）

**Consumes:** Task 1 新增的 `SessionEvent.to_stage` 和 `questions` 字段

- [ ] **Step 1: 写失败测试**

新建 `tests/runner-rounds.test.ts` 末尾追加（或在现有文件末尾追加）：

```typescript
// ── clarify 三分支产出 ──────────────────────────────────────────────────────
import { parseClarifyResult, stripSentinel } from "../src/daemon/runner/rounds";

test("parseClarifyResult：need_input + questions 非空", () => {
  const text = "探索了代码库……\n<<<CLARIFY_RESULT>>>{\"status\":\"need_input\",\"questions\":[\"q1\",\"q2\"]}";
  const r = parseClarifyResult(text);
  expect(r).toEqual({ status: "need_input", questions: ["q1", "q2"] });
});

test("parseClarifyResult：ready", () => {
  const text = "已充分了解\n<<<CLARIFY_RESULT>>>{\"status\":\"ready\"}";
  const r = parseClarifyResult(text);
  expect(r).toEqual({ status: "ready" });
});

test("parseClarifyResult：无哨兵返回 null", () => {
  expect(parseClarifyResult("普通回复，没有哨兵行")).toBeNull();
});

test("parseClarifyResult：哨兵 JSON 格式错误返回 null", () => {
  const text = "内容\n<<<CLARIFY_RESULT>>>not-json";
  expect(parseClarifyResult(text)).toBeNull();
});

test("parseClarifyResult：need_input questions 为空数组 → null（不发空问题）", () => {
  const text = "内容\n<<<CLARIFY_RESULT>>>{\"status\":\"need_input\",\"questions\":[]}";
  expect(parseClarifyResult(text)).toBeNull();
});

test("stripSentinel：去掉哨兵行，保留正文", () => {
  const text = "正文行1\n正文行2\n<<<CLARIFY_RESULT>>>{\"status\":\"ready\"}";
  expect(stripSentinel(text)).toBe("正文行1\n正文行2");
});

test("stripSentinel：无哨兵时原样返回", () => {
  expect(stripSentinel("没有哨兵")).toBe("没有哨兵");
});

test("clarify round：need_input + questions → clarification_requested（含 questions[]）", async () => {
  const evs = await runStageRound(baseSession("clarify"), stubDeps({
    runRoundAgent: async () => ({
      text: "探索代码……\n<<<CLARIFY_RESULT>>>{\"status\":\"need_input\",\"questions\":[\"接口是 REST 还是 GraphQL？\",\"要支持哪些认证方式？\"]}",
      usage: undefined,
    }),
  }));
  expect(evs[0]!.type).toBe("assistant_message");
  expect(evs[0]!.text).not.toContain("<<<CLARIFY_RESULT>>>");
  expect(evs[1]!.type).toBe("clarification_requested");
  expect(evs[1]!.questions).toEqual(["接口是 REST 还是 GraphQL？", "要支持哪些认证方式？"]);
  expect(evs.length).toBe(2);
});

test("clarify round：ready → stage_advance to_stage=spec", async () => {
  const evs = await runStageRound(baseSession("clarify"), stubDeps({
    runRoundAgent: async () => ({
      text: "代码库已充分探索，无歧义。\n<<<CLARIFY_RESULT>>>{\"status\":\"ready\"}",
      usage: undefined,
    }),
  }));
  expect(evs[0]!.type).toBe("assistant_message");
  expect(evs[0]!.text).not.toContain("<<<CLARIFY_RESULT>>>");
  expect(evs[1]!.type).toBe("stage_advance");
  expect(evs[1]!.to_stage).toBe("spec");
  expect(evs.length).toBe(2);
});

test("clarify round：无哨兵 → 保守兜底，只返回 assistant_message", async () => {
  const evs = await runStageRound(baseSession("clarify"), stubDeps({
    runRoundAgent: async () => ({ text: "普通回复没有哨兵", usage: undefined }),
  }));
  expect(evs.length).toBe(1);
  expect(evs[0]!.type).toBe("assistant_message");
  expect(evs[0]!.text).toBe("普通回复没有哨兵");
});
```

- [ ] **Step 2: 运行，确认失败**

```
bun test tests/runner-rounds.test.ts
```

预期：新增测试 FAIL（`parseClarifyResult`/`stripSentinel` 未导出；clarify 分支未改）

- [ ] **Step 3: 实现 parseClarifyResult 和 stripSentinel，更新 clarify 分支**

在 `src/daemon/runner/rounds.ts` 中，在 `deliveryBranchFor` 函数下方、`STAGE_SYSTEM` 上方插入：

```typescript
const CLARIFY_SENTINEL = "<<<CLARIFY_RESULT>>>";

/** 从 agent 输出末行解析结构化哨兵 JSON。返回 null = 无哨兵或格式错误（保守兜底）。 */
export function parseClarifyResult(
  text: string,
): { status: "need_input"; questions: string[] } | { status: "ready" } | null {
  const lines = text.split("\n");
  const sentinelLine = lines.findLast((l) => l.startsWith(CLARIFY_SENTINEL));
  if (!sentinelLine) return null;
  const jsonStr = sentinelLine.slice(CLARIFY_SENTINEL.length).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(jsonStr); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.status === "ready") return { status: "ready" };
  if (
    p.status === "need_input" &&
    Array.isArray(p.questions) &&
    (p.questions as unknown[]).length > 0 &&
    (p.questions as unknown[]).every((q) => typeof q === "string")
  ) {
    return { status: "need_input", questions: p.questions as string[] };
  }
  return null;
}

/** 去掉哨兵行（含哨兵行本身），返回正文。 */
export function stripSentinel(text: string): string {
  const idx = text.lastIndexOf("\n" + CLARIFY_SENTINEL);
  if (idx !== -1) return text.slice(0, idx);
  if (text.startsWith(CLARIFY_SENTINEL)) return "";
  return text;
}
```

更新 `STAGE_SYSTEM.clarify`（加哨兵协议说明）：

```typescript
const STAGE_SYSTEM: Record<SessionStage, string> = {
  clarify: `你在澄清阶段：读代码库与需求，能从代码答的不要问用户，仅就真正阻塞的歧义提问。只读探索、不改文件。

完成探索后，**必须**在回复末尾单独一行输出哨兵（格式精确，不含多余空格）：
- 仍有阻塞歧义需要用户确认时：
  <<<CLARIFY_RESULT>>>{"status":"need_input","questions":["问题1","问题2"]}
- 信息已足够推进方案时：
  <<<CLARIFY_RESULT>>>{"status":"ready"}

注意：questions 数组只放真正阻塞的问题，代码已能回答的不问。`,
  spec: "你在方案阶段：产出实现方案文档（spec_md）。只读探索、不改文件。",
  eng_review: "你在工程评审阶段：审查方案的工程可行性并产出评审意见。只读探索、不改文件。",
  ui_review: "你在 UI 评审阶段：审查交互/视觉并产出评审意见。只读探索、不改文件。",
  dev: "你是资深工程师：在工作树里实现需求并自查，只改文件不要 commit/push。",
  pr: "你在交付阶段：整理改动说明。",
  done: "",
};
```

将 `rounds.ts` 中的 clarify 分支（第 89-96 行）替换为：

```typescript
  if (stage === "clarify") {
    const { root } = await deps.ensureCodebase(session.id, toWsRefs(session.repos), { fidelity: "shallow" });
    const ctx: RoundAgentCtx = { sessionId: session.id, phase: "clarify", sandboxDir: root };
    const res = await deps.runRoundAgent(ctx, agent, `${STAGE_SYSTEM.clarify}\n${buildPrompt(session, deps)}`);
    const clarifyResult = parseClarifyResult(res.text);
    const stripped = stripSentinel(res.text);
    const assistantMsg: SessionEvent = { seq: 0, type: "assistant_message", text: stripped };
    if (clarifyResult === null) {
      // 无哨兵或解析失败：保守兜底，不瞎推进、不发空问题
      return [assistantMsg];
    }
    if (clarifyResult.status === "need_input") {
      return [
        assistantMsg,
        { seq: 0, type: "clarification_requested", questions: clarifyResult.questions },
      ];
    }
    // status === "ready"
    return [
      assistantMsg,
      { seq: 0, type: "stage_advance", to_stage: "spec" },
    ];
  }
```

- [ ] **Step 4: 运行测试，确认通过**

```
bun test tests/runner-rounds.test.ts
```

预期：所有测试 PASS（含原有测试 + 新增测试）

- [ ] **Step 5: typecheck**

```
bun run typecheck
```

预期：0 errors

- [ ] **Step 6: 更新 runner-protocol-contract.test.ts 的 RUNNER_EMITTED_EVENTS 清单**

`RUNNER_EMITTED_EVENTS` 加 `"stage_advance"`：

```typescript
const RUNNER_EMITTED_EVENTS = [
  "assistant_message",
  "clarification_requested",
  "stage_advance",        // ← 新增
  "stage_artifact",
  "gate_opened",
  "pr_created",
  "limit_hit",
  "session_failed",
] as const;
```

同时将 `clarification_requested` 从 `continue` 豁免中移除（它现在真的被 emit 了）：

```typescript
// 原来：
for (const e of RUNNER_EMITTED_EVENTS) {
  if (e === "clarification_requested") continue;  // ← 删掉这行
  expect(emitted.has(e), `清单里的 "${e}" 未在 rounds/session-loop 中 emit（清单含死项？）`).toBe(true);
}
```

改为：
```typescript
for (const e of RUNNER_EMITTED_EVENTS) {
  expect(emitted.has(e), `清单里的 "${e}" 未在 rounds/session-loop 中 emit（清单含死项？）`).toBe(true);
}
```

- [ ] **Step 7: 确认 protocol-contract 仍全绿**

```
bun test tests/runner-protocol-contract.test.ts
```

预期：全 PASS（reqgenie 同级不在时跳 3 个真实枚举对齐测试，其余通过）

- [ ] **Step 8: Commit**

```
git add src/daemon/runner/rounds.ts tests/runner-rounds.test.ts tests/runner-protocol-contract.test.ts
git commit -m "feat(runner): clarify round 重写——哨兵解析三分支(need_input/ready/兜底)"
```

---

### Task 3: session-loop.ts — stage_advance 处理 + 重连幂等去重

**Files:**
- Modify: `src/daemon/runner/session-loop.ts`

**Interfaces:**
- Consumes: Task 1 新增 `SessionEvent.to_stage`；Task 2 新产 `stage_advance` 事件
- Produces:
  - WAIT 段：`stage_advance` → `accumulated=""` + `sleep(pollMs)` + continue（下一轮 getSession 拿到 spec）
  - clarify 重连幂等去重：执行 clarify round 前，若事件流存在「尚未被 user_message 回答的 clarification_requested」，跳过 agent 直接进等待态

- [ ] **Step 1: 写失败测试**

在 `tests/runner-session-loop.test.ts` 末尾追加：

```typescript
// ── stage_advance 处理 ──────────────────────────────────────────────────
test("stage_advance：下一轮 getSession 进 spec（accumulated 清空）", async () => {
  // 第 1 轮：clarify 产 stage_advance；第 2 轮：getSession 已是 spec；spec 产 gate_opened 批准；终态
  const sessions = [
    S("clarify", "running"),
    S("spec", "running"),
    S("done", "completed"),
  ];
  const be = mockBackend({ sessionScript: sessions });
  let roundStages: string[] = [];
  await runSessionLoop("sess-sa", be, {
    runStageRound: async (session) => {
      roundStages.push(session.current_stage);
      if (session.current_stage === "clarify") {
        return [
          { seq: 0, type: "assistant_message", text: "已探索" },
          { seq: 0, type: "stage_advance", to_stage: "spec" },
        ];
      }
      return [{ seq: 0, type: "gate_opened" }];
    },
    pollMs: 1,
    limits: { sessionMax: 30, stageMax: 5 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // clarify 跑了一轮，stage_advance 触发 accumulated 清空，spec 跑了一轮
  expect(roundStages).toContain("clarify");
  expect(roundStages).toContain("spec");
});

test("stage_advance：accumulated 在进入下一 stage 时被清空", async () => {
  let accumulatedAtSpec = "UNKNOWN";
  const sessions = [S("clarify", "running"), S("spec", "running"), S("done", "completed")];
  const be = mockBackend({ sessionScript: sessions });
  await runSessionLoop("sess-sa2", be, {
    runStageRound: async (session, accumulated) => {
      if (session.current_stage === "spec") {
        accumulatedAtSpec = accumulated;
        return [{ seq: 0, type: "gate_opened" }];
      }
      return [
        { seq: 0, type: "assistant_message", text: "x" },
        { seq: 0, type: "stage_advance", to_stage: "spec" },
      ];
    },
    pollMs: 1,
    limits: { sessionMax: 30, stageMax: 5 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // stage_advance 后 accumulated 被清空，spec round 拿到空字符串
  expect(accumulatedAtSpec).toBe("");
});

// ── clarify 重连幂等去重 ────────────────────────────────────────────────────
test("重连幂等去重：已有未答 clarification_requested → 不重跑 agent，进等待态", async () => {
  // 事件流：已有 clarification_requested（seq=5）但无后续 user_message → runner 不应重跑 round
  let rounds = 0;
  const sessions = [
    S("clarify", "running"), S("clarify", "running"),
    S("clarify", "running"), S("done", "completed"),
  ];
  // fetchEvents 第 1 次返回已有的 clarification_requested
  let fetchCount = 0;
  const be: RunnerBackend = {
    ...mockBackend({ sessionScript: sessions }),
    async fetchEvents(_id, after) {
      fetchCount++;
      if (fetchCount === 1 && after === 0) {
        return [
          { seq: 3, type: "assistant_message", text: "探索结果" },
          { seq: 5, type: "clarification_requested", questions: ["需要确认接口格式？"] },
        ];
      }
      return [];
    },
  };
  await runSessionLoop("sess-dedup", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "clarification_requested", questions: ["重复问"] }]; },
    pollMs: 1,
    limits: { sessionMax: 10, stageMax: 3 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // 已有未答 clarification_requested → runner 不重跑，所以 rounds=0
  expect(rounds).toBe(0);
});

test("重连幂等去重：clarification_requested 之后有 user_message → 正常跑 round", async () => {
  let rounds = 0;
  const sessions = [S("clarify", "running"), S("done", "completed")];
  const be: RunnerBackend = {
    ...mockBackend({ sessionScript: sessions }),
    async fetchEvents(_id, after) {
      if (after === 0) {
        return [
          { seq: 3, type: "clarification_requested", questions: ["问题"] },
          { seq: 7, type: "user_message", text: "用户已回答" },
        ];
      }
      return [];
    },
  };
  await runSessionLoop("sess-dedup2", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "assistant_message", text: "ok" }]; },
    pollMs: 1,
    limits: { sessionMax: 10, stageMax: 3 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // user_message 已回答，正常跑
  expect(rounds).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行，确认失败**

```
bun test tests/runner-session-loop.test.ts
```

预期：新增 4 个测试 FAIL

- [ ] **Step 3: 修改 session-loop.ts**

**3a. runSessionLoop 函数签名**：`runStageRound` 已经接收 `accumulated` 作为第二参数（现有代码中 `deps.runStageRound(session, accumulated)`），保持不变。

**3b. WAIT 段加 stage_advance 处理**（在 `if (last.type === "clarification_requested")` 块之前插入）：

```typescript
      // stage_advance：clarify agent 自主判断「澄清够了、推进 spec」
      if (last.type === "stage_advance") {
        accumulated = ""; // 进下一 stage 清返工上下文（同 gate_opened 批准路径）
        await sleep(deps.pollMs);
        continue; // 下一轮 SYNC 的 getSession 拿到新 current_stage
      }
```

**3c. clarify 幂等去重**：在 `// ── ROUND ──` 前，闸门检查后，加去重逻辑：

```typescript
      // ── clarify 重连幂等去重：避免重连时重复产 clarification_requested（防重复建飞书卡）──
      // 若事件流中最近一条 clarification_requested 之后无 user_message 应答 → 直接进等待态
      if (session.current_stage === "clarify" && !waitingClarify) {
        const allEvents = await backend.fetchEvents(sessionId, 0);
        const lastClarifyReq = allEvents.filter((e) => e.type === "clarification_requested").at(-1);
        if (lastClarifyReq) {
          const hasAnswer = allEvents.some(
            (e) => e.type === "user_message" && e.seq > lastClarifyReq.seq,
          );
          if (!hasAnswer) {
            waitingClarify = true;
            prevStageForClarify = session.current_stage;
            await sleep(deps.pollMs);
            continue;
          }
        }
      }
```

注意：此 `backend.fetchEvents(sessionId, 0)` 从头拉全历史做去重判断，仅在 clarify + 非等待态时触发，代价可控（clarify 阶段并非高频 round）。

- [ ] **Step 4: 运行测试，确认通过**

```
bun test tests/runner-session-loop.test.ts
```

预期：所有测试 PASS（含原有 + 新增 4 个）

- [ ] **Step 5: typecheck**

```
bun run typecheck
```

预期：0 errors

- [ ] **Step 6: Commit**

```
git add src/daemon/runner/session-loop.ts tests/runner-session-loop.test.ts
git commit -m "feat(runner): session-loop 处理 stage_advance + clarify 重连幂等去重"
```

---

### Task 4: 全量验证 + 报告

**Files:**
- Create: `.superpowers/sdd/clarify-handoff-autopilot-report.md`

**Interfaces:**
- Consumes: Tasks 1-3 全部完成

- [ ] **Step 1: 全量测试**

```
bun test
```

预期：全绿，既有测试不回归

- [ ] **Step 2: typecheck**

```
bun run typecheck
```

预期：0 errors

- [ ] **Step 3: 写报告**

新建 `.superpowers/sdd/clarify-handoff-autopilot-report.md`，内容：

```markdown
# clarify runner 主导权交接——实现报告

## 改了什么

### src/daemon/runner/types.ts
- `SessionEventType` 新增 `"stage_advance"`
- `SessionEvent` 新增可选 `to_stage?: string` 和 `questions?: string[]`
- `wireToSessionEvent`：从 `payload.to_stage` 提平到 `ev.to_stage`；`payload.questions[]` 提平到 `ev.questions`
- `sessionEventToWireBody`：`to_stage` → `payload.to_stage`；`questions` → `payload.questions`（解构剔除 `to_stage`/`questions` 避免 `...rest` 重复写入）

### src/daemon/runner/rounds.ts
- 导出 `parseClarifyResult(text)`：解析尾部哨兵 JSON，三值返回（need_input/ready/null）
- 导出 `stripSentinel(text)`：去掉哨兵行，返回干净正文
- clarify 分支重写：哨兵三分支产出（need_input+questions 非空→clarification_requested；ready→stage_advance；无哨兵→assistant_message 兜底）
- `STAGE_SYSTEM.clarify` prompt：加哨兵格式协议说明

### src/daemon/runner/session-loop.ts
- WAIT 段：`stage_advance` → `accumulated=""` + continue（下一轮 getSession 自然进 spec）
- clarify 幂等去重：round 前检查「最近 clarification_requested 后有无 user_message」，无则直接进等待态，避免重连重复建飞书卡

### tests/runner-protocol-contract.test.ts
- `RUNNER_EMITTED_EVENTS` 加 `"stage_advance"`
- 删掉 `clarification_requested` 的豁免（它现在被真实 emit）
- 新增 3 个协议往返测试（stage_advance wire 往返、questions[] wire 往返）

## typecheck / bun test

- `bun run typecheck`：0 errors
- `bun test`：全绿

## Commit SHA
（由执行者填写）
```

- [ ] **Step 4: Commit 报告**

```
git add .superpowers/sdd/clarify-handoff-autopilot-report.md
git commit -m "docs(runner): clarify runner 主导权——实现报告"
```

---

## 自审 Checklist

**Spec coverage 检查：**
- [x] types.ts: `stage_advance` 类型 + `to_stage` + `questions` wire 往返 → Task 1
- [x] rounds.ts: `parseClarifyResult` + `stripSentinel` + 三分支 + prompt 哨兵协议 → Task 2
- [x] rounds.ts: 解析失败/无哨兵 → 保守兜底 → Task 2 Step 3
- [x] session-loop.ts: `stage_advance` → `accumulated=""` + continue → Task 3
- [x] session-loop.ts: clarify 重连幂等去重 → Task 3
- [x] 测试：clarify 三分支产出 → Task 2 Step 1
- [x] 测试：stage_advance 后下一轮拿 spec → Task 3 Step 1
- [x] 测试：pending 去重 → Task 3 Step 1
- [x] 测试：user_message 回流续作 → Task 3 Step 1
- [x] 测试：协议往返（stage_advance + to_stage、questions[]）→ Task 1 Step 1
- [x] 报告写入 `.superpowers/sdd/clarify-handoff-autopilot-report.md` → Task 4

**Placeholder scan：** 无 TBD/TODO/填细节类占位。

**Type consistency：**
- `parseClarifyResult` 导出自 rounds.ts，Task 2 测试直接 import；签名一致。
- `SessionEvent.questions` 在 types.ts 定义；rounds.ts 产出时用 `questions: clarifyResult.questions`；session-loop.ts 去重检查用 `e.type === "clarification_requested"` + `e.seq`，无需读 questions 字段。
- `stage_advance` 字面量在 `SessionEventType` 注册；rounds.ts 产出用 `type: "stage_advance"`；session-loop.ts WAIT 检查用 `last.type === "stage_advance"`；一致。
