# scheduler.max_concurrent_tasks 可配置全局并发上限 实现计划（Rev 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `config.yaml` 新增 `scheduler.max_concurrent_tasks` 参数，将调度器全局并发上限从硬编码的 1 改为可配置值（默认 1，向后兼容），支持热生效，同时修复全局计数模式下跨组 TOCTOU 竞争。

**Architecture:**
1. `src/core/config.ts` 新增 `SchedulerConfig` 接口、`loadSchedulerConfig()`、`saveSchedulerConfig()`（与其他 config 段保持 load/save 对称）；
2. `src/daemon/requirement-scheduler.ts` 引入**全局调度互斥锁**（`_globalSchedulerLock` + `_pendingTicks` + `_drainPendingTicks()`）保证跨组 TOCTOU 安全，并将 active 检测改为全局计数（含 `workspace_id !== null` 守卫）；
3. `src/daemon/index.ts` 用 `fs.watch` 监听**目录**（比监听文件更可靠，文件不存在时也能自愈）实现外部编辑热生效。

**Tech Stack:** TypeScript strict, Bun runtime, SQLite（bun:sqlite），Node.js `fs.watch`

---

## 关键设计说明：TOCTOU 修复方案

**问题根因**：`tickGroup` 中「读取 globalActive 数」与「setRequirementStatus("running")」之间存在 `await startTaskFromTemplate()` 让出点。在 N>1 场景下，不同 workspace 组的两个并发 tick 均可在首个 `await` 前读到相同的 globalActive 值，双双越过检测。

**修复方案：全局互斥锁 + 待处理队列**

```
关键性质（JS 单线程保证）：
  _globalSchedulerLock = true  ← 在首个 await 前同步完成，无法被并发代码打断

并发场景（N=2，globalActive=1）：
  tick(ws-A) 启动：lock=false → lock=true → await tickGroup("ws-A")
  tick(ws-B) 启动：lock=true  → _pendingTicks.add("ws-B") → 立即返回
  
  ws-A tick 完成（startTaskFromTemplate 成功或失败）：
    → finally: lock=false, _drainPendingTicks()
    → 微任务触发 tickRepo("ws-B")
    → ws-B 重新检查 globalActive（此时已反映 ws-A 的结果）
    → 正确判断是否有空余槽位
```

`_pendingTicks` 确保被跳过的 tick **不会永久丢失**（与原 `_inflightGroups` 的 skip-and-forget 模式不同）。`_drainPendingTicks()` 每次只取一个，通过微任务串行触发，避免重新引入并发问题。

---

## 文件改动清单

| 操作 | 路径 | 职责 |
|------|------|------|
| **新建** | `tests/scheduler-config.test.ts` | `loadSchedulerConfig()` / `saveSchedulerConfig()` 单元测试 |
| **修改** | `src/core/config.ts` | 新增 `SchedulerConfig` + `loadSchedulerConfig()` + `saveSchedulerConfig()` |
| **新建** | `tests/requirement-scheduler-global.test.ts` | 全局上限行为 + pending queue 测试 |
| **修改** | `src/daemon/requirement-scheduler.ts` | 全局锁 + pending queue + 全局 active 计数 |
| **修改** | `src/daemon/index.ts` | 目录级 `fs.watch` 热生效 |

---

## Task 1：`loadSchedulerConfig()` + `saveSchedulerConfig()` 测试 + 实现

