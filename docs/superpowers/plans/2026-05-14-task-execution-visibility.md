# 任务执行可见性 + 产出物收口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TaskDetail 顶部展示阶段时间线（各 phase 状态 + 耗时）；任务终态时展示产出物卡片（PR 链接 + diff 概要 + 耗时分布 + 看 PR / 重跑）。

**Architecture:** 新增 `task_phase_events` 表持久化每个 phase 的起止时间；`runner.ts` 在已有的 4 个 emit 点（started / awaiting / completed / error）同时调 db helper 写 event。两个新 HTTP 端点 `GET /api/tasks/:id/phase-events` 和 `GET /api/tasks/:id/outcome`。Web 加两个组件嵌入 TaskDetail。

**Tech Stack:** TypeScript / Bun runtime / Bun.serve / bun:sqlite / React + Vite / bun:test。

**Spec:** `docs/superpowers/specs/2026-05-14-task-execution-visibility-design.md`

**进程调用约定：** 使用 `Bun.spawn` / `Bun.spawnSync`（PR #64 同风格）；测试用 `_setDbForTest(new Database(":memory:"))` + `runPendingMigrations()` 隔离；写 SQL 集中在 `src/core/db.ts`（single-writer invariant）；Web 组件不做单测。

---

## 文件结构

### 新增

