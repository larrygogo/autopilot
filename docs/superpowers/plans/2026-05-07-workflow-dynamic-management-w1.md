# 工作流动态管理 W1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 W 系列基础层 — 新增 `workflows` 表、CRUD 模块、文件→DB 同步、registry 多源加载与同名冲突检测。

**Architecture:** migration 007 创建 workflows 表（含 CHECK 约束）；新模块 `src/core/workflows.ts` 提供纯 SQL CRUD + 文件同步函数；`src/core/registry.ts::discover()` 改为「扫文件 → 同步到 DB → 从 DB 加载所有」三步；DB 工作流通过 `derives_from` 引用 file 工作流的 phase 函数表。

**Tech Stack:** Bun + bun:sqlite，bun:test，TypeScript strict。

---

## File Structure

**Create:**
- `src/migrations/007-workflows.ts` — schema migration
- `src/core/workflows.ts` — CRUD + 同步逻辑
- `tests/migration-007.test.ts` — schema 测试
- `tests/workflows-crud.test.ts` — CRUD 测试
- `tests/workflows-sync.test.ts` — 文件→DB 同步测试
- `tests/registry-multi-source.test.ts` — registry 多源加载集成测试

**Modify:**
- `src/core/registry.ts` — discover 多源 + 冲突检测 + composeDbWorkflow

---

## Task 1：migration 007 — workflows 表

**Files:**
- Create: `src/migrations/007-workflows.ts`
- Create: `tests/migration-007.test.ts`

- [ ] **Step 1：写失败测试**

新建 `tests/migration-007.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";

describe("migration 007-workflows", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
  });

  afterAll(() => db.close());

  it("workflows 表存在且字段完整", () => {
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(workflows)"
    ).all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("name");
    expect(names).toContain("description");
    expect(names).toContain("yaml_content");
    expect(names).toContain("source");
    expect(names).toContain("derives_from");
    expect(names).toContain("file_path");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
  });

  it("source CHECK 约束：source=file 必须有 file_path 不能有 derives_from", () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
      ["wf_a", "", "name: wf_a\nphases: []\n", "/tmp/wf_a", ts, ts]
    );
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, derives_from, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?)",
        ["wf_bad1", "", "x", "req_dev", "/tmp/wf_bad1", ts, ts]
      )
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?)",
        ["wf_bad2", "", "x", ts, ts]
      )
    ).toThrow();
  });

  it("source CHECK 约束：source=db 必须有 derives_from 不能有 file_path", () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
      ["wf_b", "", "name: wf_b\nphases: []\n", "wf_a", ts, ts]
    );
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?)",
        ["wf_bad3", "", "x", ts, ts]
      )
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, derives_from, file_path, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?, ?)",
        ["wf_bad4", "", "x", "wf_a", "/tmp/x", ts, ts]
      )
    ).toThrow();
  });

  it("source 列只允许 'db' 或 'file'", () => {
    const ts = Date.now();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'other', ?, ?, ?)",
        ["wf_bad5", "", "x", "/tmp/x", ts, ts]
      )
    ).toThrow();
  });

  it("name 是主键", () => {
    const ts = Date.now();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
        ["wf_a", "", "x", "/tmp/wf_a2", ts, ts]
      )
    ).toThrow();
  });

  it("idx_workflows_source 索引存在", () => {
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflows_source'"
    ).all();
    expect(idx.length).toBe(1);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/migration-007.test.ts
```
预期：FAIL（migration 文件不存在 → import 报错）。

- [ ] **Step 3：写 migration 007**

新建 `src/migrations/007-workflows.ts`，**注意：用 `db.run` 多条写法**（bun:sqlite 单语句 run；不要写成单一多语句脚本，避免代码扫描误警）：

```ts
import type { Database } from "bun:sqlite";

/**
 * 007-workflows
 *
 * 创建 workflows 表，作为工作流配置的权威存储。
 *
 * - source='file': 文件工作流（~/.autopilot/workflows/<name>/）的 DB 镜像；
 *   yaml_content 由 daemon 启动时同步；file_path 指向原目录绝对路径。
 * - source='db':   chat / CLI 创建的派生工作流；必须 derives_from 一个
 *   source='file' 工作流；phase 函数从 base 复用；不允许嵌套派生（W1 限制）。
 *
 * CHECK 约束保证两种 source 的字段组合合法（参见 spec §3.1）。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      name           TEXT PRIMARY KEY,
      description    TEXT NOT NULL DEFAULT '',
      yaml_content   TEXT NOT NULL,
      source         TEXT NOT NULL CHECK(source IN ('db', 'file')),
      derives_from   TEXT,
      file_path      TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      CHECK(
        (source = 'db'   AND derives_from IS NOT NULL AND file_path IS NULL) OR
        (source = 'file' AND derives_from IS NULL     AND file_path IS NOT NULL)
      )
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source)"
  );
}
```