**Files:**
- Create: `tests/scheduler-config.test.ts`
- Modify: `src/core/config.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/scheduler-config.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSchedulerConfig, saveSchedulerConfig } from "../src/core/config";

let tmpFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ap-sched-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpFile = join(tmpDir, "config.yaml");
  writeFileSync(tmpFile, "", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
});

afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("loadSchedulerConfig()", () => {
  it("scheduler 段缺失时返回空对象", () => {
    expect(loadSchedulerConfig()).toEqual({});
  });

  it("max_concurrent_tasks = 3 时正确解析", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 3\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(3);
  });

  it("max_concurrent_tasks = 1 合法（最小值）", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 1\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(1);
  });

  it("max_concurrent_tasks 为浮点数时忽略", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 2.5\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为 0 时忽略", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 0\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为负数时忽略", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: -1\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为字符串时忽略", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 'three'\n", "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("scheduler 段存在但无 max_concurrent_tasks 时返回空对象", () => {
    writeFileSync(tmpFile, "scheduler:\n  other_field: true\n", "utf-8");
    expect(loadSchedulerConfig()).toEqual({});
  });

  it("与其他 config 段共存不受影响", () => {
    writeFileSync(
      tmpFile,
      "daemon:\n  port: 6180\nscheduler:\n  max_concurrent_tasks: 5\n",
      "utf-8",
    );
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(5);
  });
});

describe("saveSchedulerConfig()", () => {
  it("写入 max_concurrent_tasks 后可读回", () => {
    saveSchedulerConfig({ max_concurrent_tasks: 4 });
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(4);
  });

  it("保留 YAML 其他段", () => {
    writeFileSync(tmpFile, "daemon:\n  port: 6180\n", "utf-8");
    saveSchedulerConfig({ max_concurrent_tasks: 3 });
    const content = readFileSync(tmpFile, "utf-8");
    expect(content).toContain("daemon:");
    expect(content).toContain("scheduler:");
    expect(content).toContain("max_concurrent_tasks: 3");
  });

  it("传入空对象时删除 scheduler 段", () => {
    writeFileSync(tmpFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");
    saveSchedulerConfig({});
    const content = readFileSync(tmpFile, "utf-8");
    expect(content).not.toContain("scheduler:");
  });

  it("max_concurrent_tasks 为 undefined 时删除 scheduler 段", () => {
    saveSchedulerConfig({ max_concurrent_tasks: 2 });
    saveSchedulerConfig({ max_concurrent_tasks: undefined });
    const content = readFileSync(tmpFile, "utf-8");
    expect(content).not.toContain("scheduler:");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```
cd C:\Users\larry\.autopilot\runtime\tasks\hue6x3wc\workspace
bun test tests/scheduler-config.test.ts
```

预期：`loadSchedulerConfig is not a function` 类错误（函数未导出）

- [ ] **Step 3: 在 `src/core/config.ts` 中实现（在第 342 行 `saveGitConfig` 结束后、`stripUndefined` 前插入）**

```typescript
// ──────────────────────────────────────────────
// 调度器配置
// ──────────────────────────────────────────────

export interface SchedulerConfig {
  /**
   * 全局最大并发任务数（所有工作区合计运行中任务总数 ≤ N）。
   * 默认 1（向后兼容：不配置时行为与之前相同）。
   *
   * ⚠️ 行为说明（N=1 时）：原实现是「组内串行，不同组可并行」；
   * 改为全局计数后，N=1 对多 workspace 用户是更严格的全局串行。
   * 这是有意为之的行为统一（需求澄清 Q1 答案：全局总上限）。
   */
  max_concurrent_tasks?: number;
}

/**
 * 读取 config.yaml 的 scheduler 段。
 * 字段缺失或类型非法时返回空对象；调用方使用 `?? 1` 取默认值 1。
 */
export function loadSchedulerConfig(): SchedulerConfig {
  try {
    const raw = loadConfig();
    const section = raw["scheduler"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: SchedulerConfig = {};
    if (
      typeof s.max_concurrent_tasks === "number" &&
      Number.isInteger(s.max_concurrent_tasks) &&
      s.max_concurrent_tasks >= 1
    ) {
      out.max_concurrent_tasks = s.max_concurrent_tasks;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入/更新 scheduler 段。max_concurrent_tasks 为 undefined 时删除整段。
 */
export function saveSchedulerConfig(cfg: SchedulerConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["scheduler"])) doc.deleteIn(["scheduler"]);
  } else {
    doc.setIn(["scheduler"], clean);
  }
  writeDocument(doc);
}
```

- [ ] **Step 4: 运行测试确认通过**

```
bun test tests/scheduler-config.test.ts
```

预期：13 个测试全部通过

- [ ] **Step 5: 回归测试**

```
bun test tests/config.test.ts
```

预期：全部通过

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts tests/scheduler-config.test.ts
git commit -m "feat: 新增 SchedulerConfig 接口及 loadSchedulerConfig / saveSchedulerConfig"
```

---

## Task 2：调度器全局锁 + 全局 active 计数

**Files:**
- Create: `tests/requirement-scheduler-global.test.ts`
- Modify: `src/daemon/requirement-scheduler.ts`

### 2a：先写失败测试

- [ ] **Step 1: 新建全局上限测试文件**

新建 `tests/requirement-scheduler-global.test.ts`：

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/workspaces";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  nextRequirementId,
  listRequirements,
} from "../src/core/requirements";
import { tickRepo } from "../src/daemon/requirement-scheduler";

