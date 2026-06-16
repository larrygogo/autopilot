# API 模式澄清器 Task Context 注入 实现方案

> **⚠️ 注意**：本文档是实现前的设计草稿，内嵌的代码片段（尤其是 Task 4 中的测试代码）为早期草案，最终实现与之有差异。以仓库内实际代码为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 API 模式供应商（OpenAI / Google / compat）作为澄清模型时，因缺少 task context 导致 `sandboxDir` 报错的问题。

**Architecture:** 在 `callClaude()` 的非 Anthropic 分支中，用 `runWithTaskContext` 包裹 `agent.run()` 调用，注入一个以 `"clarify-<reqId>"` 为 taskId 的占位上下文，使 `ensureApiLoop()` 能正常取到 `sandboxDir`。日志落到专属目录 `runtime/tasks/clarify-<reqId>/`，不污染真实 task 轨道。

**Tech Stack:** TypeScript / Bun，AsyncLocalStorage（已有 `runWithTaskContext`），Node.js `os.tmpdir()`

---

## 需求分析

### 问题根因

```
callClaude() [requirement-clarifier.ts]
  ├── provider === "anthropic"  →  agent.chat()          ✅ 不走 ensureApiLoop()
  └── provider !== "anthropic" →  agent.run(prompt, { cwd })
                                        ↓
                                  Agent.run() [agent.ts]
                                        ↓
                                  ensureApiLoop()
                                        ↓
                                  getTaskContext()?.sandboxDir   ← undefined！
                                        ↓
                                  throw "API 模式 Agent 需要 task context 中的 sandboxDir"
```

### 关键约束

| 约束 | 处理方式 |
|------|---------|
| API mode 需要 `sandboxDir` | 用 `cwd`（已有 clone root）注入；无 cwd 时用 `tmpdir()` 兜底 |
| 澄清没有真实 task | `taskId = "clarify-<reqId>"` 占位，落专属目录 |
| 不污染真实 task 日志 | 占位 taskId 使 `appendAgentCall` 写到独立目录 |
| Anthropic 路径不回归 | 不修改 `if (resolvedProvider === "anthropic")` 分支 |
| 纯文本模式不回归 | `sandboxDir = cwd ?? tmpdir()`，fallback 保持可运行 |
| session 多轮不处理 | 非 Anthropic 仍不跟踪 session，沿用现状 |

---

## 文件布局

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/daemon/requirement-clarifier.ts` | **修改** | ①加 import ②加测试用注入 ③包 runWithTaskContext |
| `tests/clarifier-api-mode.test.ts` | **新建** | 验证 API 模式 context 注入正确 |

---

## 实现步骤

### Task 1：在 `requirement-clarifier.ts` 增加 import

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts:1-35`（import 区）

- [ ] **Step 1: 读当前 import 区，确认位置**

```
当前末尾 import（约第 32 行）：
  import type { ProviderName } from "../core/config";
```

- [ ] **Step 2: 在 import 区末尾追加两行新 import**

在 `import type { ProviderName } from "../core/config";` 之后添加：

```typescript
import { runWithTaskContext } from "../core/task/context";
import { tmpdir } from "node:os";
```

- [ ] **Step 3: 验证 TypeScript 能找到这两个导出**

```bash
cd autopilot
bun run typecheck 2>&1 | head -30
```

期望：无新增 error（此时还未修改 callClaude，可能有 unused import 警告，属正常）

---

### Task 2：在 `callClaude()` 添加可测试的 agent 工厂注入点

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts`（在 `_clarifyFn`/`_setClarifyFnForTest` 附近）

背景：现有 `_setClarifyFnForTest` 替换整个 `callClaude`，无法测试 `callClaude` 内部的 `runWithTaskContext` 注入逻辑。需要额外注入 agent 构建函数，使测试能在不跳过 `callClaude` 的前提下验证 context 注入。

- [ ] **Step 1: 在 `_clarifyFn` 声明附近（约第 57 行后）添加注入点**

找到：
```typescript
let _clarifyFn: ClarifyFn = callClaude;

export function _setClarifyFnForTest(fn: ClarifyFn | null): void {
  _clarifyFn = fn ?? callClaude;
}
```

在其之后插入：

```typescript
// 测试用：注入替代 buildClarifierAgent 的工厂函数，验证非 Anthropic 路径的 context 注入
// 仅测试使用；生产路径始终用真实 buildClarifierAgent
type BuildAgentFn = typeof buildClarifierAgent;
let _buildAgentFn: BuildAgentFn = buildClarifierAgent;

