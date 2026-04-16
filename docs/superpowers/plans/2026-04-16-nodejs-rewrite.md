# Autopilot Node.js 重写实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 autopilot 从 Python 重写为 TypeScript + Bun，新增 Agent 系统支持 anthropic/openai/google 三个 provider。

**Architecture:** 保留状态机 + Push 模型 + YAML 工作流核心架构，全面 async 化，用 bun:sqlite 替代 Python sqlite3，Agent 系统通过 BaseProvider 抽象支持多 CLI agent SDK。

**Tech Stack:** TypeScript, Bun, bun:sqlite, commander, yaml, @anthropic-ai/claude-agent-sdk, @openai/codex, @google/gemini-cli-sdk

**Spec:** `docs/superpowers/specs/2026-04-16-nodejs-rewrite-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 版本号 + AUTOPILOT_HOME 常量 |
| `src/cli.ts` | CLI 入口（commander） |
| `src/core/db.ts` | SQLite 数据库（bun:sqlite） |
| `src/core/state-machine.ts` | 状态机：转换表 + 原子转换 |
| `src/core/runner.ts` | 执行引擎：async 阶段执行 + Push |
| `src/core/registry.ts` | 工作流注册表：发现、加载、校验 |
| `src/core/config.ts` | 配置加载 |
| `src/core/infra.ts` | 文件锁 / 任务目录 |
| `src/core/logger.ts` | 日志（阶段标签） |
| `src/core/notify.ts` | 多后端通知 |
| `src/core/watcher.ts` | 卡死任务检测 |
| `src/core/migrate.ts` | 数据库迁移引擎 |
| `src/migrations/001-baseline.ts` | 基线迁移 |
| `src/agents/types.ts` | Agent/Provider 类型 |
| `src/agents/agent.ts` | Agent 类 |
| `src/agents/registry.ts` | Agent 注册表 |
| `src/agents/providers/base.ts` | BaseProvider 抽象 |
| `src/agents/providers/anthropic.ts` | Claude Code provider |
| `src/agents/providers/openai.ts` | Codex provider |
| `src/agents/providers/google.ts` | Gemini provider |
| `bin/autopilot.ts` | CLI 入口脚本 |
| `bin/run-phase.ts` | 外部阶段执行入口 |
| `examples/workflows/dev/workflow.yaml` | 示例工作流定义 |
| `examples/workflows/dev/workflow.ts` | 示例阶段函数 |
| `package.json` | 项目配置 |
| `tsconfig.json` | TypeScript 配置 |
| `tests/db.test.ts` | 数据库测试 |
| `tests/state-machine.test.ts` | 状态机测试 |
| `tests/registry.test.ts` | 注册表测试 |
| `tests/runner.test.ts` | Runner 测试 |
| `tests/agents.test.ts` | Agent 系统测试 |
| `tests/infra.test.ts` | 基础设施测试 |
| `tests/cli.test.ts` | CLI 测试 |

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `bin/autopilot.ts`

- [ ] **Step 1: 初始化 bun 项目并创建 package.json**

在新的 `src/` 目录结构下工作。`package.json` 内容：

```json
{
  "name": "autopilot",
  "version": "1.0.0",
  "type": "module",
  "description": "轻量级多阶段任务编排引擎",
  "bin": { "autopilot": "bin/autopilot.ts" },
  "scripts": {
    "dev": "bun run src/cli.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "yaml": "^2.8.0"
  },
  "optionalDependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@openai/codex": "latest",
    "@google/gemini-cli-sdk": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: 创建 src/index.ts**

```typescript
import { homedir } from "os";
import { join } from "path";

export const VERSION = "1.0.0";
export const AUTOPILOT_HOME = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
```

- [ ] **Step 4: 创建 bin/autopilot.ts**

```typescript
#!/usr/bin/env bun
import "../src/cli.ts";
```

- [ ] **Step 5: 安装依赖并验证**

Run: `bun install && bun run src/index.ts`
Expected: 无报错退出

- [ ] **Step 6: 提交**

```bash
git add package.json tsconfig.json src/index.ts bin/autopilot.ts bun.lockb
git commit -m "chore: 初始化 TypeScript + Bun 项目脚手架"
```

---

## Task 2: 日志模块

**Files:**
- Create: `src/core/logger.ts`
- Test: `tests/logger.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/logger.test.ts
import { describe, expect, test } from "bun:test";
import { createLogger, setPhase, resetPhase } from "../src/core/logger";

describe("logger", () => {
  test("createLogger returns logger with all methods", () => {
    const logger = createLogger("test");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  test("setPhase and resetPhase do not throw", () => {
    setPhase("design", "DESIGN");
    resetPhase();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/logger.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 logger**

```typescript
// src/core/logger.ts
let currentPhaseTag = "SYSTEM";

export function setPhase(phase: string, label?: string): void {
  currentPhaseTag = label ?? phase.toUpperCase();
}

export function resetPhase(): void {
  currentPhaseTag = "SYSTEM";
}

function fmt(level: string, msg: string, args: unknown[]): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  let i = 0;
  const body = args.length > 0
    ? msg.replace(/%[sdo]/g, () => (i < args.length ? String(args[i++]) : "%s"))
    : msg;
  return `${ts} [${level}] [${currentPhaseTag}] ${body}`;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(_name: string): Logger {
  return {
    info: (msg, ...args) => console.error(fmt("INFO", msg, args)),
    warn: (msg, ...args) => console.error(fmt("WARN", msg, args)),
    error: (msg, ...args) => console.error(fmt("ERROR", msg, args)),
    debug: (msg, ...args) => { if (process.env.DEBUG) console.error(fmt("DEBUG", msg, args)); },
  };
}

export const log = createLogger("core");
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/logger.ts tests/logger.test.ts
git commit -m "feat: 实现日志模块"
```

---

## Task 3: 数据库模块

**Files:**
- Create: `src/core/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/db.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_HOME = join(import.meta.dir, ".test-db");

beforeEach(() => {
  process.env.AUTOPILOT_HOME = TEST_HOME;
  mkdirSync(join(TEST_HOME, "runtime"), { recursive: true });
});
afterEach(() => {
  const { closeDb } = require("../src/core/db");
  closeDb();
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
});

describe("db", () => {
  test("initDb creates tables", () => {
    const { initDb, getDb } = require("../src/core/db");
    initDb();
    const db = getDb();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("tasks");
    expect(tables.map((t) => t.name)).toContain("task_logs");
  });

  test("createTask and getTask roundtrip", () => {
    const { initDb, createTask, getTask } = require("../src/core/db");
    initDb();
    createTask({ id: "t1", title: "测试", workflow: "dev", initialStatus: "pending_design" });
    const task = getTask("t1");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("测试");
    expect(task!.status).toBe("pending_design");
  });

  test("updateTask merges extra fields", () => {
    const { initDb, createTask, updateTask, getTask } = require("../src/core/db");
    initDb();
    createTask({ id: "t2", title: "T", workflow: "dev", initialStatus: "p", extra: { repo: "/a" } });
    updateTask("t2", { repo: "/b", custom: "val" });
    const task = getTask("t2");
    expect(task!.repo).toBe("/b");
    expect(task!.custom).toBe("val");
  });

  test("listTasks with status filter", () => {
    const { initDb, createTask, listTasks } = require("../src/core/db");
    initDb();
    createTask({ id: "a1", title: "A", workflow: "dev", initialStatus: "pending" });
    createTask({ id: "a2", title: "B", workflow: "dev", initialStatus: "running" });
    expect(listTasks({ status: "pending" }).length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/db.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 db.ts**

完整实现包含：`getDb`、`closeDb`、`initDb`、`now`、`getTask`、`createTask`、`updateTask`、`listTasks`、`getTaskLogs`、`createSubTask`、`getSubTasks`。

移植自 Python 版 `core/db.py`，关键变化：
- `bun:sqlite` 替代 `sqlite3`，同步 API
- 无 `threading.local()`，用模块级 `_db` 变量
- `rowToTask()` 自动展开 extra JSON
- `updateTask()` 使用 `BEGIN IMMEDIATE` 保证 extra 合并原子性

（完整代码见 spec 中 Task 3 的 Step 3，此处省略避免重复——实现时参照 spec 中的代码块）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/db.ts tests/db.test.ts
git commit -m "feat: 实现数据库模块（bun:sqlite）"
```

---

## Task 4: 状态机

**Files:**
- Create: `src/core/state-machine.ts`
- Test: `tests/state-machine.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/state-machine.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HOME = join(import.meta.dir, ".test-sm");
beforeEach(() => { process.env.AUTOPILOT_HOME = TEST_HOME; mkdirSync(join(TEST_HOME, "runtime"), { recursive: true }); });
afterEach(() => { const { closeDb } = require("../src/core/db"); closeDb(); if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true }); });

describe("state-machine", () => {
  test("valid transition succeeds", () => {
    const { initDb, createTask } = require("../src/core/db");
    const { transition } = require("../src/core/state-machine");
    initDb();
    createTask({ id: "s1", title: "T", workflow: "t", initialStatus: "pending" });
    const [from, to] = transition("s1", "go", { transitions: { pending: [["go", "running"]] } });
    expect(from).toBe("pending");
    expect(to).toBe("running");
  });

  test("invalid transition throws InvalidTransitionError", () => {
    const { initDb, createTask } = require("../src/core/db");
    const { transition, InvalidTransitionError } = require("../src/core/state-machine");
    initDb();
    createTask({ id: "s2", title: "T", workflow: "t", initialStatus: "pending" });
    expect(() => transition("s2", "bad", { transitions: { pending: [["go", "running"]] } })).toThrow(InvalidTransitionError);
  });

  test("canTransition checks correctly", () => {
    const { initDb, createTask } = require("../src/core/db");
    const { canTransition } = require("../src/core/state-machine");
    initDb();
    createTask({ id: "s3", title: "T", workflow: "t", initialStatus: "pending" });
    const t = { pending: [["go", "running"]] };
    expect(canTransition("s3", "go", { transitions: t })).toBe(true);
    expect(canTransition("s3", "nope", { transitions: t })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/state-machine.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现状态机**

移植自 `core/state_machine.py`。导出 `TransitionTable` 类型、`InvalidTransitionError`、`transition()`、`canTransition()`、`getAvailableTriggers()`。

核心逻辑：`BEGIN IMMEDIATE` → 查当前状态 → 查转换表 → UPDATE + INSERT log → `COMMIT`。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/state-machine.ts tests/state-machine.test.ts
git commit -m "feat: 实现状态机（原子转换 + 日志记录）"
```

---

## Task 5: 基础设施（文件锁 + 任务目录）

**Files:**
- Create: `src/core/infra.ts`
- Test: `tests/infra.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/infra.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HOME = join(import.meta.dir, ".test-infra");
beforeEach(() => { process.env.AUTOPILOT_HOME = TEST_HOME; mkdirSync(join(TEST_HOME, "runtime/tasks"), { recursive: true }); });
afterEach(() => { if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true }); });

describe("infra", () => {
  test("getTaskDir creates directory", () => {
    const { getTaskDir } = require("../src/core/infra");
    const dir = getTaskDir("task-1");
    expect(existsSync(dir)).toBe(true);
  });

  test("rejects path traversal", () => {
    const { getTaskDir } = require("../src/core/infra");
    expect(() => getTaskDir("../etc")).toThrow();
  });

  test("acquireLock and releaseLock", () => {
    const { acquireLock, releaseLock, isLocked } = require("../src/core/infra");
    expect(acquireLock("lk1")).toBe(true);
    expect(isLocked("lk1")).toBe(true);
    releaseLock("lk1");
    expect(isLocked("lk1")).toBe(false);
  });
});
```

- [ ] **Step 2-4: 实现、测试、提交**

实现文件锁（`writeFileSync` + `flag: "wx"` 原子创建）和任务目录管理。移植自 `core/infra.py`，简化为单进程锁模型。

```bash
git add src/core/infra.ts tests/infra.test.ts
git commit -m "feat: 实现基础设施（文件锁 + 任务目录）"
```

---

## Task 6: 配置加载 + 工作流注册表

**Files:**
- Create: `src/core/config.ts`
- Create: `src/core/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: 实现 config.ts**

YAML 配置加载，搜索 `AUTOPILOT_HOME/config.yaml` 和 `cwd/config.yaml`。

- [ ] **Step 2: 写注册表测试**

```typescript
// tests/registry.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_HOME = join(import.meta.dir, ".test-reg");
beforeEach(() => { process.env.AUTOPILOT_HOME = TEST_HOME; mkdirSync(join(TEST_HOME, "runtime"), { recursive: true }); });
afterEach(() => { if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true }); });

describe("registry", () => {
  test("loadYamlWorkflow expands phase defaults", async () => {
    const { loadYamlWorkflow } = require("../src/core/registry");
    const dir = join(TEST_HOME, "workflows/test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.yaml"), "name: test\nphases:\n  - name: step1\n    timeout: 900\n  - name: step2\n    reject: step1\n");
    const wf = await loadYamlWorkflow(dir);
    expect(wf!.phases[0].pending_state).toBe("pending_step1");
    expect(wf!.phases[0].running_state).toBe("running_step1");
    expect(wf!.phases[1].jump_trigger).toBe("step2_reject");
    expect(wf!.phases[1].jump_target).toBe("step1");
  });

  test("buildTransitions generates correct table", () => {
    const { buildTransitions } = require("../src/core/registry");
    const wf = {
      name: "t",
      phases: [
        { name: "a", pending_state: "pa", running_state: "ra", trigger: "sa", complete_trigger: "ac", fail_trigger: "af", label: "A" },
        { name: "b", pending_state: "pb", running_state: "rb", trigger: "sb", complete_trigger: "bc", fail_trigger: "bf", label: "B" },
      ],
      initial_state: "pa",
      terminal_states: ["done", "cancelled"],
    };
    const t = buildTransitions(wf);
    expect(t.pa).toContainEqual(["sa", "ra"]);
    expect(t.ra).toContainEqual(["ac", "pb"]);
    expect(t.rb).toContainEqual(["bc", "done"]);
  });
});
```

- [ ] **Step 3: 实现 registry.ts**

核心逻辑移植自 `core/registry.py`：YAML 解析 → 阶段默认值推导 → reject 语法糖 → parallel 块展开 → 转换表构建 → 发现注册。新增 `agents` 字段解析。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/config.ts src/core/registry.ts tests/registry.test.ts
git commit -m "feat: 实现配置加载 + 工作流注册表"
```

---

## Task 7: Agent 系统

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/providers/base.ts`
- Create: `src/agents/providers/anthropic.ts`
- Create: `src/agents/providers/openai.ts`
- Create: `src/agents/providers/google.ts`
- Create: `src/agents/agent.ts`
- Create: `src/agents/registry.ts`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/agents.test.ts
import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";

class MockProvider extends BaseProvider {
  async run(prompt: string, _opts?: RunOptions): Promise<AgentResult> {
    return { text: `mock: ${prompt}` };
  }
  async close(): Promise<void> {}
}

describe("agent system", () => {
  test("Agent delegates to provider", async () => {
    const agent = new Agent("test", new MockProvider({}), { name: "test", provider: "anthropic", model: "m" });
    const result = await agent.run("hello");
    expect(result.text).toBe("mock: hello");
  });

  test("Agent.close calls provider.close", async () => {
    let closed = false;
    class TrackProvider extends BaseProvider {
      async run() { return { text: "" }; }
      async close() { closed = true; }
    }
    const agent = new Agent("t", new TrackProvider({}), { name: "t", provider: "anthropic", model: "m" });
    await agent.close();
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/agents.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 types.ts**

```typescript
// src/agents/types.ts
export interface AgentConfig {
  name: string;
  provider: "anthropic" | "openai" | "google";
  model: string;
  permission_mode?: string;
  max_turns?: number;
  max_budget_usd?: number;
  [key: string]: unknown;
}

export interface AgentResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}
```

- [ ] **Step 4: 实现 BaseProvider**

```typescript
// src/agents/providers/base.ts
import type { AgentResult, RunOptions } from "../types";

export abstract class BaseProvider {
  constructor(protected config: Record<string, unknown>) {}
  abstract run(prompt: string, options?: RunOptions): Promise<AgentResult>;
  abstract close(): Promise<void>;
}
```

- [ ] **Step 5: 实现三个 Provider**

每个 Provider 动态 `import()` 对应 SDK，未安装时抛出清晰错误提示。

- `AnthropicProvider`：用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，持有 `sessionId` 支持会话复用
- `OpenAIProvider`：用 `@openai/codex`
- `GoogleProvider`：用 `@google/gemini-cli-sdk`

- [ ] **Step 6: 实现 Agent 类**

```typescript
// src/agents/agent.ts
import type { BaseProvider } from "./providers/base";
import type { AgentConfig, AgentResult, RunOptions } from "./types";

export class Agent {
  constructor(readonly name: string, private provider: BaseProvider, readonly config: AgentConfig) {}
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> { return this.provider.run(prompt, options); }
  async close(): Promise<void> { return this.provider.close(); }
}
```

- [ ] **Step 7: 实现 Agent 注册表**

`createAgent()`、`getAgent()` 按 `workflowName:agentName` 缓存、`closeAgents()` 释放。

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test tests/agents.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/agents/ tests/agents.test.ts
git commit -m "feat: 实现 Agent 系统（BaseProvider + anthropic/openai/google）"
```

---

## Task 8: Runner（执行引擎）

**Files:**
- Create: `src/core/runner.ts`
- Create: `bin/run-phase.ts`
- Test: `tests/runner.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/runner.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HOME = join(import.meta.dir, ".test-runner");
beforeEach(() => { process.env.AUTOPILOT_HOME = TEST_HOME; mkdirSync(join(TEST_HOME, "runtime"), { recursive: true }); });
afterEach(() => { const { closeDb } = require("../src/core/db"); closeDb(); if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true }); });

describe("runner", () => {
  test("executePhase runs function and allows transition", async () => {
    const { initDb, createTask, getTask } = require("../src/core/db");
    const { register, buildTransitions, getWorkflow } = require("../src/core/registry");
    const { executePhase } = require("../src/core/runner");
    const { transition } = require("../src/core/state-machine");

    initDb();
    let called = false;
    register({
      name: "twf",
      phases: [{
        name: "s1", pending_state: "ps1", running_state: "rs1",
        trigger: "go", complete_trigger: "done_s1", fail_trigger: "fail_s1", label: "S1",
        func: async (taskId: string) => {
          called = true;
          const wf = getWorkflow("twf")!;
          transition(taskId, "done_s1", { transitions: buildTransitions(wf) });
        },
      }],
      initial_state: "ps1",
      terminal_states: ["done", "cancelled"],
    });

    createTask({ id: "r1", title: "T", workflow: "twf", initialStatus: "ps1" });
    await executePhase("r1", "s1");
    expect(called).toBe(true);
    expect(getTask("r1")!.status).toBe("done");
  });
});
```

- [ ] **Step 2: 运行测试确认失败，实现 runner.ts**

`executePhase()`：获取锁 → 查工作流 → 触发状态转换 → 执行 async 阶段函数 → 释放锁。

`runInBackground()`：`setImmediate` + `executePhase().catch()`。

- [ ] **Step 3: 创建 bin/run-phase.ts**

供 watcher/cron 外部调用的入口脚本。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/runner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/runner.ts bin/run-phase.ts tests/runner.test.ts
git commit -m "feat: 实现执行引擎（async + Push 模型）"
```

---

## Task 9: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: 实现 CLI**

基于 `commander`，命令：`init`、`start`、`status`、`cancel`、`list`、`upgrade`。移植自 `core/cli.py`。

- [ ] **Step 2: 写冒烟测试**

```typescript
// tests/cli.test.ts
import { describe, expect, test } from "bun:test";

describe("cli", () => {
  test("--version", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test("--help contains commands", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("start");
    expect(out).toContain("status");
  });
});
```

- [ ] **Step 3: 运行测试确认通过，提交**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: 实现 CLI（commander）"
```

---

## Task 10: 迁移引擎 + 通知 + Watcher

**Files:**
- Create: `src/core/migrate.ts`
- Create: `src/migrations/001-baseline.ts`
- Create: `src/core/notify.ts`
- Create: `src/core/watcher.ts`

- [ ] **Step 1: 实现迁移引擎**

扫描 `src/migrations/` 目录，按编号顺序执行，每个迁移在事务内运行。

- [ ] **Step 2: 创建基线迁移 001-baseline.ts**

幂等创建 tasks + task_logs 表。

- [ ] **Step 3: 实现 notify.ts**

简化版通知：先查工作流 `notify_func`，否则 `log.info` 兜底。

- [ ] **Step 4: 实现 watcher.ts**

扫描活跃任务，检测 running 状态超时且无锁的任务，调用 `runInBackground` 重新执行。

- [ ] **Step 5: 提交**

```bash
git add src/core/migrate.ts src/migrations/ src/core/notify.ts src/core/watcher.ts
git commit -m "feat: 实现迁移引擎 + 通知 + watcher"
```

---

## Task 11: 示例工作流

**Files:**
- Create: `examples/workflows/dev/workflow.yaml`
- Create: `examples/workflows/dev/workflow.ts`

- [ ] **Step 1: 创建 workflow.yaml**

包含 `config`（repo_path, default_branch）、`agents`（architect, developer, reviewer）、5 个 `phases`。

- [ ] **Step 2: 创建 workflow.ts**

移植自 Python 版 `examples/workflows/dev/workflow.py`，改为 async + `agent.run()` 调用。导出 `run_design`、`run_review`、`run_develop`、`run_code_review`、`run_submit_pr`、`setup_dev_task`。

- [ ] **Step 3: 提交**

```bash
git add examples/workflows/dev/
git commit -m "feat: 添加 dev 示例工作流（TypeScript + Agent）"
```

---

## Task 12: 全量测试 + 最终验证

- [ ] **Step 1: 运行全量测试**

Run: `bun test`
Expected: 全部 PASS

- [ ] **Step 2: 类型检查**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 3: CLI 冒烟**

Run: `bun run src/cli.ts --version` → `1.0.0`
Run: `bun run src/cli.ts init` → 初始化完成
Run: `bun run src/cli.ts list` → 工作流列表

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: 全量测试通过，Node.js 重写基础框架完成"
```