/** 把需求推到目标状态 */
function pushTo(id: string, target: "queued" | "running") {
  const steps: Record<string, string[]> = {
    queued: ["clarifying", "ready", "queued"],
    running: ["clarifying", "ready", "queued", "running"],
  };
  for (const s of steps[target]) setRequirementStatus(id, s);
}

describe("tickRepo 全局并发上限", () => {
  let db: Database;
  let tmpCfgDir: string;
  let tmpCfgFile: string;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate021(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);
    createProject({ id: "proj-global", name: "global-test-proj" });
    // 三个独立 workspace（无 remote_url → startTaskFromTemplate 失败→ rollback "ready"）
    createWorkspace({ id: "ws-g1", project_id: "proj-global", alias: "g1", path: "/tmp/g1", default_branch: "main" });
    createWorkspace({ id: "ws-g2", project_id: "proj-global", alias: "g2", path: "/tmp/g2", default_branch: "main" });
    createWorkspace({ id: "ws-g3", project_id: "proj-global", alias: "g3", path: "/tmp/g3", default_branch: "main" });

    tmpCfgDir = join(tmpdir(), `ap-sched-global-${Date.now()}`);
    mkdirSync(tmpCfgDir, { recursive: true });
    tmpCfgFile = join(tmpCfgDir, "config.yaml");
    writeFileSync(tmpCfgFile, "", "utf-8");
    process.env.DEV_WORKFLOW_CONFIG = tmpCfgFile;
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    if (existsSync(tmpCfgDir)) rmSync(tmpCfgDir, { recursive: true, force: true });
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    writeFileSync(tmpCfgFile, "", "utf-8"); // 重置 max=1（默认）
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  // ──────── 基础阻塞行为 ────────

  it("N=1（默认）：ws-g1 有 running，ws-g2 的 queued 被全局上限阻塞", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running"); // 手动设 running 占位

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g2");

    // globalActive=1 >= N=1 → tickGroup 提前返回，idB 保持 queued
    expect(getRequirementById(idB)?.status).toBe("queued");
  });

  it("N=2：1 个 running 时不阻塞另一 workspace（调度器尝试启动，startTaskFromTemplate 失败回滚 → ready）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g2");

    // globalActive=1 < N=2 → 调度器尝试启动 ws-g2 的任务。
    // 测试环境无真实 workflow/remote_url，startTaskFromTemplate 抛错 →
    // tickGroup error handler 回滚：status = "ready"，schedule_error 写入。
    // "ready"（而非 "queued"）证明没被全局上限拦截。
    const req = getRequirementById(idB);
    expect(req?.status).toBe("ready");
    expect(req?.schedule_error).toBeTruthy();
  });

  it("N=2：2 个 running 时阻塞第 3 个（status 保持 queued）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "running");

    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");

    await tickRepo("ws-g3");

    // globalActive=2 >= N=2 → 调度器提前返回，idC 保持 queued
    expect(getRequirementById(idC)?.status).toBe("queued");
  });

  it("workspace_id = null 的高层需求不计入全局 active", async () => {
    // 直接写 DB：模拟 workspace_id=null 的需求处于 running 状态
    // （正常流程不会发生，但需要守卫防止未来意外影响调度）
    db.run(`
      INSERT INTO requirements (id, title, status, project_id, workspace_id, created_at, updated_at)
      VALUES ('req-null-ws', 'null ws req', 'running', 'proj-global', NULL, 0, 0)
    `);

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g1", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g1");

    // workspace_id=null 的 running 不占槽位，ws-g1 的 queued 应被调度尝试
    // startTaskFromTemplate 失败 → "ready"（不应该是 "queued"）
    expect(getRequirementById(idB)?.status).not.toBe("queued");
    expect(getRequirementById(idB)?.status).toBe("ready");
  });

  // ──────── TOCTOU 全局锁：pending queue 不丢失 ────────

  it("全局锁：并发 tickRepo 时，被锁阻塞的 tick 进入 pending，锁释放后自动重试（不永久丢失）", async () => {
    // 两个 workspace 各有 queued 需求，无 running（N=1）
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g1", title: "B" });
    pushTo(idB, "queued");

    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g2", title: "C" });
    pushTo(idC, "queued");

    // 同时发起两个 tick（Promise.all 让两个调用"同时"进入 tickRepo）
    // 期望：
    //   - ws-g1 的 tick 先获取全局锁，尝试 startTaskFromTemplate → 失败 → "ready"
    //   - ws-g2 的 tick 发现锁被占用，加入 _pendingTicks 后立即 resolve
    //   - ws-g1 tick 完成后，drain 异步触发 ws-g2 的 tick
    //   - ws-g2 tick 也尝试 startTaskFromTemplate → 失败 → "ready"
    await Promise.all([tickRepo("ws-g1"), tickRepo("ws-g2")]);

    // 等待 drain 链完成：ws-g2 的 tick 通过微任务触发，整个 tick 是 async 的。
    // 轮询最多 500ms（实测通常 < 50ms）
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (getRequirementById(idC)?.status !== "queued") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // 两个需求都不应停留在 "queued"（均被调度器处理过，失败后回滚 → "ready"）
    // 关键断言：ws-g2 的需求最终脱离了 "queued"，证明 pending queue 没有丢失它
    expect(getRequirementById(idB)?.status).not.toBe("queued");
    expect(getRequirementById(idC)?.status).not.toBe("queued");
  });

  it("全局计数在 N 上限满时不超量（running 数 ≤ N）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    // 已有 2 running
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "running");

    // 第 3 个试图入队
    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");

    await tickRepo("ws-g3");

    // 调度器看到 2 running >= N=2，不尝试启动
    const allActive = listRequirements({}).filter(
      (r) => r.workspace_id !== null && (r.status === "running" || r.status === "fix_revision"),
    );
    expect(allActive.length).toBeLessThanOrEqual(2); // 不超量
    expect(getRequirementById(idC)?.status).toBe("queued"); // 第 3 个被阻塞
  });
});
```

- [ ] **Step 2: 运行测试确认当前失败（全局锁未实现，跨 workspace 测试失败）**

```
bun test tests/requirement-scheduler-global.test.ts
```

预期：至少第 1、4、5、6 个测试失败（现有代码是组内检测，无全局计数）

### 2b：实现全局锁 + 全局 active 计数

- [ ] **Step 3: 修改 `src/daemon/requirement-scheduler.ts`——新增 import**

在第 1 行的 import 块末尾追加（放在 `createLogger` import 后面）：

```typescript
import { loadSchedulerConfig } from "../core/config";
```

- [ ] **Step 4: 修改 `src/daemon/requirement-scheduler.ts`——新增模块级变量和函数**

将第 15-16 行（`_inflightGroups` 定义）替换为以下内容：

```typescript
/** 同组串行锁：防并发 tickRepo（同组两个事件）双双越过 active 检测各起一个 task（SC-3 TOCTOU）。 */
const _inflightGroups = new Set<string>();