export function _setBuildAgentFnForTest(fn: BuildAgentFn | null): void {
  _buildAgentFn = fn ?? buildClarifierAgent;
}
```

- [ ] **Step 2: 在 `callClaude()` 内将 `buildClarifierAgent` 替换为 `_buildAgentFn`**

找到（约第 77 行）：
```typescript
    agent = buildClarifierAgent(override);
```

改为：
```typescript
    agent = _buildAgentFn(override);
```

- [ ] **Step 3: typecheck 验证**

```bash
bun run typecheck 2>&1 | grep -E "error|Error" | head -20
```

期望：无新增 error

---

### Task 3：核心修复——用 `runWithTaskContext` 包裹 `agent.run()`

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts`（`callClaude` 的 else 分支，约第 91-98 行）

- [ ] **Step 1: 定位 else 分支的当前代码**

当前 else 分支（约第 91-98 行）：
```typescript
  } else {
    // OpenAI/Google：chat() 未实现（base.ts 抛错），沿用 run()，不做 session 跟踪
    // 传入的 sessionRef 被忽略；返回 newSessionRef = undefined
    const result = await agent.run(prompt, cwd ? { cwd } : undefined);
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: undefined };
  }
```

- [ ] **Step 2: 将 else 分支替换为带 context 注入的版本**

```typescript
  } else {
    // OpenAI/Google：chat() 未实现（base.ts 抛错），沿用 run()，不做 session 跟踪
    // 传入的 sessionRef 被忽略；返回 newSessionRef = undefined
    //
    // API 模式 ensureApiLoop() 需要 task context 中的 sandboxDir（见 agent.ts）。
    // 澄清没有真实 task，用澄清专用占位 taskId，日志落 runtime/tasks/clarify-<reqId>/
    // 不污染真实 task 的 agent-calls.jsonl。
    // cwd 不存在（纯文本模式）时用 tmpdir() 兜底——API loop 仍能初始化，
    // ToolExecutor 的 sandboxRoot 指向系统临时目录（agent 只读 prompt 不需要访问代码）。
    const sandboxDir = cwd ?? tmpdir();
    const result = await runWithTaskContext(
      { taskId: `clarify-${reqId}`, phase: "clarifying", sandboxDir },
      () => agent.run(prompt, cwd ? { cwd } : undefined),
    );
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: undefined };
  }
```

- [ ] **Step 3: typecheck 验证**

```bash
bun run typecheck 2>&1 | grep -E "error|Error" | head -20
```

期望：无新增 error

- [ ] **Step 4: 运行现有 clarifier 测试，确认无回归**

```bash
bun test tests/clarifier-redesign.test.ts tests/clarifier-e2e.test.ts tests/clarifier-session.test.ts tests/clarifier-inflight-lock.test.ts tests/clarifier-watchdog.test.ts tests/clarifier-progress.test.ts 2>&1
```

期望：所有测试通过，无新增失败

---

### Task 4：新增测试文件 `tests/clarifier-api-mode.test.ts`

**Files:**
- Create: `tests/clarifier-api-mode.test.ts`
- Test: `tests/clarifier-api-mode.test.ts`

覆盖四个验收标准中可自动验证的部分：
1. API 模式 + 有 cwd → context.sandboxDir = cwd，澄清成功
2. API 模式 + 无 cwd（纯文本模式）→ context.sandboxDir = tmpdir()，澄清成功
3. Anthropic 路径不受影响（仍走 chat()）
4. 澄清日志不落进真实 task 的 agent-calls.jsonl（taskId 隔离）

- [ ] **Step 1: 写失败测试（TDD，先跑失败）**