| 路径 | 责任 |
|---|---|
| `src/migrations/018-task-phase-events.ts` | 建 `task_phase_events` 表 + 索引 |
| `src/daemon/task-outcome.ts` | 产出物聚合：拉 task / requirement / phase events / git diff，组合 `TaskOutcome` |
| `src/web/src/components/TaskPhaseTimeline.tsx` | 阶段时间线组件 |
| `src/web/src/components/TaskOutcomeCard.tsx` | 产出物卡片组件 |
| `src/web/src/hooks/useTaskPhaseEvents.ts` | fetch + WS 增量更新 events |
| `tests/task-phase-events.test.ts` | db helper 单测 |
| `tests/runner-phase-events.test.ts` | runner 集成测试（phase event 生命周期） |
| `tests/routes-task-phase-events.test.ts` | HTTP 路由测试（phase-events + outcome） |
| `tests/task-outcome.test.ts` | outcome 聚合逻辑测试 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/core/db.ts` | 加 `TaskPhaseEvent` 类型 + `startTaskPhase` / `endTaskPhase` / `listTaskPhaseEvents` helper |
| `src/core/runner.ts` | 4 个 emit 点同时调 db helper：started / awaiting / completed / error |
| `src/daemon/routes.ts` | 加两个 GET 路由：phase-events + outcome |
| `src/web/src/hooks/useApi.ts` | 加 `listTaskPhaseEvents` / `getTaskOutcome` API client + 类型 |
| `src/web/src/pages/TaskDetail.tsx` | 状态 badge 上方嵌入 `<TaskOutcomeCard>`（终态时）+ 下方嵌入 `<TaskPhaseTimeline>` |

---

# PR-1：阶段时间线

预估半天，6 个 task。

## Task 1：迁移 018 + db helper

**Files:**
- Create: `src/migrations/018-task-phase-events.ts`
- Modify: `src/core/db.ts`
- Create: `tests/task-phase-events.test.ts`

- [ ] **Step 1：写测**

写入 `tests/task-phase-events.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, listTaskPhaseEvents } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-phase-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("task_phase_events", () => {
  it("startTaskPhase 写入 + 返回 id", () => {
    const id = startTaskPhase("task-001", "design");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("endTaskPhase 更新 ended_at + status", () => {
    const id = startTaskPhase("task-001", "design");
    endTaskPhase(id, "done");
    const events = listTaskPhaseEvents("task-001");
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("同 phase 多次重试 → 多行", () => {
    const id1 = startTaskPhase("task-001", "design");
    endTaskPhase(id1, "failed");
    const id2 = startTaskPhase("task-001", "design");
    endTaskPhase(id2, "done");
    const events = listTaskPhaseEvents("task-001");
    expect(events.length).toBe(2);
    expect(events[0]!.status).toBe("failed");
    expect(events[1]!.status).toBe("done");
  });

  it("listTaskPhaseEvents 按 started_at 升序", () => {
    const a = startTaskPhase("task-001", "design");
    // 强制让第二个 event 的 started_at 严格大
    const start = Date.now();
    while (Date.now() === start) { /* spin until next ms */ }
    const b = startTaskPhase("task-001", "review");
    const events = listTaskPhaseEvents("task-001");
    expect(events[0]!.id).toBe(a);
    expect(events[1]!.id).toBe(b);
  });

  it("不同 task 隔离", () => {
    startTaskPhase("task-001", "design");
    startTaskPhase("task-002", "design");
    expect(listTaskPhaseEvents("task-001").length).toBe(1);
    expect(listTaskPhaseEvents("task-002").length).toBe(1);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/task-phase-events.test.ts
```
Expected: FAIL（迁移和 helper 都没建）

- [ ] **Step 3：写迁移**

写入 `src/migrations/018-task-phase-events.ts`：

```ts
import type { Database } from "bun:sqlite";

/**
 * 持久化每个 task phase 的起止时间与状态。
 *
 * 同一 (task_id, phase) 可有多行：重试 / 驳回回滚时再次进入同 phase 会新建 event。
 * status: 'running' / 'done' / 'awaiting' / 'failed'
 *   - awaiting：phase 函数完成后挂到 awaiting_<phase> 等用户决断（gate=true）
 *   - done：phase 函数完成并自动 transition 到下一 phase
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS task_phase_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_phase_events_task ON task_phase_events (task_id, started_at)`);
}
```

- [ ] **Step 4：在 `src/core/db.ts` 末尾追加类型 + helper**

```ts
// ──────────────────────────────────────────────
// task_phase_events（迁移 018）
// ──────────────────────────────────────────────

export interface TaskPhaseEvent {
  id: number;
  task_id: string;
  phase: string;
  status: "running" | "done" | "awaiting" | "failed";
  started_at: number;
  ended_at: number | null;
}

/** 在 phase 开始时插入一条 running event。返回 event id 用于后续 end。 */
export function startTaskPhase(taskId: string, phase: string): number {
  const db = getDb();
  const result = db.run(
    "INSERT INTO task_phase_events (task_id, phase, status, started_at) VALUES (?, ?, 'running', ?)",
    [taskId, phase, Date.now()],
  );
  return Number(result.lastInsertRowid);
}

/** 标记 event 结束。无对应 event id 时静默忽略（防御）。 */
export function endTaskPhase(eventId: number, status: "done" | "awaiting" | "failed"): void {
  const db = getDb();
  db.run(
    "UPDATE task_phase_events SET status = ?, ended_at = ? WHERE id = ?",
    [status, Date.now(), eventId],
  );
}

/** 列出某 task 全部 phase event，按 started_at 升序。 */
export function listTaskPhaseEvents(taskId: string): TaskPhaseEvent[] {
  const db = getDb();
  return db
    .query<TaskPhaseEvent, [string]>(
      "SELECT id, task_id, phase, status, started_at, ended_at FROM task_phase_events WHERE task_id = ? ORDER BY started_at ASC, id ASC"
    )
    .all(taskId);
}
```

- [ ] **Step 5：跑测 + commit**

```
bun test tests/task-phase-events.test.ts
git add src/migrations/018-task-phase-events.ts src/core/db.ts tests/task-phase-events.test.ts
git commit -m "feat(db): task_phase_events 表 + startTaskPhase/endTaskPhase/list helper"
```
Expected: 5 pass

## Task 2：runner.ts 集成

**Files:**
- Modify: `src/core/runner.ts`
- Create: `tests/runner-phase-events.test.ts`

参考已有 runner 测试 `tests/runner.test.ts` 了解 mock 工作流的方式。

- [ ] **Step 1：写测**

写入 `tests/runner-phase-events.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, listTaskPhaseEvents } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-runner-pe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runner phase events 集成", () => {
  it("phase 函数成功完成 → started + ended(done) 一对", async () => {
    // 建一个最小工作流：单 phase = "design"，无 gate，自动完成后没有下一 phase
    const wfDir = join(tmpHome, "workflows", "demo");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"),
      "name: demo\nphases:\n  - name: design\n    timeout: 60\n", "utf-8");
    writeFileSync(join(wfDir, "workflow.ts"),
      "export async function design(_taskId) { /* no-op */ }\n", "utf-8");

    const { discover } = await import("../src/core/registry");
    const { createTask } = await import("../src/core/db");
    const { executePhase } = await import("../src/core/runner");

    discover();
    const taskId = "task-pe-001";
    createTask({ id: taskId, title: "test", workflow: "demo", status: "pending_design" });

    await executePhase(taskId, "design");

    const events = listTaskPhaseEvents(taskId);
    expect(events.length).toBe(1);
    expect(events[0]!.phase).toBe("design");
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("phase 函数抛错 → ended(failed)", async () => {
    const wfDir = join(tmpHome, "workflows", "demo-fail");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"),
      "name: demo-fail\nphases:\n  - name: design\n    timeout: 60\n", "utf-8");
    writeFileSync(join(wfDir, "workflow.ts"),
      "export async function design(_taskId) { throw new Error('boom'); }\n", "utf-8");

    const { discover } = await import("../src/core/registry");
    const { createTask } = await import("../src/core/db");
    const { executePhase } = await import("../src/core/runner");

    discover();
    const taskId = "task-pe-002";
    createTask({ id: taskId, title: "test", workflow: "demo-fail", status: "pending_design" });

    await executePhase(taskId, "design");

    const events = listTaskPhaseEvents(taskId);
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("failed");
  });

  it("gate phase 完成 → ended(awaiting)", async () => {
    const wfDir = join(tmpHome, "workflows", "demo-gate");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"),
      "name: demo-gate\nphases:\n  - name: design\n    timeout: 60\n    gate: true\n", "utf-8");
    writeFileSync(join(wfDir, "workflow.ts"),
      "export async function design(_taskId) { /* no-op */ }\n", "utf-8");

    const { discover } = await import("../src/core/registry");
    const { createTask } = await import("../src/core/db");
    const { executePhase } = await import("../src/core/runner");

    discover();
    const taskId = "task-pe-003";
    createTask({ id: taskId, title: "test", workflow: "demo-gate", status: "pending_design" });

    await executePhase(taskId, "design");

    const events = listTaskPhaseEvents(taskId);
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("awaiting");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/runner-phase-events.test.ts
```
Expected: 3 FAIL（runner 没集成）

- [ ] **Step 3：改 runner.ts**

定位 `src/core/runner.ts` 顶部 import 区，把 `import { initDb, ... } from "./db";` 那行补上 `startTaskPhase, endTaskPhase`：

```
grep -n "from \"./db\"" src/core/runner.ts
```

参考已有 import 风格，把 `startTaskPhase`、`endTaskPhase` 加进去。

定位 `executePhase` 函数体（约第 41 行）。在 `// 设置日志标签` 之前（约 86 行附近）声明：

```ts
    let phaseEventId: number | null = null;
```

定位 `emit({ type: "phase:started", payload: { taskId, phase, label: phaseDef.label } });`（约 117 行），在它之前插入：

```ts
    phaseEventId = startTaskPhase(taskId, phase);
```

定位 `emit({ type: "phase:awaiting", payload: { taskId, phase } });`（约 151 行），在它之前插入：

```ts
            if (phaseEventId !== null) {
              endTaskPhase(phaseEventId, "awaiting");
              phaseEventId = null;
            }
```

定位 `transition(taskId, phaseDef.complete_trigger, { transitions: transitionTable });`（约 162 行），在它之前插入：

```ts
          if (phaseEventId !== null) {
            endTaskPhase(phaseEventId, "done");
            phaseEventId = null;
          }
```

定位 `emit({ type: "phase:error", payload: { taskId, phase, error: errMsg } });`（约 190 行），在它之前插入：

```ts
      if (phaseEventId !== null) {
        endTaskPhase(phaseEventId, "failed");
        phaseEventId = null;
      }
```

注意 `phaseEventId` 是 try 块外声明的局部变量，在 catch 内可见，是合法 TS。

- [ ] **Step 4：跑测**

```
bun test tests/runner-phase-events.test.ts
```
Expected: 3 pass

- [ ] **Step 5：commit**

```
git add src/core/runner.ts tests/runner-phase-events.test.ts
git commit -m "feat(runner): 集成 task_phase_events（started/awaiting/done/failed）"
```

## Task 3：GET /api/tasks/:id/phase-events 路由

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-task-phase-events.test.ts`

- [ ] **Step 1：写测**

写入 `tests/routes-task-phase-events.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { handleRequest } from "../src/daemon/routes";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-routes-pe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  createTask({ id: "task-001", title: "x", workflow: "dev", status: "running_design" });
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("GET /api/tasks/:id/phase-events", () => {
  it("返回空数组（无 event）", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it("返回该 task 的全部 event", async () => {
    const id = startTaskPhase("task-001", "design");
    endTaskPhase(id, "done");
    startTaskPhase("task-001", "review");

    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBe(2);
    expect(body.events[0].phase).toBe("design");
    expect(body.events[0].status).toBe("done");
    expect(body.events[1].phase).toBe("review");
    expect(body.events[1].status).toBe("running");
  });

  it("task 不存在 → 仍 200 返回空（不强校验 task 存在）", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-nonexistent/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/routes-task-phase-events.test.ts
```
Expected: 3 FAIL（404 路由未注册）

- [ ] **Step 3：实现路由**

定位 `src/daemon/routes.ts` 内 `// GET /api/tasks/:id/logs`（或其他 `/api/tasks/:id/...` 路由附近，用 grep 找）：

```
grep -n "method === \"GET\" && extractParam(path, /\\^\\/api\\/tasks" src/daemon/routes.ts | head -5
```

在合适位置插入：

```ts
    // GET /api/tasks/:id/phase-events
    const phaseEventsMatch = extractParam(path, /^\/api\/tasks\/([\w-]+)\/phase-events$/);
    if (method === "GET" && phaseEventsMatch) {
      const { listTaskPhaseEvents } = await import("../core/db");
      const events = listTaskPhaseEvents(phaseEventsMatch);
      return json({ events });
    }
```

`extractParam` 和 `json` 是 routes.ts 内已有 helper。

- [ ] **Step 4：跑测 + commit**

```
bun test tests/routes-task-phase-events.test.ts
git add src/daemon/routes.ts tests/routes-task-phase-events.test.ts
git commit -m "feat(daemon): GET /api/tasks/:id/phase-events"
```
Expected: 3 pass

## Task 4：useApi + useTaskPhaseEvents hook

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`
- Create: `src/web/src/hooks/useTaskPhaseEvents.ts`

- [ ] **Step 1：useApi.ts 加 API + 类型**

定位 `src/web/src/hooks/useApi.ts` 顶部类型区，追加：

```ts
export interface TaskPhaseEvent {
  id: number;
  task_id: string;
  phase: string;
  status: "running" | "done" | "awaiting" | "failed";
  started_at: number;
  ended_at: number | null;
}
```

在 api 对象末尾（其他 task 相关方法附近，grep `getTaskLogs` 找位置）追加：

```ts
  listTaskPhaseEvents: (taskId: string) =>
    request<{ events: TaskPhaseEvent[] }>(`/api/tasks/${taskId}/phase-events`).then((r) => r.events),
```

- [ ] **Step 2：写 hook（fetch only，不订阅 WS）**

设计选择：暂不订阅 WS。TaskDetail 已有 task 状态轮询，每次 task.status 变化时由调用方 trigger `refresh()`。Web 端 phase 进度的"实时"体感由组件内的 `setInterval(1000)` 滚动 elapsed 提供，不需要 WS 推送 phase 边界事件。

写入 `src/web/src/hooks/useTaskPhaseEvents.ts`：

```ts
import { useCallback, useEffect, useState } from "react";
import { api, type TaskPhaseEvent } from "./useApi";

export interface UseTaskPhaseEventsResult {
  events: TaskPhaseEvent[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useTaskPhaseEvents(taskId: string | null): UseTaskPhaseEventsResult {
  const [events, setEvents] = useState<TaskPhaseEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const e = await api.listTaskPhaseEvents(taskId);
      setEvents(e);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setEvents([]);
      return;
    }
    refresh().catch(() => {});
  }, [taskId, refresh]);

  return { events, loading, refresh };
}
```

- [ ] **Step 3：typecheck + commit**

```
bun run typecheck
git add src/web/src/hooks/useApi.ts src/web/src/hooks/useTaskPhaseEvents.ts
git commit -m "feat(web): useTaskPhaseEvents hook + useApi listTaskPhaseEvents"
```

## Task 5：TaskPhaseTimeline 组件 + 嵌入 TaskDetail

**Files:**
- Create: `src/web/src/components/TaskPhaseTimeline.tsx`
- Modify: `src/web/src/pages/TaskDetail.tsx`

- [ ] **Step 1：写组件**

写入 `src/web/src/components/TaskPhaseTimeline.tsx`：

```tsx
import { useEffect, useMemo, useState } from "react";
import type { TaskPhaseEvent } from "@/hooks/useApi";
import { cn } from "@/lib/utils";

export interface TaskPhaseTimelineProps {
  /** 工作流 phase 顺序（取自 workflow.yaml） */
  workflowPhases: string[];
  events: TaskPhaseEvent[];
}

interface PhaseSummary {
  phase: string;
  totalMs: number;          // 累加该 phase 所有 event
  latestStatus: "running" | "done" | "awaiting" | "failed" | null;
  runningStartedAt: number | null;  // 有进行中 event 时 set
  retryCount: number;       // 同 phase 出现次数（>1 显示角标）
}

function aggregate(events: TaskPhaseEvent[], workflowPhases: string[]): PhaseSummary[] {
  const map = new Map<string, PhaseSummary>();
  for (const phase of workflowPhases) {
    map.set(phase, { phase, totalMs: 0, latestStatus: null, runningStartedAt: null, retryCount: 0 });
  }
  for (const e of events) {
    const s = map.get(e.phase);
    if (!s) continue;
    s.retryCount += 1;
    s.latestStatus = e.status;
    if (e.status === "running") {
      s.runningStartedAt = e.started_at;
    } else if (e.ended_at !== null) {
      s.totalMs += e.ended_at - e.started_at;
    }
  }
  return workflowPhases.map((p) => map.get(p)!);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function StatusIcon({ status }: { status: PhaseSummary["latestStatus"] }) {
  if (status === "done")      return <span className="text-success">✓</span>;
  if (status === "awaiting")  return <span className="text-warning">⊙</span>;
  if (status === "running")   return <span className="text-accent">▶</span>;
  if (status === "failed")    return <span className="text-destructive">✗</span>;
  return <span className="text-muted-foreground">□</span>;
}

function StatusText({ status }: { status: PhaseSummary["latestStatus"] }) {
  switch (status) {
    case "done":      return <span>完成</span>;
    case "awaiting":  return <span>等待用户决断</span>;
    case "running":   return <span>进行中</span>;
    case "failed":    return <span>失败</span>;
    default:          return <span>待运行</span>;
  }
}

export function TaskPhaseTimeline({ workflowPhases, events }: TaskPhaseTimelineProps) {
  const summaries = useMemo(() => aggregate(events, workflowPhases), [events, workflowPhases]);
  const [now, setNow] = useState(Date.now());

  // 有进行中 phase 时 1Hz 重渲，让 elapsed 滚动
  useEffect(() => {
    const hasRunning = summaries.some((s) => s.runningStartedAt !== null);
    if (!hasRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [summaries]);

  if (workflowPhases.length === 0) return null;

  return (
    <section className="mb-4 border-[1.5px] border-foreground/30 bg-card">
      <header className="border-b-[1.5px] border-foreground/30 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">阶段进度</span>
      </header>
      <ul className="divide-y divide-foreground/10">
        {summaries.map((s) => {
          const runningMs = s.runningStartedAt !== null ? now - s.runningStartedAt : 0;
          const displayMs = s.totalMs + runningMs;
          const isActive = s.runningStartedAt !== null || s.latestStatus === "awaiting";
          return (
            <li key={s.phase} className={cn("flex items-center gap-3 px-3 py-2 font-mono text-xs", isActive && "bg-accent/5")}>
              <span className="w-4 shrink-0">
                <StatusIcon status={s.latestStatus} />
              </span>
              <span className="flex-1 truncate">{s.phase}</span>
              {s.retryCount > 1 && (
                <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  ×{s.retryCount}
                </span>
              )}
              <span className="w-20 text-right tabular-nums text-muted-foreground">
                {displayMs > 0 ? formatDuration(displayMs) : "—"}
              </span>
              <span className="w-28 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <StatusText status={s.latestStatus} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2：嵌入 TaskDetail**

定位 `src/web/src/pages/TaskDetail.tsx`。找到 `<StatusBadge status={task.status} />`（约 176 行）。

import 区追加：

```tsx
import { TaskPhaseTimeline } from "@/components/TaskPhaseTimeline";
import { useTaskPhaseEvents } from "@/hooks/useTaskPhaseEvents";
```

在 TaskDetail 组件函数体顶部（已有 hook 调用区附近）加：

```tsx
  const { events: phaseEvents, refresh: refreshPhaseEvents } = useTaskPhaseEvents(taskId);
  const workflowPhases = useMemo(() => {
    const list = (workflowDetail?.phases as Array<{ name: string }> | undefined) ?? [];
    return list.map((p) => p.name);
  }, [workflowDetail]);
```

确认 `useMemo` 已 import。如未导入则 `import { useMemo, ... } from "react";`。

在 task.status 变化触发的 useEffect 里追加 refresh 调用——找类似 `task.status` 依赖的 useEffect（grep `task.status` 找）。或者直接在 task 加载 useEffect 末尾追加：

```tsx
    refreshPhaseEvents().catch(() => {});
```

定位 `<StatusBadge status={task.status} />`，在它**之后**插入 timeline 组件：

```tsx
          <StatusBadge status={task.status} />
          <TaskPhaseTimeline workflowPhases={workflowPhases} events={phaseEvents} />
```

（实际位置根据 TaskDetail 已有 JSX 结构调整，确保 timeline 在状态 badge 下方、Gate banner 之上）

- [ ] **Step 3：typecheck + build:web + commit**

```
bun run typecheck
bun run build:web
git add src/web/src/components/TaskPhaseTimeline.tsx src/web/src/pages/TaskDetail.tsx
git commit -m "feat(web): TaskPhaseTimeline 嵌入 TaskDetail"
```

## Task 6：PR-1 全量验证

- [ ] **Step 1：跑全量**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过（除既有 flaky e2e）

里程碑节点，无 commit。

---

# PR-2：产出物卡片

预估半天，5 个 task。

## Task 7：task-outcome 模块

**Files:**
- Create: `src/daemon/task-outcome.ts`
- Create: `tests/task-outcome.test.ts`

- [ ] **Step 1：写测**

写入 `tests/task-outcome.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask, updateTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { computeTaskOutcome } from "../src/daemon/task-outcome";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("computeTaskOutcome", () => {
  it("非终态返回 null", async () => {
    createTask({ id: "task-001", title: "x", workflow: "dev", status: "running_design" });
    const o = await computeTaskOutcome("task-001");
    expect(o).toBeNull();
  });

  it("终态返回 outcome，包含 total_duration_ms + top_phases", async () => {
    createTask({ id: "task-002", title: "x", workflow: "dev", status: "running_design" });
    const a = startTaskPhase("task-002", "design");
    await new Promise((r) => setTimeout(r, 10));
    endTaskPhase(a, "done");
    const b = startTaskPhase("task-002", "review");
    await new Promise((r) => setTimeout(r, 20));
    endTaskPhase(b, "done");
    updateTask("task-002", { status: "done" });

    const o = await computeTaskOutcome("task-002");
    expect(o).not.toBeNull();
    expect(o!.status).toBe("done");
    expect(o!.total_duration_ms).toBeGreaterThan(0);
    expect(o!.top_phases.length).toBeGreaterThan(0);
    expect(o!.top_phases[0]!.duration_ms).toBeGreaterThanOrEqual(o!.top_phases[o!.top_phases.length - 1]!.duration_ms);
  });

  it("workspace 不存在 → diff_stat = null", async () => {
    createTask({ id: "task-003", title: "x", workflow: "dev", status: "done" });
    const o = await computeTaskOutcome("task-003");
    expect(o!.diff_stat).toBeNull();
  });

  it("failed 状态从 task_logs 拉 failure_reason", async () => {
    createTask({ id: "task-004", title: "x", workflow: "dev", status: "running_design" });
    const { appendTaskLog } = await import("../src/core/db");
    appendTaskLog({ task_id: "task-004", from_status: "running_design", to_status: "failed", trigger_name: null, note: "phase design crashed: out of memory" });
    updateTask("task-004", { status: "failed" });
    const o = await computeTaskOutcome("task-004");
    expect(o!.status).toBe("failed");
    expect(o!.failure_reason).toContain("out of memory");
  });
});
```

注意：`appendTaskLog` 是否存在 → grep 确认；如果实际签名不同，按现有 db.ts 内的函数适配。

- [ ] **Step 2：跑测看挂**

```
bun test tests/task-outcome.test.ts
```
Expected: 4 FAIL

- [ ] **Step 3：实现模块**

写入 `src/daemon/task-outcome.ts`：

```ts
import { existsSync } from "fs";
import { getTask, listTaskPhaseEvents, getDb } from "../core/db";
import { createLogger } from "../core/logger";

const log = createLogger("task-outcome");

const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "canceled"]);

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
  workspace_path: string | null;
  failure_reason: string | null;
}

/**
 * 聚合任务终态产出物。非终态返回 null。
 * 永不抛——任何子步骤失败走对应字段的 null/0 兜底。
 */
export async function computeTaskOutcome(taskId: string): Promise<TaskOutcome | null> {
  const task = getTask(taskId);
  if (!task) return null;

  const status = normalizeStatus(task.status);
  if (!status) return null;  // 非终态

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

  // 3) workspace + diff_stat
  const workspace_path = (task as Record<string, unknown>).workspace_path as string | undefined ?? null;
  let diff_stat: DiffStat | null = null;
  if (workspace_path && existsSync(workspace_path)) {
    const baseBranch = await resolveBaseBranch(reqId);
    diff_stat = await computeDiffStat(workspace_path, baseBranch);
  }

  // 4) failure_reason（status=failed 时从 task_logs 拉最近一条 to_status='failed' 的 note）
  let failure_reason: string | null = null;
  if (status === "failed") {
    try {
      const row = getDb()
        .query<{ note: string | null }, [string]>(
          "SELECT note FROM task_logs WHERE task_id = ? AND to_status = 'failed' ORDER BY id DESC LIMIT 1"
        )
        .get(taskId);
      failure_reason = row?.note ?? null;
    } catch {}
  }

  return {
    task_id: taskId,
    status,
    pr_url,
    pr_number,
    diff_stat,
    total_duration_ms,
    top_phases,
    workspace_path,
    failure_reason,
  };
}

function normalizeStatus(s: string): TaskOutcome["status"] | null {
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null;
}

async function resolveBaseBranch(reqId: string | undefined): Promise<string> {
  if (!reqId) return "main";
  try {
    const row = getDb()
      .query<{ default_branch: string | null }, [string]>(
        "SELECT c.default_branch FROM requirements r JOIN codebases c ON r.codebase_id = c.id WHERE r.id = ?"
      )
      .get(reqId);
    return row?.default_branch ?? "main";
  } catch {
    return "main";
  }
}

async function computeDiffStat(workspacePath: string, baseBranch: string): Promise<DiffStat | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const proc = Bun.spawn(["git", "diff", "--shortstat", `origin/${baseBranch}`], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode !== 0) return null;
    const stdout = await new Response(proc.stdout).text();
    const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return { files: 0, insertions: 0, deletions: 0 };
    return {
      files: parseInt(m[1]!, 10),
      insertions: parseInt(m[2] ?? "0", 10),
      deletions: parseInt(m[3] ?? "0", 10),
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}
```

注意 `getTask` / `listTaskPhaseEvents` 来自 db.ts。task 上的 `requirement_id` 和 `workspace_path` 是工作流写入的动态字段（`[key: string]: unknown`），通过 `as Record<string, unknown>` 安全取。

- [ ] **Step 4：跑测**

```
bun test tests/task-outcome.test.ts
```
Expected: 4 pass（若 `appendTaskLog` 签名差异需调整测试）

- [ ] **Step 5：commit**

```
git add src/daemon/task-outcome.ts tests/task-outcome.test.ts
git commit -m "feat(outcome): computeTaskOutcome 聚合 PR/diff/耗时/失败原因"
```

## Task 8：GET /api/tasks/:id/outcome 路由

**Files:**
- Modify: `src/daemon/routes.ts`
- Modify: `tests/routes-task-phase-events.test.ts`（追加 outcome 测试）

- [ ] **Step 1：追加测试**

在 `tests/routes-task-phase-events.test.ts` 末尾追加：

```ts
import { updateTask } from "../src/core/db";

describe("GET /api/tasks/:id/outcome", () => {
  it("非终态 → 404", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/outcome"));
    expect(res.status).toBe(404);
  });

  it("终态 → 200 + outcome 结构完整", async () => {
    const a = startTaskPhase("task-001", "design");
    endTaskPhase(a, "done");
    updateTask("task-001", { status: "done" });

    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/outcome"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(typeof body.total_duration_ms).toBe("number");
    expect(Array.isArray(body.top_phases)).toBe(true);
    expect(body.diff_stat).toBeNull();  // workspace 不在
    expect(body.pr_url).toBeNull();
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/routes-task-phase-events.test.ts
```
Expected: 2 FAIL

- [ ] **Step 3：实现路由**

在 `src/daemon/routes.ts` phase-events 路由之后插入：

```ts
    // GET /api/tasks/:id/outcome
    const outcomeMatch = extractParam(path, /^\/api\/tasks\/([\w-]+)\/outcome$/);
    if (method === "GET" && outcomeMatch) {
      const { computeTaskOutcome } = await import("./task-outcome");
      const outcome = await computeTaskOutcome(outcomeMatch);
      if (!outcome) return error("task not in terminal state", 404);
      return json(outcome);
    }
```

- [ ] **Step 4：跑测 + commit**

```
bun test tests/routes-task-phase-events.test.ts
git add src/daemon/routes.ts tests/routes-task-phase-events.test.ts
git commit -m "feat(daemon): GET /api/tasks/:id/outcome"
```
Expected: 5 pass

## Task 9：TaskOutcomeCard 组件 + useApi

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`
- Create: `src/web/src/components/TaskOutcomeCard.tsx`
- Modify: `src/web/src/pages/TaskDetail.tsx`

- [ ] **Step 1：useApi.ts 加 getTaskOutcome + 类型**

顶部类型区追加：

```ts
export interface TaskOutcome {
  task_id: string;
  status: "done" | "failed" | "cancelled";
  pr_url: string | null;
  pr_number: number | null;
  diff_stat: { files: number; insertions: number; deletions: number } | null;
  total_duration_ms: number;
  top_phases: Array<{ phase: string; duration_ms: number }>;
  workspace_path: string | null;
  failure_reason: string | null;
}
```

api 对象内 listTaskPhaseEvents 之后追加：

```ts
  getTaskOutcome: (taskId: string) =>
    request<TaskOutcome>(`/api/tasks/${taskId}/outcome`),
```

- [ ] **Step 2：写组件**

写入 `src/web/src/components/TaskOutcomeCard.tsx`：

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, RotateCcw } from "lucide-react";
import { api, type TaskOutcome } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface TaskOutcomeCardProps {
  taskId: string;
  /** 用户在终态切换时强制重拉 */
  reloadKey?: unknown;
  /** task → requirement 关系（用于「重跑」） */
  requirementId: string | null;
  workflow: string;
}

export function TaskOutcomeCard({ taskId, reloadKey, requirementId, workflow }: TaskOutcomeCardProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getTaskOutcome(taskId)
      .then(setOutcome)
      .catch(() => setOutcome(null))
      .finally(() => setLoading(false));
  }, [taskId, reloadKey]);

  if (loading || !outcome) return null;

  const statusIcon = outcome.status === "done" ? "✓" : outcome.status === "failed" ? "✗" : "⊘";
  const statusLabel = outcome.status === "done" ? "已完成" : outcome.status === "failed" ? "已失败" : "已取消";
  const statusColor = outcome.status === "done" ? "text-success" : outcome.status === "failed" ? "text-destructive" : "text-muted-foreground";

  async function handleRetry() {
    if (!requirementId) {
      toast.error("无法重跑", "任务未关联需求");
      return;
    }
    setRetrying(true);
    try {
      const t = await api.startTask({ requirement: requirementId, workflow });
      navigate(`/tasks/${t.id}`);
    } catch (e: unknown) {
      toast.error("重跑失败", (e as Error)?.message ?? String(e));
      setRetrying(false);
    }
  }

  return (
    <section className="mb-4 border-[1.5px] border-foreground/30 bg-card">
      <header className="border-b-[1.5px] border-foreground/30 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">产出物</span>
      </header>
      <div className="space-y-3 px-3 py-3 text-sm">
        <div className={"flex items-center gap-2 font-mono " + statusColor}>
          <span className="text-base">{statusIcon}</span>
          <span className="font-bold">{statusLabel}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">总耗时 {formatDuration(outcome.total_duration_ms)}</span>
        </div>

        {outcome.status === "failed" && (
          <div className="border-[1.5px] border-destructive/40 bg-destructive/5 px-2 py-1.5 font-mono text-xs text-destructive">
            {outcome.failure_reason ?? "任务失败，查看下方日志"}
          </div>
        )}

        {outcome.pr_url && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">PR</div>
            <a href={outcome.pr_url} target="_blank" rel="noreferrer" className="text-accent underline">
              #{outcome.pr_number ?? "?"} {outcome.pr_url}
            </a>
          </div>
        )}

        {outcome.diff_stat && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">改动统计</div>
            <div className="font-mono">
              {outcome.diff_stat.files} files changed · <span className="text-success">+{outcome.diff_stat.insertions}</span> / <span className="text-destructive">-{outcome.diff_stat.deletions}</span>
            </div>
          </div>
        )}

        {outcome.top_phases.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">耗时分布（top 3）</div>
            <ul className="font-mono">
              {outcome.top_phases.map((p) => (
                <li key={p.phase} className="flex justify-between">
                  <span>{p.phase}</span>
                  <span className="tabular-nums text-muted-foreground">{formatDuration(p.duration_ms)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {outcome.pr_url && (
            <Button variant="outline" size="sm" onClick={() => window.open(outcome.pr_url!, "_blank")} className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> 看 PR
            </Button>
          )}
          {requirementId && (
            <Button variant="default" size="sm" disabled={retrying} onClick={handleRetry} className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> {retrying ? "重跑中..." : "重跑"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3：嵌入 TaskDetail**

定位 `src/web/src/pages/TaskDetail.tsx` 内 `isTerminal(task.status, ...)` 调用（约 155 行）。把现有逻辑保留，并在状态 badge 之上加 outcome card：

import 区追加：

```tsx
import { TaskOutcomeCard } from "@/components/TaskOutcomeCard";
```

在 `<StatusBadge status={task.status} />` 之前插入：

```tsx
          {isTerminal(task.status, graph?.terminalStates) && (
            <TaskOutcomeCard
              taskId={task.id}
              reloadKey={task.status}
              requirementId={(task as { requirement_id?: string }).requirement_id ?? null}
              workflow={task.workflow}
            />
          )}
```

- [ ] **Step 4：typecheck + build:web + commit**

```
bun run typecheck
bun run build:web
git add src/web/src/hooks/useApi.ts src/web/src/components/TaskOutcomeCard.tsx src/web/src/pages/TaskDetail.tsx
git commit -m "feat(web): TaskOutcomeCard 终态产出物卡片"
```

## Task 10：全量验证 + push + PR

- [ ] **Step 1：全量验证**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过

- [ ] **Step 2：push 分支 + 开 PR**

```
git push -u origin <分支名（按用户长分支模式）>
gh pr create --base main --title "feat(task-visibility): 阶段时间线 + 产出物卡片" --body "依据 spec docs/superpowers/specs/2026-05-14-task-execution-visibility-design.md 实施"
```

---

## 全流程 dogfood

```
autopilot daemon start
# 浏览器开个 task，进 /tasks/<id>：
# - 状态 badge 下方应显示「阶段进度」时间线
# - 进行中 phase 显示 elapsed 滚动
# - 任务终态后状态 badge 上方应显示「产出物」卡片
# - 卡片含 PR 链接 / diff 统计 / 耗时分布 / [看 PR] [重跑]
# - 「重跑」应建一个同 requirement 的新 task 并跳过去
```