/**
 * 全局调度互斥锁：防止跨组并发 tick 出现 TOCTOU。
 *
 * 原理（JS 单线程保证）：
 *   此变量在首个 await 前同步赋值，不会被其他协程打断。
 *   两个并发 tick 中，第一个同步置 true，第二个看到 true 后进入 _pendingTicks。
 *   待第一个 tick 完成，finally 中释放锁并触发 drain，串行处理等待队列。
 *
 * 与 _inflightGroups（skip-and-forget）不同：_pendingTicks 确保不丢失。
 */
let _globalSchedulerLock = false;
/** 等待全局锁释放后重试的 workspace id（Set 自动去重，同一 workspace 不重复入队）。 */
const _pendingTicks = new Set<string>();

/**
 * 从 _pendingTicks 取一个 workspace 重试调度。
 * 每次只取一个（串行），通过微任务（Promise.resolve().then）触发，
 * 在下一个 I/O 事件（宏任务）前执行，防止宏任务抢先重获锁。
 */
function _drainPendingTicks(): void {
  if (_pendingTicks.size === 0) return;
  const [next] = _pendingTicks;
  _pendingTicks.delete(next);
  Promise.resolve().then(() =>
    tickRepo(next).catch((e: unknown) =>
      log.error("_drainPendingTicks: 重试失败 workspace=%s: %s", next, (e as Error).message),
    ),
  );
}
```

- [ ] **Step 5: 修改 `src/daemon/requirement-scheduler.ts`——更新 `tickRepo` 函数（第 31-52 行）**

将 `tickRepo` 函数整体替换为：

```typescript
/**
 * 单组 tick 入口：父 workspace + 所有关联子模块视为一个调度组。
 *
 * 算法（spec §4.3 组级扩展，Rev2 全局限速）：
 *   - groupId = workspace.parent_workspace_id ?? workspace.id
 *   - 全局 active = listRequirements({}) 中 workspace_id IS NOT NULL 且 status ∈ {running, fix_revision}
 *   - 若 global_active ≥ max_concurrent_tasks（默认 1）：do nothing
 *   - 否则取主仓库（父 groupId）上最老 queued requirement → startTaskFromTemplate
 *
 * 失败时回滚 status: queued → ready
 *
 * ⚠️ 行为变更（Rev2）：从「组内串行」改为「全局总上限」。
 *   N=1 时，多 workspace 用户从「每组最多 1 个」变为「全局最多 1 个」（更严格）。
 *   这是需求澄清 Q1 答案（全局总上限）的有意调整，非 bug。
 */