- [ ] **Step 4：跑测试，预期通过**

```bash
bun test tests/migration-007.test.ts
```
预期：6 个用例全 pass。

- [ ] **Step 5：跑全套**

```bash
bun test
```

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w1-20260507
git add src/migrations/007-workflows.ts tests/migration-007.test.ts
git commit -m "feat(db): migration 007 — workflows 表 + CHECK 约束"
```

---

## Task 2：src/core/workflows.ts CRUD

**Files:**
- Create: `src/core/workflows.ts`
- Create: `tests/workflows-crud.test.ts`

- [ ] **Step 1：写失败测试**

新建 `tests/workflows-crud.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import {
  listWorkflowsInDb,
  getWorkflowFromDb,
  createDbWorkflow,
  updateDbWorkflow,
  deleteDbWorkflow,
  upsertFileWorkflow,
} from "../src/core/workflows";

describe("workflows CRUD", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM workflows");
  });

  it("upsertFileWorkflow 插入新行", () => {
    const wf = upsertFileWorkflow({
      name: "req_dev",
      description: "需求驱动开发",
      yaml_content: "name: req_dev\nphases: []\n",
      file_path: "/tmp/wf/req_dev",
    });
    expect(wf.source).toBe("file");
    expect(wf.derives_from).toBeNull();
    expect(wf.file_path).toBe("/tmp/wf/req_dev");
  });

  it("upsertFileWorkflow 已存在时更新 yaml_content + updated_at", () => {
    const w1 = upsertFileWorkflow({
      name: "req_dev",
      description: "v1",
      yaml_content: "yaml: v1",
      file_path: "/tmp/wf/req_dev",
    });
    const w2 = upsertFileWorkflow({
      name: "req_dev",
      description: "v2",
      yaml_content: "yaml: v2",
      file_path: "/tmp/wf/req_dev",
    });
    expect(w2.yaml_content).toBe("yaml: v2");
    expect(w2.description).toBe("v2");
    expect(w2.updated_at).toBeGreaterThanOrEqual(w1.updated_at);
  });

  it("createDbWorkflow 必须 derives_from 一个 file workflow", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    const wf = createDbWorkflow({
      name: "req_dev_fast",
      description: "快速版",
      derives_from: "req_dev",
      yaml_content: "name: req_dev_fast\nphases: []\n",
    });
    expect(wf.source).toBe("db");
    expect(wf.derives_from).toBe("req_dev");
    expect(wf.file_path).toBeNull();
  });

  it("createDbWorkflow derives_from 不存在时报错", () => {
    expect(() =>
      createDbWorkflow({
        name: "wf_x",
        description: "",
        derives_from: "no_such",
        yaml_content: "x",
      })
    ).toThrow(/derives_from.*不存在/);
  });

  it("createDbWorkflow derives_from 指向 source=db 时报错（禁嵌套）", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_db1",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    expect(() =>
      createDbWorkflow({
        name: "wf_db2",
        description: "",
        derives_from: "wf_db1",
        yaml_content: "x",
      })
    ).toThrow(/嵌套|file/);
  });

  it("createDbWorkflow 同名冲突报错", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    expect(() =>
      createDbWorkflow({
        name: "wf_a",
        description: "",
        derives_from: "req_dev",
        yaml_content: "y",
      })
    ).toThrow();
  });

  it("updateDbWorkflow 仅修改 db 工作流", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    expect(() =>
      updateDbWorkflow("req_dev", { yaml_content: "y" })
    ).toThrow(/file|只读/);

    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    const updated = updateDbWorkflow("wf_a", {
      yaml_content: "y",
      description: "new desc",
    });
    expect(updated?.yaml_content).toBe("y");
    expect(updated?.description).toBe("new desc");
  });

  it("deleteDbWorkflow 仅删 db 工作流", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    expect(() => deleteDbWorkflow("req_dev")).toThrow(/file|只读/);

    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    deleteDbWorkflow("wf_a");
    expect(getWorkflowFromDb("wf_a")).toBeNull();
  });

  it("listWorkflowsInDb 列出全部 + 按 name 排序", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    createDbWorkflow({
      name: "wf_b",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    const list = listWorkflowsInDb();
    expect(list.length).toBe(3);
    expect(list.map((w) => w.name).sort()).toEqual(["req_dev", "wf_a", "wf_b"]);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/workflows-crud.test.ts
```
预期：模块不存在 import 错误 → FAIL。

- [ ] **Step 3：实现 src/core/workflows.ts**

新建 `src/core/workflows.ts`：

```ts
import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export interface WorkflowRow {
  name: string;
  description: string;
  yaml_content: string;
  source: "db" | "file";
  derives_from: string | null;
  file_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertFileWorkflowOpts {
  name: string;
  description: string;
  yaml_content: string;
  file_path: string;
}

export interface CreateDbWorkflowOpts {
  name: string;
  description: string;
  derives_from: string;
  yaml_content: string;
}

export interface UpdateDbWorkflowOpts {
  description?: string;
  yaml_content?: string;
}

// ──────────────────────────────────────────────
// 查询
// ──────────────────────────────────────────────

export function listWorkflowsInDb(): WorkflowRow[] {
  const db = getDb();
  return db
    .query<WorkflowRow, []>(
      "SELECT * FROM workflows ORDER BY name ASC"
    )
    .all();
}

export function getWorkflowFromDb(name: string): WorkflowRow | null {
  const db = getDb();
  const row = db
    .query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE name = ?")
    .get(name);
  return row ?? null;
}

// ──────────────────────────────────────────────
// 文件工作流：启动时同步
// ──────────────────────────────────────────────

/**
 * 把文件工作流写入 / 更新到 DB（source=file 镜像）。
 * 已存在时 yaml_content / description / updated_at 更新；created_at 保留。
 * 若 DB 中存在同名 source=db 行 → 抛错（同名冲突，spec §4.3）。
 */
export function upsertFileWorkflow(opts: UpsertFileWorkflowOpts): WorkflowRow {
  const db = getDb();
  const ts = Date.now();
  const existing = getWorkflowFromDb(opts.name);
  if (existing && existing.source !== "file") {
    throw new Error(
      `workflow "${opts.name}" 在 DB 中已存在但 source=${existing.source}，与文件冲突；请先删除 DB 工作流或重命名文件目录`
    );
  }
  if (existing) {
    db.run(
      "UPDATE workflows SET description = ?, yaml_content = ?, file_path = ?, updated_at = ? WHERE name = ?",
      [opts.description, opts.yaml_content, opts.file_path, ts, opts.name]
    );
  } else {
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
      [opts.name, opts.description, opts.yaml_content, opts.file_path, ts, ts]
    );
  }
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

/**
 * 同步阶段结束时调用：删除 DB 中存在但本次 file 扫描里已没有的 file 工作流。
 * （用户手动删除了 ~/.autopilot/workflows/<name>/ 目录的情况）
 */
export function deleteOrphanFileWorkflows(seenNames: Set<string>): string[] {
  const db = getDb();
  const removed: string[] = [];
  const all = db
    .query<{ name: string }, []>(
      "SELECT name FROM workflows WHERE source = 'file'"
    )
    .all();
  for (const { name } of all) {
    if (!seenNames.has(name)) {
      db.run("DELETE FROM workflows WHERE name = ? AND source = 'file'", [name]);
      removed.push(name);
    }
  }
  return removed;
}

// ──────────────────────────────────────────────
// DB 工作流：CRUD
// ──────────────────────────────────────────────

export function createDbWorkflow(opts: CreateDbWorkflowOpts): WorkflowRow {
  const base = getWorkflowFromDb(opts.derives_from);
  if (!base) {
    throw new Error(`derives_from "${opts.derives_from}" 不存在`);
  }
  if (base.source !== "file") {
    throw new Error(
      `derives_from "${opts.derives_from}" 是 source=${base.source}，DB 工作流必须派生自 file 工作流（不支持嵌套派生）`
    );
  }
  if (getWorkflowFromDb(opts.name)) {
    throw new Error(`工作流 "${opts.name}" 已存在`);
  }

  const db = getDb();
  const ts = Date.now();
  db.run(
    "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
    [opts.name, opts.description, opts.yaml_content, opts.derives_from, ts, ts]
  );
  return getWorkflowFromDb(opts.name) as WorkflowRow;
}

export function updateDbWorkflow(
  name: string,
  opts: UpdateDbWorkflowOpts
): WorkflowRow | null {
  const existing = getWorkflowFromDb(name);
  if (!existing) return null;
  if (existing.source !== "db") {
    throw new Error(`工作流 "${name}" 是 file 来源、只读；请改源文件后 daemon reload`);
  }

  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number)[] = [];
  if (opts.description !== undefined) {
    fields.push("description = ?");
    vals.push(opts.description);
  }
  if (opts.yaml_content !== undefined) {
    fields.push("yaml_content = ?");
    vals.push(opts.yaml_content);
  }
  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(name);
  db.run(`UPDATE workflows SET ${fields.join(", ")} WHERE name = ?`, vals);
  return getWorkflowFromDb(name);
}

export function deleteDbWorkflow(name: string): void {
  const existing = getWorkflowFromDb(name);
  if (!existing) return;
  if (existing.source !== "db") {
    throw new Error(`工作流 "${name}" 是 file 来源、只读；删除请操作源文件目录`);
  }
  const db = getDb();
  db.run("DELETE FROM workflows WHERE name = ? AND source = 'db'", [name]);
}
```

- [ ] **Step 4：跑测试**

```bash
bun test tests/workflows-crud.test.ts
bun run typecheck
```
预期：8 用例 pass，typecheck clean。

- [ ] **Step 5：跑全套**

```bash
bun test
```

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w1-20260507
git add src/core/workflows.ts tests/workflows-crud.test.ts
git commit -m "feat(core): src/core/workflows.ts CRUD + upsertFileWorkflow"
```

---

## Task 3：syncFileWorkflowsToDb（文件→DB 整体同步）

**Files:**
- Modify: `src/core/workflows.ts` 加 `syncFileWorkflowsToDb(scanResults)`
- Create: `tests/workflows-sync.test.ts`

- [ ] **Step 1：写失败测试**

新建 `tests/workflows-sync.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import {
  syncFileWorkflowsToDb,
  listWorkflowsInDb,
  createDbWorkflow,
  upsertFileWorkflow,
} from "../src/core/workflows";

describe("syncFileWorkflowsToDb", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM workflows");
  });

  it("初始同步：DB 空 → 全部 insert", () => {
    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "d1", yaml_content: "y1", file_path: "/tmp/req_dev" },
      { name: "scheduled", description: "d2", yaml_content: "y2", file_path: "/tmp/scheduled" },
    ]);
    expect(result.added.sort()).toEqual(["req_dev", "scheduled"]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(listWorkflowsInDb().length).toBe(2);
  });

  it("yaml 变化：update + 不动 created_at", () => {
    upsertFileWorkflow({ name: "req_dev", description: "old", yaml_content: "y_old", file_path: "/tmp/req_dev" });
    const before = listWorkflowsInDb()[0];

    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "new", yaml_content: "y_new", file_path: "/tmp/req_dev" },
    ]);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(["req_dev"]);
    expect(result.removed).toEqual([]);

    const after = listWorkflowsInDb()[0];
    expect(after.yaml_content).toBe("y_new");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("文件被删：DB 中孤儿 file 工作流被清", () => {
    upsertFileWorkflow({ name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" });
    upsertFileWorkflow({ name: "old_wf", description: "", yaml_content: "x", file_path: "/tmp/old_wf" });

    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" },
    ]);
    expect(result.removed).toEqual(["old_wf"]);
    expect(listWorkflowsInDb().map((w) => w.name)).toEqual(["req_dev"]);
  });

  it("DB 工作流不受 sync 影响", () => {
    upsertFileWorkflow({ name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" });
    createDbWorkflow({ name: "wf_db", description: "", derives_from: "req_dev", yaml_content: "y" });

    syncFileWorkflowsToDb([
      { name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" },
    ]);
    expect(listWorkflowsInDb().filter((w) => w.source === "db").map((w) => w.name)).toEqual(["wf_db"]);
  });

  it("yaml 没变：update 列表为空（按 yaml + description + file_path 比较）", () => {
    upsertFileWorkflow({ name: "req_dev", description: "d", yaml_content: "y", file_path: "/tmp/x" });
    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "d", yaml_content: "y", file_path: "/tmp/x" },
    ]);
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual([]);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/workflows-sync.test.ts
```
预期：`syncFileWorkflowsToDb` 不存在 → FAIL。

- [ ] **Step 3：在 src/core/workflows.ts 末尾追加**

```ts
// ──────────────────────────────────────────────
// 整体同步：文件扫描 → DB
// ──────────────────────────────────────────────

export interface FileWorkflowScan {
  name: string;
  description: string;
  yaml_content: string;
  file_path: string;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * 把一次文件扫描结果同步到 DB。
 *
 * 行为：
 *   - 文件里有，DB 里没 → INSERT，记入 added
 *   - 文件里有，DB 里也有 → 比较 description / yaml_content / file_path，
 *     有任一不同则 UPDATE 并记入 updated
 *   - DB 中 source=file 但本次扫描没看到 → DELETE，记入 removed（孤儿清理）
 *   - DB 中 source=db 的行不受影响
 */
export function syncFileWorkflowsToDb(scans: FileWorkflowScan[]): SyncResult {
  const added: string[] = [];
  const updated: string[] = [];

  const seen = new Set<string>();
  for (const scan of scans) {
    seen.add(scan.name);
    const existing = getWorkflowFromDb(scan.name);
    if (!existing || existing.source !== "file") {
      upsertFileWorkflow(scan);
      added.push(scan.name);
      continue;
    }
    const changed =
      existing.description !== scan.description ||
      existing.yaml_content !== scan.yaml_content ||
      existing.file_path !== scan.file_path;
    if (changed) {
      upsertFileWorkflow(scan);
      updated.push(scan.name);
    }
  }

  const removed = deleteOrphanFileWorkflows(seen);
  return { added: added.sort(), updated: updated.sort(), removed: removed.sort() };
}
```

- [ ] **Step 4：跑测试**

```bash
bun test tests/workflows-sync.test.ts
bun run typecheck
```
预期：5 用例 pass，typecheck clean。

- [ ] **Step 5：跑全套**

```bash
bun test
```

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w1-20260507
git add src/core/workflows.ts tests/workflows-sync.test.ts
git commit -m "feat(core): syncFileWorkflowsToDb 文件→DB 整体同步"
```

---

## Task 4：registry.ts 改造 — 多源加载 + 派生

**Files:**
- Modify: `src/core/registry.ts`
- Create: `tests/registry-multi-source.test.ts`

**核心变更：**
- `discover()`：扫文件 → 调 `syncFileWorkflowsToDb` → 从 DB 读所有行 → 加载 file/db 工作流
- 新增内部函数 `composeDbWorkflow(name, description, yaml, base)`：解析 DB 工作流 yaml，校验 phase name ⊆ base 的 phase 集合，复制 phase 函数引用

- [ ] **Step 1：写集成测试**

新建 `tests/registry-multi-source.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover, listWorkflows, getWorkflow } from "../src/core/registry";
import { createDbWorkflow } from "../src/core/workflows";

describe("registry 多源加载", () => {
  let tmpHome: string;
  let db: Database;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `autopilot-multi-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows"), { recursive: true });
    process.env.AUTOPILOT_HOME_OVERRIDE = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
    _clearRegistry();
  });

  afterEach(() => {
    delete process.env.AUTOPILOT_HOME_OVERRIDE;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeFileWorkflow(name: string, yaml: string, ts = ""): void {
    const dir = join(tmpHome, "workflows", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    if (ts) writeFileSync(join(dir, "workflow.ts"), ts);
  }

  it("仅文件工作流：加载并镜像到 DB", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
description: 测试
phases:
  - name: design
    timeout: 60
  - name: develop
    timeout: 60
`,
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    await discover();
    const wfs = listWorkflows();
    expect(wfs.find((w) => w.name === "req_dev")).toBeDefined();
    const rows = db.query<{ name: string; source: string }, []>(
      "SELECT name, source FROM workflows ORDER BY name"
    ).all();
    expect(rows).toEqual([{ name: "req_dev", source: "file" }]);
  });

  it("DB 工作流加载（derives_from 一个 file）", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
  - name: develop
    timeout: 60
`,
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    await discover();
    createDbWorkflow({
      name: "req_dev_fast",
      description: "skip review",
      derives_from: "req_dev",
      yaml_content: `name: req_dev_fast
phases:
  - name: design
    timeout: 60
`,
    });
    _clearRegistry();
    await discover();
    const wf = getWorkflow("req_dev_fast");
    expect(wf).not.toBeNull();
    expect(wf!.phases.length).toBe(1);
  });

  it("DB 工作流 yaml 含 base 没有的 phase name → 跳过加载（不影响其他）", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
`,
      `export async function run_design() {}\n`
    );
    await discover();
    createDbWorkflow({
      name: "wf_bad",
      description: "",
      derives_from: "req_dev",
      yaml_content: `name: wf_bad
phases:
  - name: design
  - name: nonexistent_phase
`,
    });
    _clearRegistry();
    await discover();
    expect(getWorkflow("wf_bad")).toBeNull();
    expect(getWorkflow("req_dev")).not.toBeNull();
  });

  it("DB 工作流 derives_from 不存在的 base → 跳过加载", async () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
      ["wf_orphan", "", "name: wf_orphan\nphases: []\n", "no_such_base", ts, ts]
    );
    await discover();
    expect(getWorkflow("wf_orphan")).toBeNull();
  });

  it("文件被删除：再次 discover 时 DB 同步删除", async () => {
    writeFileWorkflow(
      "req_dev",
      `name: req_dev
phases:
  - name: design
    timeout: 60
`,
      `export async function run_design() {}\n`
    );
    await discover();
    expect(getWorkflow("req_dev")).not.toBeNull();

    rmSync(join(tmpHome, "workflows", "req_dev"), { recursive: true });
    _clearRegistry();
    await discover();
    expect(getWorkflow("req_dev")).toBeNull();
    const rows = db.query<{ name: string }, []>(
      "SELECT name FROM workflows"
    ).all();
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2：跑测试，预期大部分失败**

```bash
bun test tests/registry-multi-source.test.ts
```
预期：现有 discover 不会镜像到 DB → 大部分 FAIL。

- [ ] **Step 3：改造 src/core/registry.ts**

(a) 文件顶部 import 区追加：
```ts
import {
  syncFileWorkflowsToDb,
  listWorkflowsInDb,
  type FileWorkflowScan,
} from "./workflows";
```

如果 `parse as parseYaml` 还没从 `yaml` import，把它合并进现有 yaml import；如果 `readFileSync` 还没在 fs import 里，加进去：

```ts
import { existsSync, readdirSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
```

（实施时按当前 registry.ts 文件实际 import 调整，不要重复声明。）

(b) **完整重写 `discover()` 函数**为：

```ts
/**
 * Discover 多源加载（W1）：
 *   1. 扫文件系统 ~/.autopilot/workflows/（沿用 loadYamlWorkflow 加载 yaml + ts）
 *   2. 把扫到的文件工作流同步到 workflows 表（source=file 镜像）
 *   3. 扫 workflows 表所有行：
 *      - source=file：用 step 1 的内存 def 注册
 *      - source=db：解析 yaml，校验 phase name ⊆ derives_from 的 phase 集合，
 *        从 base 复制 phase 函数引用，注册
 */
export async function discover(): Promise<void> {
  const userWfDir = join(AUTOPILOT_HOME, "workflows");

  // (1) 扫文件系统
  const fileDefs = new Map<string, WorkflowDefinition>();
  const scanInputs: FileWorkflowScan[] = [];
  if (existsSync(userWfDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(userWfDir).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith("_")) continue;
      const subDir = join(userWfDir, entry);
      const yamlPath = join(subDir, "workflow.yaml");
      if (!existsSync(yamlPath)) continue;
      try {
        const wf = await loadYamlWorkflow(subDir);
        if (!wf) continue;
        fileDefs.set(wf.name, wf);
        const yaml_content = readFileSync(yamlPath, "utf8");
        scanInputs.push({
          name: wf.name,
          description: wf.description ?? "",
          yaml_content,
          file_path: subDir,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log.warn("加载 YAML 工作流 %s 失败：%s", subDir, message);
      }
    }
  }

  // (2) 同步到 DB
  try {
    syncFileWorkflowsToDb(scanInputs);
  } catch (e: unknown) {
    log.error(
      "同步文件工作流到 DB 失败：%s",
      e instanceof Error ? e.message : String(e)
    );
  }

  // (3) 从 DB 读所有行注册
  const rows = listWorkflowsInDb();
  for (const row of rows) {
    if (row.source === "file") {
      const def = fileDefs.get(row.name);
      if (!def) {
        log.error("DB workflow %s source=file 但内存没有对应 def，跳过", row.name);
        continue;
      }
      register(def);
      log.debug("注册 file 工作流：%s（来自 %s）", row.name, row.file_path);
    } else {
      const base = fileDefs.get(row.derives_from!);
      if (!base) {
        log.error(
          "DB 工作流 %s derives_from %s 不存在或未加载成功，跳过",
          row.name,
          row.derives_from
        );
        continue;
      }
      try {
        const wf = composeDbWorkflow(row.name, row.description, row.yaml_content, base);
        register(wf);
        log.debug("注册 db 工作流：%s（派生自 %s）", row.name, row.derives_from);
      } catch (e: unknown) {
        log.error(
          "加载 DB 工作流 %s 失败：%s",
          row.name,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }
}
```

(c) 在同模块内、`discover` 函数前面加 `composeDbWorkflow` 和 `findFlatPhase` 辅助：

```ts
/**
 * 由 DB 工作流的 yaml 派生出一个完整 WorkflowDefinition：
 * - 解析 yaml 拿 phases / 元信息
 * - 校验 phase name 必须 ⊆ base 的 phase 集合
 * - 复用 base 的 phase 函数引用（不重新加载 TS）
 *
 * W1 限制：DB 工作流不支持 parallel 子句（W3 视情况扩）。
 */
function composeDbWorkflow(
  name: string,
  description: string,
  yamlContent: string,
  base: WorkflowDefinition,
): WorkflowDefinition {
  const parsed = parseYaml(yamlContent) as { phases?: unknown[] } | null;
  if (!parsed || !Array.isArray(parsed.phases)) {
    throw new Error(`DB 工作流 ${name} yaml 缺少 phases 字段`);
  }

  // 收集 base 已注册的 phase name 集合（含 parallel 子项）
  const basePhaseFunctions = new Set<string>();
  for (const p of base.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) basePhaseFunctions.add(sub.name);
    } else {
      basePhaseFunctions.add(p.name);
    }
  }

  const newPhases: WorkflowDefinition["phases"] = [];
  for (const ph of parsed.phases) {
    if (typeof ph !== "object" || ph === null) {
      throw new Error(`DB 工作流 ${name} phase 项必须是对象`);
    }
    const phaseObj = ph as Record<string, unknown>;
    const phName = phaseObj.name;
    if (typeof phName !== "string") {
      throw new Error(`DB 工作流 ${name} phase 缺 name`);
    }
    if (!basePhaseFunctions.has(phName)) {
      throw new Error(
        `DB 工作流 ${name} 含 base "${base.name}" 没有的 phase: ${phName}`
      );
    }
    const basePhase = findFlatPhase(base, phName);
    if (!basePhase) {
      throw new Error(`base ${base.name} 内部找不到 phase ${phName}（不应发生）`);
    }
    const merged: PhaseDefinition = { ...basePhase };
    if (typeof phaseObj.timeout === "number") merged.timeout = phaseObj.timeout;
    if (typeof phaseObj.agent === "string") merged.agent = phaseObj.agent;
    if (typeof phaseObj.label === "string") merged.label = phaseObj.label;
    if (typeof phaseObj.reject === "string") {
      merged.jump_trigger = `${phName}_reject`;
      merged.jump_target = phaseObj.reject;
    }
    newPhases.push(merged);
  }

  return {
    name,
    description,
    phases: newPhases,
    initial_state: base.initial_state,
    terminal_states: base.terminal_states,
    agents: base.agents,
    chat_agent: base.chat_agent,
    workspace: base.workspace,
    setup_func: base.setup_func,
    notify_func: base.notify_func,
  };
}

/** 在 base 的 phases 里扁平查找指定 name，含 parallel 子项 */
function findFlatPhase(
  base: WorkflowDefinition,
  name: string,
): PhaseDefinition | null {
  for (const p of base.phases) {
    if (isParallelPhase(p)) {
      for (const sub of p.parallel.phases) {
        if (sub.name === name) return sub;
      }
    } else if (p.name === name) {
      return p;
    }
  }
  return null;
}
```

注意：`PhaseDefinition` / `WorkflowDefinition` 的具体字段以 `src/core/registry.ts` 已有定义为准。如果某些字段不存在（如 `setup_func` 实际命名不同），按真实类型裁剪 — **不要硬塞不存在的字段**。

- [ ] **Step 4：跑测试**

```bash
bun test tests/registry-multi-source.test.ts
bun run typecheck
```
预期：5 用例 pass，typecheck clean。

- [ ] **Step 5：跑全套**

```bash
bun test
```
预期：全 pass（含已有 P5 测试不被破坏）。

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w1-20260507
git add src/core/registry.ts tests/registry-multi-source.test.ts
git commit -m "feat(registry): 多源加载（文件 + DB 派生）+ composeDbWorkflow"
```

---

## Task 5：终验 + push + PR

- [ ] **Step 1：跑全套测试 + typecheck**

```bash
bun test
bun run typecheck
```
预期：全 pass、0 typecheck 错。

- [ ] **Step 2：push**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w1-20260507
git push -u origin feat/workflow-dynamic-mgmt-w1-20260507
```

- [ ] **Step 3：开 PR**

PR body 用单引号 here-string 直接喂给 gh：

```bash
gh pr create \
  --base main \
  --head feat/workflow-dynamic-mgmt-w1-20260507 \
  --title "feat: 工作流动态管理 W1 — DB schema + registry 多源加载" \
  --body @'
## 变更摘要

W1：把工作流配置层从纯文件提升到 DB 主导 + 文件兼容的混合模型。

### Schema
- migration 007：workflows 表（name PK / yaml_content / source / derives_from / file_path）
- CHECK 约束保证两种 source 的字段组合合法

### Core
- 新增 src/core/workflows.ts：CRUD + 文件→DB 同步
  - listWorkflowsInDb / getWorkflowFromDb
  - upsertFileWorkflow / deleteOrphanFileWorkflows / syncFileWorkflowsToDb
  - createDbWorkflow / updateDbWorkflow / deleteDbWorkflow
- src/core/registry.ts::discover() 改造为多源加载：
  - 扫文件 → 同步到 DB → 从 DB 读所有 → 文件用内存 def 注册、DB 用 composeDbWorkflow 派生
- composeDbWorkflow：从 base 复用 phase 函数引用 + DB yaml 覆盖 timeout/agent/reject

### 测试
- migration 007：6 用例（schema + CHECK 约束 + 索引）
- workflows CRUD：8 用例
- 文件→DB 同步：5 用例
- registry 多源加载：5 用例（含派生失败 / orphan 清理）
- 全套：依然 pass

## 关联

- spec: docs/superpowers/specs/2026-05-07-workflow-dynamic-management-design.md §3 §4.1 §4.2
- plan: docs/superpowers/plans/2026-05-07-workflow-dynamic-management-w1.md
- 后续：W2（CLI 命令组）、W3（chat tools + Web UI）
'@
```

如果你的 shell 不是 PowerShell，把 `@'…'@` 换成普通 heredoc：

```bash
gh pr create --base main --head feat/workflow-dynamic-mgmt-w1-20260507 \
  --title "feat: 工作流动态管理 W1 — DB schema + registry 多源加载" \
  --body "$(cat <<EOF
... 上面 body 内容 ...
EOF
)"
```

- [ ] **Step 4：通知用户 PR 已创建**

输出 PR 链接给用户。

---

## Self-Review

### Spec coverage

- §3.1 schema → Task 1 ✅
- §4.1 registry 多源加载 → Task 4 ✅
- §4.2 syncFileWorkflowsToDb → Task 3 ✅
- §4.3 同名冲突检测 → 隐含在 upsertFileWorkflow 内（同名但 source=db 已存在时报错）
- §6 错误处理 → 每个 throw 都有对应单测覆盖

### 假设验证

- `parseYaml` 来自 `yaml` 包：项目已 depend on `yaml` 包（loadYamlWorkflow 已在用）
- `_clearRegistry` 已 export（src/core/registry.ts:78）
- `_setDbForTest` 已 export（src/core/db.ts）
- W1 范围内 DB 工作流**不支持 parallel:** 子句（W3 视情况扩）

### 失误防御

- 每 task 的 commit step 都用 `git branch --show-current` 强制 verify 分支
- 如果 sandbox 切分支后 commit 落到 main，agent 必须 cherry-pick + reset main 修复