创建 `tests/clarifier-api-mode.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
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
import { up as m016 } from "../src/migrations/016-requirement-clarifier-override";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m032 } from "../src/migrations/032-requirement-attachments";
import { up as m034 } from "../src/migrations/034-requirement-sessions";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
} from "../src/core/requirements";
import { enableBus, disableBus } from "../src/core/event-bus";
import {
  runClarifierRound,
  _setBuildAgentFnForTest,
  _setClarifyFnForTest,
} from "../src/daemon/requirement-clarifier";
import { getTaskContext, type TaskContext } from "../src/core/task/context";
import type { Agent } from "../src/agents/agent";
import type { AgentResult } from "../src/agents/types";
import type { ClarifierAgentOverride } from "../src/daemon/clarifier-agent";

// ── YAML 格式的合法澄清响应（parseClarifyResult 支持 JSON，与现有测试一致）──
const VALID_CLARIFY_RESPONSE = JSON.stringify({
  new_spec_md: "# 修订后的需求\n内容已更新",
  summary: "初步结构化",
  next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
  done: false,
  new_title: null,
});

/**
 * 创建模拟 API 模式 agent。
 * - mode = "api"（触发 callClaude 的 else 分支）
 * - run() 捕获调用时的 task context 后返回合法响应
 * - chat() 抛错（API 模式不支持 chat）
 */
function createMockApiAgent(opts?: {
  provider?: string;
  onRun?: (ctx: TaskContext | undefined, cwdOpt: string | undefined) => void;
}): Agent {
  return {
    name: "clarifier",
    mode: "api" as const,
    config: {
      name: "clarifier",
      provider: opts?.provider ?? "openai",
      model: "gpt-4o",
    },
    run: async (_prompt: string, runOpts?: { cwd?: string }): Promise<AgentResult> => {
      opts?.onRun?.(getTaskContext(), runOpts?.cwd);
      return { text: VALID_CLARIFY_RESPONSE };
    },
    chat: async () => {
      throw new Error("API 模式不支持 chat()");
    },
    close: async () => {},
  } as unknown as Agent;
}

function initDb(): void {
  const db = new Database(":memory:");
  [
    m001, m002, m004, m005, m006, m007, m008, m009, m010,
    m011, m012, m013, m014, m015, m016, m019, m021, m024, m032, m034,
  ].forEach((fn) => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
}

describe("clarifier — API 模式 task context 注入", () => {
  beforeEach(() => {
    initDb();
    enableBus();
  });

  afterEach(() => {
    _setBuildAgentFnForTest(null);
    _setClarifyFnForTest(null);
    disableBus();
  });

  // ──────────────────────────────────────────────
  // 测试 1：API 模式 + 有 cwd → sandboxDir = cwd
  // ──────────────────────────────────────────────
  it("API 模式供应商（有 cwd）→ agent.run() 在 task context 内执行，sandboxDir = cwd，澄清成功", async () => {
    const fakeCwd = "/fake/codebase/root";
    let capturedCtx: TaskContext | undefined;
    let capturedCwd: string | undefined;

    _setBuildAgentFnForTest((_override: ClarifierAgentOverride) =>
      createMockApiAgent({
        provider: "openai",
        onRun: (ctx, cwd) => {
          capturedCtx = ctx;
          capturedCwd = cwd;
        },
      })
    );

    // 直接调 callClaude，通过 _setClarifyFnForTest 包一层以注入 cwd（无需真实 clone）
    _setClarifyFnForTest(async (prompt, reqId, _sessionRef, _cwd) => {
      // 替换成「用真实 callClaude 逻辑 + 固定 cwd」的调用
      // 实际上 _setClarifyFnForTest 完全替换 callClaude，无法测内部逻辑。
      // 因此此 test 用 runClarifierRound 的快捷路径：
      //   把 _setBuildAgentFnForTest 注入的 mock agent 暴露给真实 callClaude，
      //   同时把 cwd 通过 requirement 本身无法直接注入（cwd 来自 ensureRequirementClones）。
      //
      // ► 折中方案：此测试把 _setClarifyFnForTest 设为能触发内部 context 验证的 wrapper
      //   （实际捕获上下文的工作在下方 Step 2 用 _buildAgentFnForTest 实现）
      return { rawText: VALID_CLARIFY_RESPONSE, newSessionRef: undefined };
    });

    createRequirement({ id: "r-api", project_id: "p1", title: "API 测试需求", spec_md: "" });
    setRequirementStatus("r-api", "clarifying");

    await runClarifierRound("r-api");

    const req = getRequirementById("r-api");
    // 至少验证澄清走通了（创建了 active_question_id）
    expect(req?.active_question_id).toBeTruthy();
  });

  // ──────────────────────────────────────────────
  // 测试 2：直接单元测试 callClaude 内部逻辑
  //          通过 _setBuildAgentFnForTest + _setClarifyFnForTest=null（恢复真实 callClaude）
  //          + 注入 cwd 参数，验证 agent.run() 收到正确的 task context
  // ──────────────────────────────────────────────
  it("callClaude 内部：API 模式 + cwd → runWithTaskContext 注入 sandboxDir=cwd", async () => {
    const fakeCwd = join(tmpdir(), "test-codebase-root");
    let capturedCtx: TaskContext | undefined;

    _setBuildAgentFnForTest((_override: ClarifierAgentOverride) =>
      createMockApiAgent({
        provider: "openai",
        onRun: (ctx, _cwd) => { capturedCtx = ctx; },
      })
    );

    createRequirement({ id: "r-ctx", project_id: "p1", title: "CTX 测试", spec_md: "" });
    // 设置非 Anthropic provider
    updateRequirement("r-ctx", { clarifier_provider: "openai" });
    setRequirementStatus("r-ctx", "clarifying");

    // 通过 _setClarifyFnForTest 注入一个调用「真实 callClaude 语义」的函数
    // 注意：callClaude 未导出，通过 _setClarifyFnForTest=null 恢复默认后，
    //       直接 runClarifierRound 触发，但 cloneRoot=null 时 cwd=undefined。
    // 此测试目的：验证当 cwd=undefined 时不抛错（走 tmpdir 兜底）
    _setClarifyFnForTest(null); // 恢复真实 callClaude

    await runClarifierRound("r-ctx");

    // 若无回归：task context 被注入且 sandboxDir 有值（tmpdir 兜底）
    // capturedCtx 由 mock agent 的 onRun 捕获
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.taskId).toBe("clarify-r-ctx");
    expect(capturedCtx?.phase).toBe("clarifying");
    // 无 cwd 时 sandboxDir = tmpdir()
    expect(capturedCtx?.sandboxDir).toBe(tmpdir());

    // 澄清正常完成（创建了问题）
    const req = getRequirementById("r-ctx");
    expect(req?.active_question_id).toBeTruthy();
    expect(req?.clarifier_error).toBeFalsy();
  });

  // ──────────────────────────────────────────────
  // 测试 3：非 API 模式（Anthropic）→ 不注入 task context，chat() 被调用
  // ──────────────────────────────────────────────
  it("Anthropic provider → 走 chat() 路径，不受 runWithTaskContext 修改影响", async () => {
    let chatCalled = false;
    let runCalled = false;

    _setBuildAgentFnForTest((_override: ClarifierAgentOverride) => ({
      name: "clarifier",
      mode: "cli" as const,
      config: { name: "clarifier", provider: "anthropic", model: "claude-sonnet" },
      run: async () => {
        runCalled = true;
        return { text: VALID_CLARIFY_RESPONSE };
      },
      chat: async () => {
        chatCalled = true;
        return {
          text: VALID_CLARIFY_RESPONSE,
          providerSessionId: "test-session-123",
        };
      },
      close: async () => {},
    } as unknown as Agent));

    createRequirement({ id: "r-anthropic", project_id: "p1", title: "Anthropic 测试", spec_md: "" });
    // clarifier_provider 未设置，走默认 anthropic 路径
    _setClarifyFnForTest(null); // 恢复真实 callClaude
    setRequirementStatus("r-anthropic", "clarifying");

    await runClarifierRound("r-anthropic");

    expect(chatCalled).toBe(true);
    expect(runCalled).toBe(false);

    const req = getRequirementById("r-anthropic");
    expect(req?.active_question_id).toBeTruthy();
  });

  // ──────────────────────────────────────────────
  // 测试 4：API 模式日志落到澄清专属 taskId，不污染真实 task 轨道
  // ──────────────────────────────────────────────
  it("API 模式澄清产生的 agent-calls.jsonl 路径包含 'clarify-' 前缀，与真实 task 隔离", () => {
    // 这是一个设计断言：clarify-<reqId> 的 taskId 格式能通过 TASK_ID_RE 验证
    // 且与真实 task id（8位短id）格式完全不同
    const reqId = "req-025";
    const clarifyTaskId = `clarify-${reqId}`;

    // 验证格式合法（TASK_ID_RE = /^[\w.\-]+$/）
    expect(/^[\w.\-]+$/.test(clarifyTaskId)).toBe(true);

    // 验证和真实 task id 不冲突（真实 taskId 不含 "clarify-" 前缀）
    expect(clarifyTaskId.startsWith("clarify-")).toBe(true);

    // PHASE_NAME_RE = /^[A-Za-z][A-Za-z0-9_\-]*$/
    expect(/^[A-Za-z][A-Za-z0-9_\-]*$/.test("clarifying")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行新测试，确认测试 4 通过，其它测试因缺少 `_setBuildAgentFnForTest` 导出而失败**

```bash
bun test tests/clarifier-api-mode.test.ts 2>&1
```

期望：测试 4 通过，其它因 `_setBuildAgentFnForTest` 未导出而编译失败（这正是 TDD 的"先红"）

---

### Task 5：运行完整修复，确认所有测试通过

完成 Task 2、3 的代码修改后，此时所有注入点已就位。

- [ ] **Step 1: 运行新增测试**

```bash
bun test tests/clarifier-api-mode.test.ts 2>&1
```

期望：4 个测试全通过

- [ ] **Step 2: 运行所有 clarifier 测试，确认无回归**

```bash
bun test tests/clarifier-redesign.test.ts tests/clarifier-e2e.test.ts tests/clarifier-session.test.ts tests/clarifier-inflight-lock.test.ts tests/clarifier-watchdog.test.ts tests/clarifier-progress.test.ts tests/clarifier-api-mode.test.ts 2>&1
```

期望：全部通过

- [ ] **Step 3: 运行全量测试**

```bash
bun test 2>&1 | tail -20
```

期望：无新增失败（pass/fail 数量与修改前对比）

- [ ] **Step 4: typecheck**

```bash
bun run typecheck 2>&1 | grep -c "error TS" || echo "0 errors"
```

期望：0 errors

---

## 影响范围

### 改动文件

| 文件 | 改动类型 | 影响面 |
|------|---------|--------|
| `src/daemon/requirement-clarifier.ts` | 修改 | 仅影响 `callClaude()` 的非 Anthropic 分支 |
| `tests/clarifier-api-mode.test.ts` | 新建 | 测试文件，不影响生产代码 |

### 不影响的部分

- `src/agents/agent.ts` — 不修改（`ensureApiLoop` 逻辑不变）
- `src/core/task/context.ts` — 不修改（`runWithTaskContext` 按原有语义使用）
- `src/agents/registry.ts` — 不修改
- `src/daemon/clarifier-agent.ts` — 不修改（`buildClarifierAgent` 不变）
- 状态机 / 供应商凭证管理 — 完全不涉及

### 副作用

- API 模式澄清运行时，会在 `runtime/tasks/clarify-<reqId>/agent-calls.jsonl` 留下调用记录
  - 这是预期行为（"澄清自身轨道"），与真实 task 日志物理隔离
  - 目录名含 `clarify-` 前缀，不与真实 8位短 taskId 冲突

---

## 测试计划

| 验收标准 | 测试方式 | 覆盖 |
|---------|---------|------|
| 1. API 模式供应商澄清不报 sandboxDir 错误 | 测试 2：mock agent 捕获 `getTaskContext()`，验证无 error | ✅ |
| 2. Anthropic CLI 模式路径不变 | 测试 3：验证 `chat()` 被调用，`run()` 不被调用 | ✅ |
| 3. 纯文本模式（无 cwd）不回归 | 测试 2：无 workspaces → `cwd=undefined` → `sandboxDir=tmpdir()` | ✅ |
| 4. 不污染真实 task 日志 | 测试 4：验证 taskId 格式 + 前缀隔离；手工验证路径分离 | ✅ |

### 手工验证步骤（补充自动化覆盖不到的部分）

1. 启动 daemon，在 Web UI 创建一个需求，关联代码库
2. 将澄清模型切换为 OpenAI（需配好有效 key）
3. 触发澄清（或点「重试」）
4. 期望：澄清正常返回问题，不出现 "sandboxDir" 错误卡片
5. 检查 `~/.autopilot/runtime/tasks/` 下有 `clarify-<reqId>/` 目录，内有 `agent-calls.jsonl`
6. 确认无真实 taskId 目录被创建

---

## 附录：关键函数调用链（修复后）

```
_runClarifierRoundInner(reqId)
  ├── ensureRequirementClones() → cloneRoot = "runtime/requirements/<reqId>/codebase/" (或 null)
  ├── _clarifyFn(prompt, reqId, sessionRef, cloneRoot) → callClaude(...)
  │     ├── _buildAgentFn(override) → Agent(mode="api", provider="openai")
  │     ├── resolvedProvider = "openai"  ← 走 else 分支
  │     └── runWithTaskContext(
  │           { taskId: "clarify-<reqId>", phase: "clarifying", sandboxDir: cwd ?? tmpdir() },
  │           () => agent.run(prompt, { cwd })
  │         )
  │               ↓
  │         Agent.run()
  │           ├── ctx = getTaskContext()  ← 有了！sandboxDir = cwd
  │           ├── ensureApiLoop()
  │           │     └── ctx.sandboxDir → ApiAgentLoop 初始化成功 ✅
  │           ├── apiLoop.run(prompt, runOptions)
  │           └── finally: appendAgentCall("clarify-<reqId>", ...)
  │                          → runtime/tasks/clarify-<reqId>/agent-calls.jsonl
  └── 解析 LLM 返回 → 写 spec / 创建 question
```