export async function tickRepo(workspaceId: string): Promise<void> {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) {
    log.error("tickRepo: workspace %s 不存在", workspaceId);
    return;
  }
  const groupId = workspace.parent_workspace_id ?? workspace.id;

  // 同组串行守卫（SC-3 TOCTOU）：同组两个事件并发时，跳过是安全的——
  // in-progress tick 完成后释放 _inflightGroups，下次事件再触发。
  if (_inflightGroups.has(groupId)) {
    log.info("tickRepo: group %s 已有调度在执行，本次跳过（同仓库串行）", groupId);
    return;
  }

  // 全局调度互斥锁（Rev2 TOCTOU 修复）：
  //   此赋值在首个 await 前同步完成（JS 单线程），其他协程无法在此窗口内插入。
  //   被阻塞的 tick 进入 _pendingTicks，锁释放后由 _drainPendingTicks 串行触发。
  if (_globalSchedulerLock) {
    log.info("tickRepo: 全局调度锁占用，入队等待 workspace=%s group=%s", workspaceId, groupId);
    _pendingTicks.add(workspaceId);
    return;
  }

  _globalSchedulerLock = true;
  _inflightGroups.add(groupId);
  try {
    await tickGroup(groupId);
  } finally {
    _inflightGroups.delete(groupId);
    _globalSchedulerLock = false;
    // 锁释放后串行处理等待队列
    _drainPendingTicks();
  }
}
```

- [ ] **Step 6: 修改 `src/daemon/requirement-scheduler.ts`——更新 `tickGroup` 函数（第 54 行起）**

将 `tickGroup` 函数开头的 active 检测部分（原第 55-67 行）替换为：

```typescript
/** tickRepo 的实际调度体（调用时已持全局锁 _globalSchedulerLock 和同组锁 _inflightGroups）。 */
async function tickGroup(groupId: string): Promise<void> {
  // 保留 submodules 供日志输出（不再用于 active 过滤，active 已改为全局）
  const submodules = listSubmodules(groupId);

  // 全局 active 检测（不区分 workspace 组）：
  //   - workspace_id IS NOT NULL：排除高层需求（无工作区绑定），防止其错误占用槽位
  //   - status ∈ {running, fix_revision}：占用槽位的两种状态
  const all = listRequirements({});
  const maxConcurrent = loadSchedulerConfig().max_concurrent_tasks ?? 1;
  const globalActive = all.filter(
    (r) => r.workspace_id !== null && (r.status === "running" || r.status === "fix_revision"),
  );
  if (globalActive.length >= maxConcurrent) return;
```

**同时删除**原第 56-57 行 `const groupWorkspaceIds = ...`（已不再使用）。其余代码（候选选取、task 创建、错误处理）保持不变。

- [ ] **Step 7: 修改 `src/daemon/requirement-scheduler.ts`——更新 `disposeRequirementScheduler`（第 217-221 行）**

将：
```typescript
export function disposeRequirementScheduler(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
```
替换为：
```typescript
export function disposeRequirementScheduler(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
  // 清除全局状态，防止 daemon 重启后残留脏状态
  _globalSchedulerLock = false;
  _pendingTicks.clear();
}
```

- [ ] **Step 8: 运行全局上限测试**

```
bun test tests/requirement-scheduler-global.test.ts
```

预期：6 个测试全部通过

- [ ] **Step 9: 运行原有调度器测试（回归）**

```
bun test tests/requirement-scheduler.test.ts tests/requirement-scheduler-integration.test.ts
```

预期：全部通过（原测试验证数据过滤和组内阻塞，不受全局改动破坏）

- [ ] **Step 10: 运行全量测试**

```
bun test
```

预期：无新增失败

- [ ] **Step 11: 类型检查**

```
bun run typecheck
```

预期：零报错

- [ ] **Step 12: Commit**

```bash
git add src/daemon/requirement-scheduler.ts tests/requirement-scheduler-global.test.ts
git commit -m "feat: 调度器引入全局互斥锁防 TOCTOU，active 检测改为全局计数（含 workspace_id 守卫）"
```

---

## Task 3：daemon 热生效（目录级 fs.watch）

**Files:**
- Modify: `src/daemon/index.ts`

> **变更说明**：
> - 通过 Web UI / RPC 写 config 时，API handler 已经 `emit({ type: "config:updated", payload: {} })`，热生效路径已通。
> - 本 Task 补全「用户直接用编辑器修改 config.yaml」的路径。
> - 监听**目录**而非文件：当 config.yaml 不存在时（如 daemon 启动后用户首次创建），监听目录依然有效，能自愈。

- [ ] **Step 1: 修改 `src/daemon/index.ts` 的 `path` import**

在文件顶部找到 `import { join } from "path";`，改为：

```typescript
import { join, dirname, basename } from "path";
```

- [ ] **Step 2: 修改 `src/daemon/index.ts` 的 `fs` import**

找到：
```typescript
import { writeFileSync, existsSync, unlinkSync } from "fs";
```
改为：
```typescript
import { writeFileSync, existsSync, unlinkSync, watch as fsWatch } from "fs";
```

- [ ] **Step 3: 修改 `src/daemon/index.ts` 的 `config` import**

找到：
```typescript
import { loadDaemonConfig, loadGithubConfig } from "../core/config";
```
改为：
```typescript
import { loadDaemonConfig, loadGithubConfig, getConfigPath } from "../core/config";
```

- [ ] **Step 4: 修改 `src/daemon/index.ts` 的 `event-bus` import**

找到：
```typescript
import { enableBus, disableBus, bus } from "../core/event-bus";
```
改为：
```typescript
import { enableBus, disableBus, bus, emit as emitEvent } from "../core/event-bus";
```

- [ ] **Step 5: 在 `startDaemon` 中添加目录级 config 监听**

在 `enableBus();` 调用之后（第 187 行附近）、`const { onEvent } = await import(...)` 之前，插入以下代码块：

```typescript
  // ── 外部编辑 config.yaml 热生效 ──────────────────────────────────────────
  // 监听目录（而非文件）有两个好处：
  //   1. daemon 启动时 config.yaml 不存在也能正常监听，文件创建后即可热生效
  //   2. 部分编辑器（如 vim、Emacs）先写临时文件再重命名，监听文件会失去跟踪
  // 防抖 300ms：编辑器保存时 fs.watch 可能连续触发（Windows 尤甚）。
  // 已通过 RPC/Web UI 写的路径（rpc-methods.ts / routes.ts）不受此影响，各自 emit。
  const configFilePath = getConfigPath();
  const configDir = dirname(configFilePath);
  const configFilename = basename(configFilePath);
  let configWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  let configDirWatcher: ReturnType<typeof fsWatch> | null = null;
  try {
    configDirWatcher = fsWatch(configDir, { persistent: false }, (_event, filename) => {
      // filename 为 null 时（某些平台不提供）也触发，统一处理
      if (filename !== null && filename !== configFilename) return;
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(() => {
        configWatchDebounce = null;
        log.info("config.yaml 检测到外部变化（目录监听），发射 config:updated 热生效");
        emitEvent({ type: "config:updated", payload: {} });
      }, 300);
    });
    log.info("config 目录监听已启动：%s（目标文件：%s）", configDir, configFilename);
  } catch (e: unknown) {
    // 目录不存在或权限不足时跳过（daemon 仍正常运行，热生效不可用）
    log.warn("config 目录监听启动失败，外部编辑热生效不可用：%s", (e as Error).message);
  }
  // ──────────────────────────────────────────────────────────────────────────
```

- [ ] **Step 6: 在 `shutdown` 函数中清理 watcher**

找到 `shutdown` 函数中 `clearInterval(prPollerTimer);` 这行，在它**之后**插入：

```typescript
    configDirWatcher?.close();
    if (configWatchDebounce) {
      clearTimeout(configWatchDebounce);
      configWatchDebounce = null;
    }
```

- [ ] **Step 7: 类型检查**

```
bun run typecheck
```

预期：零报错

- [ ] **Step 8: 全量测试**

```
bun test
```

预期：全部通过（fs.watch 逻辑在测试中不实际运行，不影响单元测试）

- [ ] **Step 9: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat: daemon 监听 config 目录变化（目录级 fs.watch），外部编辑 config.yaml 保存即热生效"
```

---

## 最终验收

- [ ] **人工验证热生效**

```bash
# 终端 1：启动 daemon 观察日志
autopilot daemon run

# 终端 2：修改 config.yaml（scheduler 段）
# 追加 scheduler 配置
printf "\nscheduler:\n  max_concurrent_tasks: 3\n" >> ~/.autopilot/config.yaml

# 观察终端 1 日志应出现：
# config.yaml 检测到外部变化（目录监听），发射 config:updated 热生效
```

- [ ] **人工验证默认行为**

```bash
# 不配置 scheduler 时，等价 N=1，调度行为向后兼容
grep "max_concurrent_tasks" ~/.autopilot/config.yaml || echo "未配置（默认 N=1）"
```

---

## 自检：规格覆盖

| 需求点 | 对应 Task | 解决方案 |
|--------|----------|---------|
| `scheduler.max_concurrent_tasks` 配置项 | Task 1 | `SchedulerConfig` + `loadSchedulerConfig()` |
| `saveSchedulerConfig()` 对称 | Task 1 | 与其他段 load/save 保持一致 |
| 默认值 1，向后兼容 | Task 1（`?? 1`）+ Task 2 | 有意调整多 workspace 行为（见注释）|
| 全局总上限（不区分 workspace 组） | Task 2 | 全局 active 计数 |
| `workspace_id !== null` 守卫 | Task 2 | 排除无工作区绑定的高层需求 |
| **跨组 TOCTOU 修复** | Task 2 | `_globalSchedulerLock` + `_pendingTicks` + `_drainPendingTicks()` |
| `disposeRequirementScheduler` 清理 | Task 2 | 重置锁状态，防止 daemon 重启后残留 |
| 热生效，保存即生效 | Task 3 | 目录级 `fs.watch` + 防抖 300ms |
| fs.watch 文件不存在时自愈 | Task 3 | 监听**目录**而非文件 |
| 在途任务不打断 | 设计保证 | 仅改 active 检测逻辑，不 cancel 运行中任务 |
| pending tick 不丢失 | Task 2 | `_pendingTicks` + drain 机制（测试用例 Step 1 第 5 个测试覆盖）|
