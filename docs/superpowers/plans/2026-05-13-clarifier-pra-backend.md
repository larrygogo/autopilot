# Clarifier PR-A（后端基础）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 requirement-clarifier 改造为「spec_md 持续修订 + 一问一答」模式（B 模式），新增 spec_revisions 表 + active_question_id 字段 + clarifier-error CardSource。前端暂不动（PR-B 范围）。

**Architecture:** clarifier 改为每轮 1 次 AI 调用、输出 JSON（new_spec_md / summary / next_question / done）；事件触发器从 `all-questions-resolved` 改为 `question-resolved`（新事件，每个 question 单独 resolve 时 emit）。spec_md 每次变化写一条 spec_revisions 历史。open-question CardSource 改为按 `active_question_id` 出卡（每需求 1 卡）。新增 clarifier-error P0 CardSource 兜底 AI 调用失败。

**Tech Stack:** TypeScript + Bun runtime + bun:sqlite + bun:test。复用 callClaude 机制 + 现有 event-bus + CardSource 抽象，不引入新依赖。

**Spec:** `docs/superpowers/specs/2026-05-13-clarifier-redesign-design.md`（PR-A 范围）。

---

## File Structure

**新建：**

```
src/migrations/012-spec-revisions.ts             — spec_revisions 表
src/migrations/013-active-question-id.ts         — requirements.active_question_id 字段
src/migrations/014-resolve-orphan-open-questions.ts  — 一次性数据清理
src/core/spec-revisions.ts                       — spec_revisions CRUD
src/core/card-sources/clarifier-error.ts         — P0 异常 CardSource
tests/migration-012.test.ts
tests/migration-013.test.ts
tests/migration-014.test.ts
tests/spec-revisions.test.ts
tests/card-sources/clarifier-error.test.ts
tests/clarifier-redesign.test.ts                 — clarifier 重写后的核心行为测试
tests/routes-clarifier.test.ts                   — 新 endpoint 测试
```

**修改：**

```
src/daemon/protocol.ts                           — 加 3 个事件类型 (active-question-changed / spec-revised / clarifier-error / question-resolved)
src/daemon/requirement-clarifier.ts              — 完整重写
src/core/requirements.ts                         — 加 setActiveQuestionId / finishClarification helper
src/core/requirement-questions.ts                — resolveQuestion 改为 emit 新 question-resolved 事件
src/daemon/routes.ts                             — 加 3 个新 endpoint
src/core/card-sources/open-question.ts           — 重写：按 req_id 出卡
src/core/now-aggregator.ts                       — createDefaultAggregator 注册 clarifier-error source
tests/single-writer-invariant.test.ts            — 白名单加 spec-revisions
```

---

## Task 0: 准备实施分支

- [ ] **Step 0.1: 确认在正确分支**

```bash
git branch --show-current
```
Expected: 当前在 `feat/now-aggregator-backend-20260512` 分支（已有 PR1-4 + cleanup 的 base），或主动切到新分支 `feat/clarifier-redesign-pra-20260513`。

- [ ] **Step 0.2: 基线测试通过**

Run: `bun test`
Expected: 431+ pass, 0 fail（前面 work 留下的数）。

---

## Task 1: Migration 012 — spec_revisions 表

**Files:**
- Create: `src/migrations/012-spec-revisions.ts`
- Test: `tests/migration-012.test.ts`

- [ ] **Step 1.1: 写失败测试**

Create `tests/migration-012.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
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

describe("migration 012-spec-revisions", () => {
  it("创建 spec_revisions 表，含全部字段与索引", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012].forEach(fn => fn(db));

    const cols = db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info(spec_revisions)"
    ).all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName["id"]).toBeDefined();
    expect(byName["requirement_id"]).toBeDefined();
    expect(byName["requirement_id"].notnull).toBe(1);
    expect(byName["before_md"]).toBeDefined();
    expect(byName["after_md"]).toBeDefined();
    expect(byName["summary"]).toBeDefined();
    expect(byName["source"]).toBeDefined();
    expect(byName["source"].notnull).toBe(1);
    expect(byName["triggered_by_question_id"]).toBeDefined();
    expect(byName["created_at"]).toBeDefined();

    // 索引
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spec_revisions'"
    ).all().map(r => r.name);
    expect(idx).toContain("idx_spec_revisions_req");
  });

  it("插入与查询往返", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run(
      "INSERT INTO spec_revisions (requirement_id, before_md, after_md, summary, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["r1", "old", "new", "加了 X", "clarifier", 1700000000000],
    );
    const row = db.query<{ id: number; requirement_id: string; before_md: string; after_md: string; source: string }, []>(
      "SELECT id, requirement_id, before_md, after_md, source FROM spec_revisions WHERE requirement_id = 'r1'"
    ).get();
    expect(row?.before_md).toBe("old");
    expect(row?.after_md).toBe("new");
    expect(row?.source).toBe("clarifier");
  });
});
```

- [ ] **Step 1.2: 验证测试失败**

Run: `bun test tests/migration-012.test.ts`
Expected: FAIL — Cannot find module `012-spec-revisions`.

- [ ] **Step 1.3: 实现 migration**

Create `src/migrations/012-spec-revisions.ts`:

```typescript
import type { Database } from "bun:sqlite";

/**
 * 创建 spec_revisions 表：保留 requirement.spec_md 每次修订的 before/after 全文 + 摘要。
 * 用于澄清过程中 AI 持续修订 spec_md 的历史回溯。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS spec_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id TEXT NOT NULL,
      before_md TEXT NOT NULL,
      after_md TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      triggered_by_question_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_spec_revisions_req ON spec_revisions(requirement_id, created_at)");
}
```

- [ ] **Step 1.4: 验证测试通过**

Run: `bun test tests/migration-012.test.ts`
Expected: PASS（2 cases）

- [ ] **Step 1.5: Commit**

```bash
git add src/migrations/012-spec-revisions.ts tests/migration-012.test.ts
git commit -m "feat(core): 加 migration 012 创建 spec_revisions 表"
```

---

## Task 2: Migration 013 — requirements.active_question_id 字段

**Files:**
- Create: `src/migrations/013-active-question-id.ts`
- Test: `tests/migration-013.test.ts`

- [ ] **Step 2.1: 写失败测试**

Create `tests/migration-013.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
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

describe("migration 013-active-question-id", () => {
  it("requirements 表新增 active_question_id 字段，nullable", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));

    const cols = db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info(requirements)"
    ).all();
    const active = cols.find(c => c.name === "active_question_id");
    expect(active).toBeDefined();
    expect(active!.notnull).toBe(0); // nullable
  });

  it("新建 requirement 默认 active_question_id = NULL", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'drafting', '', 0, 0)");
    const r = db.query<{ active_question_id: string | null }, []>("SELECT active_question_id FROM requirements WHERE id = 'r1'").get();
    expect(r?.active_question_id).toBeNull();
  });

  it("可写入指向 question 的 id", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q1', 'r1', '?', '[]', 'open', 0)");
    db.run("UPDATE requirements SET active_question_id = 'q1' WHERE id = 'r1'");
    const r = db.query<{ active_question_id: string | null }, []>("SELECT active_question_id FROM requirements WHERE id = 'r1'").get();
    expect(r?.active_question_id).toBe("q1");
  });
});
```

- [ ] **Step 2.2: 验证测试失败**

Run: `bun test tests/migration-013.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: 实现 migration**

Create `src/migrations/013-active-question-id.ts`:

```typescript
import type { Database } from "bun:sqlite";

/**
 * requirements 表加 active_question_id 字段。
 * - 标识"当前等用户回答的那个 question"。
 * - clarifier 决定下一题时 set；用户答完时清空或指向下一题；进 awaiting_approval 时为 NULL。
 * - /now 的 open-question CardSource 据此每需求出 1 卡。
 *
 * 不在 SQL 层加 FK ON DELETE SET NULL：bun:sqlite 对 ALTER TABLE 添加 FK 列支持有限；
 * 业务层（deleteRequirement / resolveQuestion）维护引用一致性。
 */
export function up(db: Database): void {
  db.run("ALTER TABLE requirements ADD COLUMN active_question_id TEXT DEFAULT NULL");
}
```

- [ ] **Step 2.4: 验证测试通过**

Run: `bun test tests/migration-013.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 2.5: Commit**

```bash
git add src/migrations/013-active-question-id.ts tests/migration-013.test.ts
git commit -m "feat(core): 加 migration 013 requirements 表新增 active_question_id 字段"
```

---

## Task 3: Migration 014 — 一次性清理孤儿 open question

**Files:**
- Create: `src/migrations/014-resolve-orphan-open-questions.ts`
- Test: `tests/migration-014.test.ts`

把 status=clarifying 的需求下的所有 open question 改为 resolved（迁移到新 1-question/req 模型时清除遗留）。

- [ ] **Step 3.1: 写失败测试**

Create `tests/migration-014.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
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

describe("migration 014-resolve-orphan-open-questions", () => {
  it("把 clarifying 需求下的 open question 全标 resolved", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q1', 'r1', '?', '[]', 'open', 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q2', 'r1', '?', '[]', 'open', 0)");

    m014(db);

    const rows = db.query<{ status: string; resolved_at: number | null }, []>(
      "SELECT status, resolved_at FROM requirement_questions WHERE requirement_id = 'r1'"
    ).all();
    expect(rows.every(r => r.status === "resolved")).toBe(true);
    expect(rows.every(r => r.resolved_at !== null)).toBe(true);
  });

  it("不影响非 clarifying 状态需求的 open question", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    // 状态 drafting 不应被清理（虽然 drafting 期通常没有 question；防御写）
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r2', 'p1', 'T', 'drafting', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q3', 'r2', '?', '[]', 'open', 0)");

    m014(db);

    const r = db.query<{ status: string }, []>("SELECT status FROM requirement_questions WHERE id = 'q3'").get();
    expect(r?.status).toBe("open");
  });

  it("不动已 resolved 的 question", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r3', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, resolved_at, created_at) VALUES ('q4', 'r3', '?', '[]', 'resolved', 999, 0)");

    m014(db);

    const r = db.query<{ status: string; resolved_at: number | null }, []>("SELECT status, resolved_at FROM requirement_questions WHERE id = 'q4'").get();
    expect(r?.status).toBe("resolved");
    expect(r?.resolved_at).toBe(999); // 不被覆写
  });
});
```

- [ ] **Step 3.2: 验证测试失败**

Run: `bun test tests/migration-014.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: 实现 migration**

Create `src/migrations/014-resolve-orphan-open-questions.ts`:

```typescript
import type { Database } from "bun:sqlite";

/**
 * 一次性数据清理：把所有 status=clarifying 的 requirement 下的 open question 全标 resolved。
 *
 * 背景：新模型每个需求最多 1 个 active question，但历史数据可能在一个 clarifying 需求下
 * 留有多个 open question（旧 clarifier 一次扔一批的产物）。迁移后用户重新进 RequirementDetail
 * 时，前端检测到 status=clarifying && active_question_id=NULL 会调 retry-clarify 触发新一轮。
 */
export function up(db: Database): void {
  const nowMs = Date.now();
  db.run(
    "UPDATE requirement_questions " +
    "SET status='resolved', resolved_at=? " +
    "WHERE status='open' " +
    "AND requirement_id IN (SELECT id FROM requirements WHERE status='clarifying')",
    [nowMs],
  );
}
```

- [ ] **Step 3.4: 验证测试通过**

Run: `bun test tests/migration-014.test.ts`
Expected: PASS（3 cases）

- [ ] **Step 3.5: Commit**

```bash
git add src/migrations/014-resolve-orphan-open-questions.ts tests/migration-014.test.ts
git commit -m "feat(core): 加 migration 014 一次性清理 clarifying 需求的孤儿 open question"
```

---

## Task 4: protocol.ts 加 4 个新事件类型

**Files:**
- Modify: `src/daemon/protocol.ts`
- Test: `tests/protocol-clarifier-events.test.ts`

新增事件：
- `requirement:active-question-changed`
- `requirement:spec-revised`
- `requirement:clarifier-error`
- `requirement:question-resolved`（新，单 question resolve 时 emit；区别于已有 `all-questions-resolved`）

- [ ] **Step 4.1: 写失败测试**

Create `tests/protocol-clarifier-events.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { getChannelsForEvent, type AutopilotEvent } from "../src/daemon/protocol";

describe("protocol — clarifier 新事件 channel 路由", () => {
  it("requirement:active-question-changed → requirement:*", () => {
    const ev = { type: "requirement:active-question-changed", payload: { id: "r1", question_id: "q1" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:spec-revised → requirement:*", () => {
    const ev = { type: "requirement:spec-revised", payload: { id: "r1", revision_id: 5 } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:clarifier-error → requirement:*", () => {
    const ev = { type: "requirement:clarifier-error", payload: { id: "r1", reason: "JSON parse failed" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:question-resolved → requirement:*", () => {
    const ev = { type: "requirement:question-resolved", payload: { id: "r1", question_id: "q1" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });
});
```

- [ ] **Step 4.2: 验证测试失败**

Run: `bun test tests/protocol-clarifier-events.test.ts`
Expected: FAIL — TS error (事件类型未定义)。

- [ ] **Step 4.3: protocol.ts 加事件类型**

Modify `src/daemon/protocol.ts`：在 `AutopilotEvent` union 中找到现有 `requirement:` 相关事件（`requirement:status-changed` / `questions-updated` / `all-questions-resolved`），在它们之后追加：

```typescript
  | { type: "requirement:status-changed"; payload: { id: string; from: string; to: string } }
  | { type: "requirement:questions-updated"; payload: { id: string } }
  | { type: "requirement:all-questions-resolved"; payload: { id: string } }
  // ── Clarifier 重设计（PR-A）新增事件 ──
  | { type: "requirement:question-resolved"; payload: { id: string; question_id: string } }
  | { type: "requirement:active-question-changed"; payload: { id: string; question_id: string | null } }
  | { type: "requirement:spec-revised"; payload: { id: string; revision_id: number } }
  | { type: "requirement:clarifier-error"; payload: { id: string; reason: string } }
```

> `getChannelsForEvent` 已经按 `case "requirement":` 路由到 `requirement:*` 频道，无需改动 switch。

- [ ] **Step 4.4: 验证测试通过**

Run: `bun test tests/protocol-clarifier-events.test.ts`
Expected: PASS（4 cases）

- [ ] **Step 4.5: Commit**

```bash
git add src/daemon/protocol.ts tests/protocol-clarifier-events.test.ts
git commit -m "feat(daemon): protocol 加 clarifier 重设计的 4 个新事件类型"
```

---

## Task 5: spec_revisions CRUD 模块

**Files:**
- Create: `src/core/spec-revisions.ts`
- Test: `tests/spec-revisions.test.ts`
- Modify: `tests/single-writer-invariant.test.ts`（白名单加新文件）

- [ ] **Step 5.1: 写失败测试**

Create `tests/spec-revisions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
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
import { _setDbForTest } from "../src/core/db";
import { createSpecRevision, listSpecRevisionsByRequirement } from "../src/core/spec-revisions";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
  db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
}

describe("spec-revisions", () => {
  beforeEach(() => initSchema());

  it("createSpecRevision 写入一条记录并返回 id", () => {
    const id = createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "加了 X",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("listSpecRevisionsByRequirement 按 created_at desc 返回", async () => {
    const id1 = createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "r1",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    // 等 1ms 让 created_at 不同
    await new Promise(r => setTimeout(r, 2));
    const id2 = createSpecRevision({
      requirement_id: "r1",
      before_md: "v2",
      after_md: "v3",
      summary: "r2",
      source: "clarifier",
      triggered_by_question_id: null,
    });

    const list = listSpecRevisionsByRequirement("r1");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
    expect(list[0].summary).toBe("r2");
  });

  it("不同 requirement 的 revision 互相隔离", () => {
    createSpecRevision({
      requirement_id: "r1",
      before_md: "a",
      after_md: "b",
      summary: "r1 only",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    expect(listSpecRevisionsByRequirement("non-existent")).toEqual([]);
  });

  it("source 字段接受 user-edit / system / clarifier", () => {
    createSpecRevision({
      requirement_id: "r1",
      before_md: "",
      after_md: "x",
      summary: null,
      source: "user-edit",
      triggered_by_question_id: null,
    });
    const list = listSpecRevisionsByRequirement("r1");
    expect(list[0].source).toBe("user-edit");
  });
});
```

- [ ] **Step 5.2: 验证测试失败**

Run: `bun test tests/spec-revisions.test.ts`
Expected: FAIL — Cannot find module.

- [ ] **Step 5.3: 实现 spec-revisions.ts**

Create `src/core/spec-revisions.ts`:

```typescript
import { getDb } from "./db";

export interface SpecRevision {
  id: number;
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
  created_at: number;
}

export interface CreateSpecRevisionOpts {
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
}

/**
 * 创建一条 spec_revision 记录。返回自增 id。
 */
export function createSpecRevision(opts: CreateSpecRevisionOpts): number {
  const db = getDb();
  const r = db.run(
    "INSERT INTO spec_revisions " +
    "(requirement_id, before_md, after_md, summary, source, triggered_by_question_id, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      opts.requirement_id,
      opts.before_md,
      opts.after_md,
      opts.summary,
      opts.source,
      opts.triggered_by_question_id,
      Date.now(),
    ],
  );
  return Number(r.lastInsertRowid);
}

/**
 * 按 requirement_id 列出修订历史，最新的在前。
 */
export function listSpecRevisionsByRequirement(requirementId: string): SpecRevision[] {
  return getDb()
    .query<SpecRevision, [string]>(
      "SELECT * FROM spec_revisions WHERE requirement_id = ? ORDER BY created_at DESC, id DESC"
    )
    .all(requirementId);
}
```

- [ ] **Step 5.4: 把 spec-revisions.ts 加入 single-writer-invariant 白名单**

Modify `tests/single-writer-invariant.test.ts`：找到 ALLOWED_FILES 数组（或类似名称的白名单），在合适位置加 `"src/core/spec-revisions.ts"`。如果白名单的注释把现有文件按 alphabetical 或功能分组，遵循该约定。

- [ ] **Step 5.5: 验证测试通过**

Run: `bun test tests/spec-revisions.test.ts tests/single-writer-invariant.test.ts`
Expected: PASS（spec-revisions 4 cases + single-writer 1 case 仍 pass）

- [ ] **Step 5.6: Commit**

```bash
git add src/core/spec-revisions.ts tests/spec-revisions.test.ts tests/single-writer-invariant.test.ts
git commit -m "feat(core): 加 spec-revisions CRUD 模块"
```

---

## Task 6: requirements.ts 加 active_question_id / finishClarification helper

**Files:**
- Modify: `src/core/requirements.ts`
- Modify: `src/core/requirement-questions.ts`（resolveQuestion 改为 emit `requirement:question-resolved`）
- Test: `tests/requirements-clarifier.test.ts`

- [ ] **Step 6.1: 写失败测试**

Create `tests/requirements-clarifier.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
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
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setActiveQuestionId,
  finishClarification,
  setRequirementStatus,
} from "../src/core/requirements";
import { createQuestion, getQuestionById } from "../src/core/requirement-questions";
import { enableBus, disableBus, onEvent, offEvent } from "../src/daemon/event-bus";
import type { AutopilotEvent } from "../src/daemon/protocol";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("requirements clarifier helpers", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });

  it("setActiveQuestionId 写入字段 + emit active-question-changed", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });

    const events: AutopilotEvent[] = [];
    const handler = (e: AutopilotEvent) => events.push(e);
    onEvent("requirement:active-question-changed", handler);

    setActiveQuestionId("r1", "q1");

    const r = getRequirementById("r1");
    expect(r?.active_question_id).toBe("q1");
    expect(events).toHaveLength(1);
    if (events[0].type === "requirement:active-question-changed") {
      expect(events[0].payload.question_id).toBe("q1");
    }
    offEvent("requirement:active-question-changed", handler);
    disableBus();
  });

  it("setActiveQuestionId(null) 清空字段", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");
    setActiveQuestionId("r1", null);
    const r = getRequirementById("r1");
    expect(r?.active_question_id).toBeNull();
    disableBus();
  });

  it("finishClarification 把 active question resolve + 设 NULL + 状态 → awaiting_approval", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    finishClarification("r1");

    const r = getRequirementById("r1");
    expect(r?.status).toBe("awaiting_approval");
    expect(r?.active_question_id).toBeNull();
    const q = getQuestionById("q1");
    expect(q?.status).toBe("resolved");
    disableBus();
  });

  it("finishClarification 无 active question 时也能工作（直接进 awaiting_approval）", () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    // 不设 active_question_id
    finishClarification("r1");
    const r = getRequirementById("r1");
    expect(r?.status).toBe("awaiting_approval");
    expect(r?.active_question_id).toBeNull();
    disableBus();
  });
});
```

- [ ] **Step 6.2: 验证测试失败**

Run: `bun test tests/requirements-clarifier.test.ts`
Expected: FAIL — `setActiveQuestionId` / `finishClarification` 未导出。

- [ ] **Step 6.3: 在 requirements.ts 加 helper**

Modify `src/core/requirements.ts`：

首先，找到 `Requirement` interface（约在文件 §1 类型定义），在末尾加字段：

```typescript
export interface Requirement {
  // ... 现有字段
  active_question_id: string | null;
}
```

然后查询 SELECT 改为包含新字段（如果 SELECT 用 `*` 就无需改；如果显式列出，加进去）。

然后在文件末尾追加（或合适位置）：

```typescript
import { resolveQuestion } from "./requirement-questions";

/**
 * 设置 active_question_id 字段，并 emit requirement:active-question-changed 事件。
 * 传入 null 表示清空（没有等回答的问题）。
 */
export function setActiveQuestionId(requirementId: string, questionId: string | null): void {
  const db = getDb();
  db.run(
    "UPDATE requirements SET active_question_id = ?, updated_at = ? WHERE id = ?",
    [questionId, Date.now(), requirementId],
  );
  emit({
    type: "requirement:active-question-changed",
    payload: { id: requirementId, question_id: questionId },
  });
}

/**
 * 用户强制结束澄清（"够了，直接审批"），或 clarifier 决定 done=true 时调用。
 *
 * 流程：
 * 1. 若 active_question_id 非空 → 标 question resolved
 * 2. active_question_id = NULL
 * 3. status = awaiting_approval（走完整的 setRequirementStatus 校验）
 *
 * 整体包 transaction。
 */
export function finishClarification(requirementId: string): void {
  const db = getDb();
  db.transaction(() => {
    const req = getRequirementById(requirementId);
    if (!req) return;
    if (req.active_question_id) {
      // resolveQuestion 内会 emit question-resolved 事件，但我们不希望此处触发 clarifier 新一轮
      // —— clarifier 订阅 question-resolved 时应自己校验 active_question_id 已被清空
      resolveQuestion(req.active_question_id);
    }
    db.run("UPDATE requirements SET active_question_id = NULL, updated_at = ? WHERE id = ?", [Date.now(), requirementId]);
    emit({
      type: "requirement:active-question-changed",
      payload: { id: requirementId, question_id: null },
    });
  })();
  // 状态切换走 setRequirementStatus 保证状态机校验 + emit status-changed
  setRequirementStatus(requirementId, "awaiting_approval");
}
```

> 注：如果 `getRequirementById` 已经存在但 SELECT 没拿 `active_question_id` 字段，需要更新查询。也可能 SELECT 用 `*` 自动包含。检查并调整。

- [ ] **Step 6.4: 改 resolveQuestion emit question-resolved 事件**

Modify `src/core/requirement-questions.ts`：找到 `resolveQuestion` 函数。在它现有的 `db.run UPDATE` 之后加：

```typescript
import { emit } from "../daemon/event-bus";
// ... (顶部 imports)

export function resolveQuestion(id: string): void {
  const db = getDb();
  const row = db
    .query<{ requirement_id: string; status: string }, [string]>(
      "SELECT requirement_id, status FROM requirement_questions WHERE id = ?"
    )
    .get(id);
  if (!row || row.status === "resolved") return;
  db.run(
    "UPDATE requirement_questions SET status = 'resolved', resolved_at = ? WHERE id = ?",
    [Date.now(), id],
  );
  emit({
    type: "requirement:question-resolved",
    payload: { id: row.requirement_id, question_id: id },
  });
}
```

> 注：如果 resolveQuestion 已经有 emit 别的事件（如 questions-updated），保留它们；只是补一个新的 question-resolved。

- [ ] **Step 6.5: 验证测试通过**

Run: `bun test tests/requirements-clarifier.test.ts`
Expected: PASS（4 cases）

也跑全套确认无回归：
```bash
bun test
```
Expected: 全部 pass（数应该是之前 + 4）。

- [ ] **Step 6.6: Commit**

```bash
git add src/core/requirements.ts src/core/requirement-questions.ts tests/requirements-clarifier.test.ts
git commit -m "feat(core): requirements 加 setActiveQuestionId / finishClarification + resolveQuestion emit question-resolved"
```

---

## Task 7: 重写 requirement-clarifier 为 B 模式

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts`（完整重写）
- Test: `tests/clarifier-redesign.test.ts`

这是 PR-A 最大的 task。clarifier 改为：每轮 1 次 AI 调用、JSON 输出、修订 spec_md、错误恢复。

- [ ] **Step 7.1: 写失败测试**

Create `tests/clarifier-redesign.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById, setRequirementStatus } from "../src/core/requirements";
import { listSpecRevisionsByRequirement } from "../src/core/spec-revisions";
import { listQuestionsByRequirement } from "../src/core/requirement-questions";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { runClarifierRound, _setClarifyFnForTest } from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
}

describe("clarifier B 模式 — 单轮逻辑", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });

  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("AI 返回 done=false + next_question → 创建 question + 设 active_question_id + 写 spec_revision", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "改造后的需求\n## 现状\n初稿",
      summary: "结构化为标题 + 章节",
      next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
      done: false,
    }));

    await runClarifierRound("r1");

    const req = getRequirementById("r1");
    expect(req?.spec_md).toContain("改造后的需求");
    expect(req?.active_question_id).toBeTruthy();
    expect(req?.status).toBe("clarifying");

    const revs = listSpecRevisionsByRequirement("r1");
    expect(revs).toHaveLength(1);
    expect(revs[0].source).toBe("clarifier");
    expect(revs[0].summary).toBe("结构化为标题 + 章节");

    const qs = listQuestionsByRequirement("r1");
    const active = qs.find(q => q.id === req?.active_question_id);
    expect(active?.agent_text).toBe("目标用户是谁？");
    expect(active?.suggestions).toEqual(["开发者", "运维"]);
  });

  it("AI 返回 done=true → 进 awaiting_approval + active_question_id=null", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "已经够清楚了" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "已经够清楚了",  // 不变
      summary: null,
      next_question: null,
      done: true,
    }));

    await runClarifierRound("r1");

    const req = getRequirementById("r1");
    expect(req?.status).toBe("awaiting_approval");
    expect(req?.active_question_id).toBeNull();
  });

  it("new_spec_md 与原 spec_md 相同时不写 revision", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "同样的内容" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "同样的内容",
      summary: null,
      next_question: { agent_text: "更多细节？", suggestions: [] },
      done: false,
    }));

    await runClarifierRound("r1");

    expect(listSpecRevisionsByRequirement("r1")).toHaveLength(0);
    const req = getRequirementById("r1");
    expect(req?.active_question_id).toBeTruthy(); // 仍创建新问题
  });

  it("AI 返回非 JSON → 重试 1 次仍失败 → emit clarifier-error + 不动 spec/不创建 question", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "原稿" });
    setRequirementStatus("r1", "clarifying");
    const originalQuestionCount = listQuestionsByRequirement("r1").length;

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return "这不是 JSON，是一段文本";
    });

    // 监听 clarifier-error
    const errors: Array<{ id: string; reason: string }> = [];
    const { onEvent, offEvent } = await import("../src/daemon/event-bus");
    const handler = (e: { type: string; payload: { id: string; reason: string } }) => {
      if (e.type === "requirement:clarifier-error") errors.push(e.payload);
    };
    onEvent("requirement:clarifier-error", handler as never);

    await runClarifierRound("r1");

    expect(calls).toBe(2); // 一次原始 + 一次重试
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe("r1");

    // spec_md 未动 / 无新 question
    const req = getRequirementById("r1");
    expect(req?.spec_md).toBe("原稿");
    expect(req?.active_question_id).toBeNull();
    expect(listQuestionsByRequirement("r1").length).toBe(originalQuestionCount);

    offEvent("requirement:clarifier-error", handler as never);
  });

  it("requirement 不存在或状态非 clarifying → no-op（不抛、不调 AI）", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    // 不切到 clarifying，保持 drafting

    let calls = 0;
    _setClarifyFnForTest(async () => {
      calls++;
      return JSON.stringify({ new_spec_md: "", summary: null, next_question: null, done: true });
    });

    await runClarifierRound("r1");
    expect(calls).toBe(0);

    await runClarifierRound("non-existent-req");
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 7.2: 验证测试失败**

Run: `bun test tests/clarifier-redesign.test.ts`
Expected: FAIL — `runClarifierRound` / `_setClarifyFnForTest` 未导出。

- [ ] **Step 7.3: 重写 requirement-clarifier.ts**

Replace `src/daemon/requirement-clarifier.ts` 全文为：

```typescript
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, updateRequirement, setActiveQuestionId, setRequirementStatus } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getCodebaseById } from "../core/codebases";
import { createQuestion, nextQuestionId, listQuestionsByRequirement } from "../core/requirement-questions";
import { createSpecRevision } from "../core/spec-revisions";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-clarifier");

// ──────────────────────────────────────────────
// AI 调用层（可测试注入）
// ──────────────────────────────────────────────

type ClarifyFn = (prompt: string) => Promise<string>;

/** 默认走真实 claude CLI；测试可通过 _setClarifyFnForTest 注入 mock */
let _clarifyFn: ClarifyFn = callClaude;

export function _setClarifyFnForTest(fn: ClarifyFn | null): void {
  _clarifyFn = fn ?? callClaude;
}

async function callClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "text", "--tools", ""],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const text = stdout.trim();
  if (
    proc.exitCode !== 0 ||
    /^(Failed to|Error:|API Error|401|403|429)/i.test(text) ||
    /Invalid authentication|API key|credit balance/i.test(text)
  ) {
    throw new Error(`claude CLI 异常 (exit=${proc.exitCode}): ${text || stderr.trim() || "no output"}`);
  }
  return text;
}

// ──────────────────────────────────────────────
// Prompt 构造
// ──────────────────────────────────────────────

function readCodebaseContext(codebasePath: string): string {
  const candidates = ["CLAUDE.md", "README.md", "README"];
  const snippets: string[] = [];
  for (const name of candidates) {
    const file = join(codebasePath, name);
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8").slice(0, 4000);
      snippets.push(`### ${name}\n${content}`);
    }
  }
  return snippets.join("\n\n");
}

function buildPrompt(opts: {
  projectName: string;
  projectDescription: string | null;
  codebaseAlias: string | null;
  codebaseContext: string | null;
  title: string;
  specMd: string;
  qaHistory: string;
}): string {
  const ctxLines: string[] = [];
  ctxLines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) ctxLines.push(`项目描述：${opts.projectDescription}`);
  if (opts.codebaseAlias) ctxLines.push(`关联代码库：${opts.codebaseAlias}`);
  if (opts.codebaseContext) {
    ctxLines.push("");
    ctxLines.push("## 代码库文档");
    ctxLines.push(opts.codebaseContext);
  }

  return [
    "你是一位软件需求分析师，正在持续优化一份需求规约（spec_md）并一问一答地澄清需求。",
    "",
    "# 任务",
    "1. 根据当前 spec_md 和已有 Q&A 历史，**精确修订** spec_md：",
    "   - 保留原文中正确的内容（不要重写整篇）",
    "   - 只改不对的、只加缺失的、只删冗余的",
    "   - 不要包裹 ``` 代码块",
    "2. 决定下一个最该问的问题，或宣告澄清完成。",
    "",
    "# 输出格式（严格 JSON，不要任何前后多余文本）",
    '{',
    '  "new_spec_md": "...",        // 修订后的完整 spec_md',
    '  "summary": "...",             // 本轮修订摘要（短，1-2 句），null 表示无变化',
    '  "next_question": {',
    '    "agent_text": "...",        // 下一个问题',
    '    "suggestions": ["A","B"]   // 2-4 个短选项，可空数组',
    '  } | null,                     // null 表示不再追问',
    '  "done": true|false            // true=信息已足够、可入队',
    '}',
    "",
    "# 关键规则",
    "- 如果 spec_md 没变化，new_spec_md 仍要原样输出，但 summary 可为 null。",
    "- 下一个问题必须**基于最新 spec_md 和已有 Q&A**，不要重复问已澄清的事。",
    "- 如果信息已足够实现需求，输出 done=true 且 next_question=null。",
    "- 输出**只有 JSON**，前后没有任何 markdown / 解释 / 代码块。",
    "",
    "# 上下文",
    ctxLines.join("\n"),
    "",
    "# 需求标题",
    opts.title,
    "",
    "# 当前 spec_md",
    opts.specMd || "(空)",
    "",
    opts.qaHistory ? "# 已完成的 Q&A 历史\n\n" + opts.qaHistory : "# 已完成的 Q&A 历史\n\n(暂无)",
    "",
    "请直接输出 JSON：",
  ].join("\n");
}

// ──────────────────────────────────────────────
// 核心：单轮 clarifier
// ──────────────────────────────────────────────

interface ClarifyResult {
  new_spec_md: string;
  summary: string | null;
  next_question: { agent_text: string; suggestions: string[] } | null;
  done: boolean;
}

function parseClarifyResult(raw: string): ClarifyResult {
  // 容错：去 ``` 包裹（虽然 prompt 禁止，但 AI 偶尔仍加）
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.new_spec_md !== "string") throw new Error("missing/invalid new_spec_md");
  if (typeof parsed.done !== "boolean") throw new Error("missing/invalid done");
  const summary = parsed.summary === null || typeof parsed.summary === "string" ? parsed.summary : null;
  const next_question = parsed.next_question === null ? null
    : (parsed.next_question && typeof parsed.next_question === "object"
        ? {
            agent_text: String((parsed.next_question as Record<string, unknown>).agent_text ?? ""),
            suggestions: Array.isArray((parsed.next_question as Record<string, unknown>).suggestions)
              ? (parsed.next_question as Record<string, unknown[]>).suggestions.map(String)
              : [],
          }
        : null);
  if (!parsed.done && (!next_question || !next_question.agent_text)) {
    throw new Error("done=false but next_question is empty");
  }
  return {
    new_spec_md: parsed.new_spec_md as string,
    summary,
    next_question,
    done: parsed.done,
  };
}

/**
 * 跑一轮 clarifier：
 * 1. 构建 prompt（含项目上下文 / 当前 spec_md / Q&A 历史）
 * 2. 调用 AI，输出 JSON
 * 3. JSON 解析失败 → 重试 1 次；仍失败 → emit clarifier-error，不动任何 state
 * 4. 修订 spec_md（若变化）→ 写 spec_revision
 * 5. done=true → finishClarification（status=awaiting_approval, active=null）
 * 6. done=false → createQuestion + setActiveQuestionId
 */
export async function runClarifierRound(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) {
    log.warn("clarifier: req=%s 找不到项目，跳过", reqId);
    return;
  }
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  // QA 历史（已 resolved 的 question + user reply）
  const allQuestions = listQuestionsByRequirement(reqId);
  const qaHistory = allQuestions
    .filter(q => q.status === "resolved")
    .map((q, i) => {
      const userReply = (q.replies ?? []).find(r => r.author_role === "user")?.text ?? "(未回复)";
      return `Q${i + 1}：${q.agent_text}\nA${i + 1}：${userReply}`;
    }).join("\n\n");

  const prompt = buildPrompt({
    projectName: project.name,
    projectDescription: project.description,
    codebaseAlias: codebase?.alias ?? null,
    codebaseContext: codebase?.path ? readCodebaseContext(codebase.path) : null,
    title: req.title,
    specMd: req.spec_md ?? "",
    qaHistory,
  });

  // 调用 + 重试
  let result: ClarifyResult | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await _clarifyFn(prompt);
      result = parseClarifyResult(raw);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn("clarifier: req=%s 第 %d 次解析失败: %s", reqId, attempt + 1, lastError.message);
    }
  }

  if (!result) {
    emit({
      type: "requirement:clarifier-error",
      payload: { id: reqId, reason: lastError?.message ?? "unknown error" },
    });
    return;
  }

  // 1. 修订 spec_md（如有变化）
  const oldSpec = req.spec_md ?? "";
  if (result.new_spec_md !== oldSpec) {
    const revId = createSpecRevision({
      requirement_id: reqId,
      before_md: oldSpec,
      after_md: result.new_spec_md,
      summary: result.summary,
      source: "clarifier",
      triggered_by_question_id: req.active_question_id ?? null,
    });
    updateRequirement(reqId, { spec_md: result.new_spec_md });
    emit({ type: "requirement:spec-revised", payload: { id: reqId, revision_id: revId } });
  }

  // 2. done=true → 进 awaiting_approval
  if (result.done) {
    setActiveQuestionId(reqId, null);
    setRequirementStatus(reqId, "awaiting_approval");
    log.info("clarifier: req=%s 澄清完成，进入 awaiting_approval", reqId);
    return;
  }

  // 3. done=false → 创建下一个问题 + 设 active
  if (!result.next_question) {
    log.warn("clarifier: req=%s done=false 但 next_question 为空，跳过", reqId);
    return;
  }
  const qId = nextQuestionId();
  createQuestion({
    id: qId,
    requirement_id: reqId,
    agent_text: result.next_question.agent_text,
    suggestions: result.next_question.suggestions,
  });
  setActiveQuestionId(reqId, qId);
  emit({ type: "requirement:questions-updated", payload: { id: reqId } });
  log.info("clarifier: req=%s 提出下一个问题 qid=%s", reqId, qId);
}

// ──────────────────────────────────────────────
// 事件订阅
// ──────────────────────────────────────────────

let _statusHandler: ((event: AutopilotEvent) => void) | null = null;
let _resolvedHandler: ((event: AutopilotEvent) => void) | null = null;

export function initRequirementClarifier(): void {
  if (_statusHandler) return;

  _statusHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "clarifying") return;
    runClarifierRound(id).catch((e: unknown) => {
      log.error("clarifier: status-changed handler 失败 req=%s: %s", id, (e as Error).message);
    });
  };

  _resolvedHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:question-resolved") return;
    const { id } = event.payload;
    const req = getRequirementById(id);
    // 仅当：requirement 仍在 clarifying，且 active_question_id 已被清空（即被 resolved 的就是当前 active）
    // 才触发下一轮。finishClarification 调用 resolveQuestion 但同时把 status 切走 / active 清空，
    // 此时不应再触发新一轮（status 校验会兜底）。
    if (!req || req.status !== "clarifying") return;
    runClarifierRound(id).catch((e: unknown) => {
      log.error("clarifier: question-resolved handler 失败 req=%s: %s", id, (e as Error).message);
    });
  };

  onEvent("requirement:status-changed", _statusHandler);
  onEvent("requirement:question-resolved", _resolvedHandler);
  log.info("requirement-clarifier 已启动（B 模式）");
}

export function disposeRequirementClarifier(): void {
  if (_statusHandler) {
    offEvent("requirement:status-changed", _statusHandler);
    _statusHandler = null;
  }
  if (_resolvedHandler) {
    offEvent("requirement:question-resolved", _resolvedHandler);
    _resolvedHandler = null;
  }
}
```

- [ ] **Step 7.4: 验证测试通过**

Run: `bun test tests/clarifier-redesign.test.ts`
Expected: PASS（5 cases）

Run: `bun test`
Expected: 全套 pass，无回归。

- [ ] **Step 7.5: Commit**

```bash
git add src/daemon/requirement-clarifier.ts tests/clarifier-redesign.test.ts
git commit -m "feat(daemon): clarifier 重写为 B 模式（JSON 输出 + 一问一答 + 修订 spec_md）"
```

---

## Task 8: 新增 daemon routes（finish-clarification / retry-clarify / spec-revisions）

**Files:**
- Modify: `src/daemon/routes.ts`
- Test: `tests/routes-clarifier.test.ts`

- [ ] **Step 8.1: 写失败测试**

Create `tests/routes-clarifier.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus, getRequirementById, setActiveQuestionId } from "../src/core/requirements";
import { createQuestion } from "../src/core/requirement-questions";
import { createSpecRevision } from "../src/core/spec-revisions";
import { handleRequest } from "../src/daemon/routes";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { _setClarifyFnForTest } from "../src/daemon/requirement-clarifier";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("clarifier routes", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });
  afterEach(() => {
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("POST /api/requirements/:id/finish-clarification → awaiting_approval + active=null", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    const req = new Request("http://localhost/api/requirements/r1/finish-clarification", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { requirement: { status: string; active_question_id: string | null } };
    expect(body.requirement.status).toBe("awaiting_approval");
    expect(body.requirement.active_question_id).toBeNull();
  });

  it("POST /api/requirements/:id/retry-clarify → 触发 runClarifierRound", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");

    let invoked = false;
    _setClarifyFnForTest(async () => {
      invoked = true;
      return JSON.stringify({ new_spec_md: "重写后", summary: "重做", next_question: { agent_text: "新问题?", suggestions: [] }, done: false });
    });

    const req = new Request("http://localhost/api/requirements/r1/retry-clarify", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(invoked).toBe(true);

    const r = getRequirementById("r1");
    expect(r?.spec_md).toBe("重写后");
    expect(r?.active_question_id).toBeTruthy();
  });

  it("GET /api/requirements/:id/spec-revisions → 历史列表", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "v3" });
    createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "首次修订",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    await new Promise(r => setTimeout(r, 2));
    createSpecRevision({
      requirement_id: "r1",
      before_md: "v2",
      after_md: "v3",
      summary: "二次修订",
      source: "clarifier",
      triggered_by_question_id: null,
    });

    const req = new Request("http://localhost/api/requirements/r1/spec-revisions", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { revisions: Array<{ id: number; summary: string | null; after_md: string }> };
    expect(body.revisions).toHaveLength(2);
    // desc 排序
    expect(body.revisions[0].summary).toBe("二次修订");
    expect(body.revisions[1].summary).toBe("首次修订");
  });

  it("POST /api/requirements/:id/finish-clarification 不存在的 req → 404", async () => {
    const req = new Request("http://localhost/api/requirements/non-existent/finish-clarification", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 8.2: 验证测试失败**

Run: `bun test tests/routes-clarifier.test.ts`
Expected: FAIL — 路由不存在（返回 404 / generic）。

- [ ] **Step 8.3: 在 routes.ts 加 3 个新路由**

Modify `src/daemon/routes.ts`：在 `handleRequest` 函数体内、`/api/requirements` 现有路由块附近添加。先 import 顶部：

```typescript
import { finishClarification } from "../core/requirements";
import { listSpecRevisionsByRequirement } from "../core/spec-revisions";
import { runClarifierRound } from "./requirement-clarifier";
```

然后在 handleRequest 中找到 `/api/requirements/...` 路由分支，紧贴现有 transition / enqueue / cancel 之后追加（保持风格一致；典型模式：正则匹配 `/^\/api\/requirements\/([\w.\-]+)\/<action>$/` + method 检查）：

```typescript
    // POST /api/requirements/:id/finish-clarification
    const finishMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/finish-clarification$/);
    if (method === "POST" && finishMatch) {
      const id = decodeURIComponent(finishMatch[1]);
      const req = getRequirementById(id);
      if (!req) return error("requirement not found", 404);
      finishClarification(id);
      const updated = getRequirementById(id);
      return json({ requirement: withRepoIdAlias(updated) });
    }

    // POST /api/requirements/:id/retry-clarify
    const retryMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/retry-clarify$/);
    if (method === "POST" && retryMatch) {
      const id = decodeURIComponent(retryMatch[1]);
      const req = getRequirementById(id);
      if (!req) return error("requirement not found", 404);
      // 不 await 也可（让它后台跑）；为了测试可观察先 await
      await runClarifierRound(id);
      return json({ ok: true });
    }

    // GET /api/requirements/:id/spec-revisions
    const revsMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/spec-revisions$/);
    if (method === "GET" && revsMatch) {
      const id = decodeURIComponent(revsMatch[1]);
      const req = getRequirementById(id);
      if (!req) return error("requirement not found", 404);
      return json({ revisions: listSpecRevisionsByRequirement(id) });
    }
```

> `withRepoIdAlias` 是 routes.ts 顶部已有的 helper（兼容旧字段名）。`error()` / `json()` 是 handleRequest 局部 helper。`getRequirementById` 已在 routes.ts 顶部 import；如未 import 则加上。

- [ ] **Step 8.4: 验证测试通过**

Run: `bun test tests/routes-clarifier.test.ts`
Expected: PASS（4 cases）

Run: `bun test`
Expected: 全套 pass。

- [ ] **Step 8.5: Commit**

```bash
git add src/daemon/routes.ts tests/routes-clarifier.test.ts
git commit -m "feat(daemon): 加 finish-clarification / retry-clarify / spec-revisions endpoint"
```

---

## Task 9: open-question CardSource 重写（按 req_id 出卡）

**Files:**
- Modify: `src/core/card-sources/open-question.ts`（完整重写）
- Modify: `tests/card-sources/open-question.test.ts`（更新断言）

- [ ] **Step 9.1: 更新测试**

Replace `tests/card-sources/open-question.test.ts` 全文（旧测试假设按 q_id 出卡，现在改为按 req_id）：

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { up as m012 } from "../../src/migrations/012-spec-revisions";
import { up as m013 } from "../../src/migrations/013-active-question-id";
import { up as m014 } from "../../src/migrations/014-resolve-orphan-open-questions";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createRequirement, setRequirementStatus, setActiveQuestionId } from "../../src/core/requirements";
import { createQuestion } from "../../src/core/requirement-questions";
import { createOpenQuestionSource } from "../../src/core/card-sources/open-question";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "P" });
}

describe("CardSource: open-question (按 req_id 出卡)", () => {
  beforeEach(() => initSchema());

  it("name='open-question'，订阅 active-question-changed / status-changed", () => {
    const src = createOpenQuestionSource();
    expect(src.name).toBe("open-question");
    expect(src.subscribes).toContain("requirement:active-question-changed");
    expect(src.subscribes).toContain("requirement:status-changed");
  });

  it("scan 只返回 status=clarifying && active_question_id 非空的 req，每 req 1 卡", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "需求一", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "目标用户是谁？" });
    setActiveQuestionId("r1", "q1");

    // 另一个需求但状态不是 clarifying
    createRequirement({ id: "r2", project_id: "p1", title: "需求二", spec_md: "" });
    createQuestion({ id: "q2", requirement_id: "r2", agent_text: "x?" });
    // 不切到 clarifying

    // 第三个 clarifying 但没 active
    createRequirement({ id: "r3", project_id: "p1", title: "需求三", spec_md: "" });
    setRequirementStatus("r3", "clarifying");

    const cards = await createOpenQuestionSource().scan();
    expect(cards.map(c => c.id)).toEqual(["open-question:r1"]);
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].category).toBe("decision");
    expect(cards[0].subtitle).toContain("目标用户是谁");
    expect(cards[0].related).toEqual({ type: "requirement", id: "r1" });
    expect(cards[0].actions.find(a => a.kind === "primary")?.href).toBe("/requirements/r1");
  });

  it("onEvent: active-question-changed 到非 null → add", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
    setRequirementStatus("r1", "clarifying");
    createQuestion({ id: "q1", requirement_id: "r1", agent_text: "?" });
    setActiveQuestionId("r1", "q1");

    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:active-question-changed",
      payload: { id: "r1", question_id: "q1" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
    if (deltas[0].op === "add") expect(deltas[0].card.id).toBe("open-question:r1");
  });

  it("onEvent: active-question-changed 到 null → remove", async () => {
    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:active-question-changed",
      payload: { id: "r1", question_id: null },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("open-question:r1");
  });

  it("onEvent: status-changed 离开 clarifying → remove", async () => {
    const src = createOpenQuestionSource();
    const deltas = await src.onEvent({
      type: "requirement:status-changed",
      payload: { id: "r1", from: "clarifying", to: "awaiting_approval" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
```

- [ ] **Step 9.2: 验证测试失败**

Run: `bun test tests/card-sources/open-question.test.ts`
Expected: FAIL（旧实现不订阅 active-question-changed / 不按 req_id 出卡）。

- [ ] **Step 9.3: 重写 open-question.ts**

Replace `src/core/card-sources/open-question.ts` 全文：

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";
import { getDb } from "../db";

interface ActiveQuestionRow {
  req_id: string;
  req_title: string;
  q_id: string;
  agent_text: string;
  created_at: number;
}

function listActiveQuestions(): ActiveQuestionRow[] {
  return getDb().query<ActiveQuestionRow, []>(`
    SELECT r.id AS req_id, r.title AS req_title,
           q.id AS q_id, q.agent_text, q.created_at
    FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE q.status = 'open' AND r.status = 'clarifying'
  `).all();
}

function listActiveQuestionForReq(reqId: string): ActiveQuestionRow | null {
  const row = getDb().query<ActiveQuestionRow, [string]>(`
    SELECT r.id AS req_id, r.title AS req_title,
           q.id AS q_id, q.agent_text, q.created_at
    FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE r.id = ? AND q.status = 'open' AND r.status = 'clarifying'
  `).get(reqId);
  return row ?? null;
}

function buildCard(row: ActiveQuestionRow): NowCard {
  const preview = row.agent_text.length > 100
    ? row.agent_text.slice(0, 100) + "…"
    : row.agent_text;
  return {
    id: `open-question:${row.req_id}`,
    priority: "P1",
    category: "decision",
    title: "AI 提了个问题",
    subtitle: `Req ${row.req_id}「${row.req_title}」· ${preview}`,
    related: { type: "requirement", id: row.req_id },
    actions: [
      { label: "回答", kind: "primary", href: `/requirements/${row.req_id}` },
    ],
    dismissable: false,
    created_at: Math.floor(row.created_at / 1000),
  };
}

export function createOpenQuestionSource(): CardSource {
  return {
    name: "open-question",
    subscribes: [
      "requirement:active-question-changed",
      "requirement:status-changed",
    ],

    async scan() {
      return listActiveQuestions().map(buildCard);
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type === "requirement:active-question-changed") {
        const { id: reqId, question_id } = event.payload;
        if (question_id === null) {
          return [{ op: "remove", id: `open-question:${reqId}`, reason: "resolved" }];
        }
        // 有 active question：查 DB 拿最新内容（status 也要是 clarifying）
        const row = listActiveQuestionForReq(reqId);
        if (!row) return [];
        return [{ op: "add", card: buildCard(row) }];
      }

      if (event.type === "requirement:status-changed") {
        const { id: reqId, to } = event.payload;
        // 离开 clarifying → 移除该 req 的卡
        if (to !== "clarifying") {
          return [{ op: "remove", id: `open-question:${reqId}`, reason: "resolved" }];
        }
        return [];
      }

      return [];
    },
  };
}
```

- [ ] **Step 9.4: 验证测试通过**

Run: `bun test tests/card-sources/open-question.test.ts`
Expected: PASS（5 cases）

Run: `bun test`
Expected: 全套 pass。

- [ ] **Step 9.5: Commit**

```bash
git add src/core/card-sources/open-question.ts tests/card-sources/open-question.test.ts
git commit -m "feat(card-sources): open-question 重写——按 req_id 出卡（1 需求 1 卡）"
```

---

## Task 10: 新增 clarifier-error CardSource

**Files:**
- Create: `src/core/card-sources/clarifier-error.ts`
- Modify: `src/core/now-aggregator.ts`（createDefaultAggregator 注册）
- Test: `tests/card-sources/clarifier-error.test.ts`

- [ ] **Step 10.1: 写失败测试**

Create `tests/card-sources/clarifier-error.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createClarifierErrorSource } from "../../src/core/card-sources/clarifier-error";

describe("CardSource: clarifier-error", () => {
  it("name='clarifier-error'，订阅 requirement:clarifier-error", () => {
    const src = createClarifierErrorSource();
    expect(src.name).toBe("clarifier-error");
    expect(src.subscribes).toEqual(["requirement:clarifier-error"]);
  });

  it("scan 返回空（瞬时通知，不持久化）", async () => {
    expect(await createClarifierErrorSource().scan()).toEqual([]);
  });

  it("onEvent: clarifier-error → P0 add 卡，dismissable=false", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:clarifier-error",
      payload: { id: "r1", reason: "JSON parse failed" },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("clarifier-error:r1");
      expect(deltas[0].card.priority).toBe("P0");
      expect(deltas[0].card.category).toBe("error");
      expect(deltas[0].card.dismissable).toBe(false);
      expect(deltas[0].card.subtitle).toContain("JSON parse failed");
      // 包含 [查看] href 和 [重试] invoke
      const hasHref = deltas[0].card.actions.some(a => a.href === "/requirements/r1");
      const hasInvoke = deltas[0].card.actions.some(a =>
        a.invoke?.method === "POST" && a.invoke?.path === "/api/requirements/r1/retry-clarify",
      );
      expect(hasHref).toBe(true);
      expect(hasInvoke).toBe(true);
    }
  });
});
```

- [ ] **Step 10.2: 验证测试失败**

Run: `bun test tests/card-sources/clarifier-error.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 10.3: 实现 clarifier-error source**

Create `src/core/card-sources/clarifier-error.ts`:

```typescript
import type { CardSource, CardDelta, NowCard } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";

function buildCard(reqId: string, reason: string): NowCard {
  const preview = reason.length > 80 ? reason.slice(0, 80) + "…" : reason;
  return {
    id: `clarifier-error:${reqId}`,
    priority: "P0",
    category: "error",
    title: `⚠ Req ${reqId} 澄清出错`,
    subtitle: preview,
    related: { type: "requirement", id: reqId },
    actions: [
      { label: "查看", kind: "primary", href: `/requirements/${reqId}` },
      { label: "重试", kind: "secondary", invoke: {
        method: "POST",
        path: `/api/requirements/${reqId}/retry-clarify`,
      } },
    ],
    dismissable: false,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function createClarifierErrorSource(): CardSource {
  return {
    name: "clarifier-error",
    subscribes: ["requirement:clarifier-error"],

    async scan() {
      // 瞬时通知，不从 DB 重建历史
      return [];
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "requirement:clarifier-error") return [];
      const { id, reason } = event.payload;
      return [{ op: "add", card: buildCard(id, reason) }];
    },
  };
}
```

- [ ] **Step 10.4: 注册到 createDefaultAggregator**

Modify `src/core/now-aggregator.ts`：在 `createDefaultAggregator()` 工厂函数中找到 sources 数组，加 import + 添加：

顶部 import 区追加：
```typescript
import { createClarifierErrorSource } from "./card-sources/clarifier-error";
```

`createDefaultAggregator()` 内 sources 数组追加（放在其他 P0 source 附近，如 task-failed 之后、provider-error 之后均可）：
```typescript
    [
      createTaskFailedSource(),       // P0
      createProviderErrorSource(),    // P0 stub
      createClarifierErrorSource(),   // P0
      createAwaitingApprovalSource(), // P1
      // ... 其余保持不变
    ]
```

- [ ] **Step 10.5: 验证测试通过**

Run: `bun test tests/card-sources/clarifier-error.test.ts tests/now-aggregator.test.ts`
Expected: PASS。

Run: `bun test`
Expected: 全套 pass。

- [ ] **Step 10.6: Commit**

```bash
git add src/core/card-sources/clarifier-error.ts src/core/now-aggregator.ts tests/card-sources/clarifier-error.test.ts
git commit -m "feat(card-sources): clarifier-error（P0 异常：clarifier AI 调用失败兜底）"
```

---

## Task 11: e2e smoke — clarifier 完整链路

**Files:**
- Create: `tests/clarifier-e2e.test.ts`

通过 handleRequest 主入口 + 真实 aggregator 跑一遍 clarifier 流程，验证 spec_md 修订 + active_question_id 流转 + /now 卡片切换。

- [ ] **Step 11.1: 写测试**

Create `tests/clarifier-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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
import { _setDbForTest, getDb } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, setRequirementStatus, getRequirementById } from "../src/core/requirements";
import { listQuestionsByRequirement } from "../src/core/requirement-questions";
import { handleRequest } from "../src/daemon/routes";
import { enableBus, disableBus } from "../src/daemon/event-bus";
import { createDefaultAggregator, type Aggregator } from "../src/core/now-aggregator";
import { setNowAggregator } from "../src/daemon/routes-now";
import { _setClarifyFnForTest, initRequirementClarifier, disposeRequirementClarifier } from "../src/daemon/requirement-clarifier";

describe("clarifier e2e — 完整链路", () => {
  let agg: Aggregator;

  beforeAll(async () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014].forEach(fn => fn(db));
    _setDbForTest(db);
    createProject({ id: "p1", name: "测试项目" });
    enableBus();
    initRequirementClarifier();
    agg = createDefaultAggregator();
    await agg.start();
    setNowAggregator(agg);
  });

  afterAll(() => {
    agg.dispose();
    setNowAggregator(null);
    disposeRequirementClarifier();
    _setClarifyFnForTest(null);
    disableBus();
  });

  it("US-1: 创建需求 → 进 clarifying → AI 提一个问题 → /now 出 1 卡", async () => {
    createRequirement({ id: "e2e-1", project_id: "p1", title: "测试需求", spec_md: "" });

    // 模拟 AI 返回
    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "# 测试需求\n## 目标\n(待确定)",
      summary: "建立框架",
      next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
      done: false,
    }));

    setRequirementStatus("e2e-1", "clarifying"); // 触发 status-changed → clarifier 跑一轮
    // 等事件 + AI 异步完成
    await new Promise(r => setTimeout(r, 100));

    const req = getRequirementById("e2e-1");
    expect(req?.spec_md).toContain("目标");
    expect(req?.active_question_id).toBeTruthy();

    // /now 应有 1 张 open-question 卡
    const cards = agg.getCards();
    const card = cards.find(c => c.id === "open-question:e2e-1");
    expect(card).toBeDefined();
    expect(card?.subtitle).toContain("目标用户是谁");
  });

  it("US-1 续：回答问题 → AI 跑下一轮 → spec_md 变 + 新问题", async () => {
    const req = getRequirementById("e2e-1");
    const activeQid = req?.active_question_id;
    expect(activeQid).toBeTruthy();

    // 模拟下一轮 AI 输出
    _setClarifyFnForTest(async () => JSON.stringify({
      new_spec_md: "# 测试需求\n## 目标\n面向开发者\n## 范围\n(待定)",
      summary: "明确了目标用户",
      next_question: { agent_text: "范围有多大？", suggestions: [] },
      done: false,
    }));

    // 通过 routes 路径走完整 reply + resolve
    const reply = new Request(`http://localhost/api/requirements/e2e-1/questions/${activeQid}/replies`, {
      method: "POST",
      body: JSON.stringify({ author_role: "user", text: "开发者" }),
      headers: { "Content-Type": "application/json" },
    });
    const replyRes = await handleRequest(reply);
    expect(replyRes.status).toBe(200);

    const resolve = new Request(`http://localhost/api/requirements/e2e-1/questions/${activeQid}/resolve`, { method: "POST" });
    const resolveRes = await handleRequest(resolve);
    expect(resolveRes.status).toBe(200);

    // 等 clarifier 跑下一轮
    await new Promise(r => setTimeout(r, 100));

    const req2 = getRequirementById("e2e-1");
    expect(req2?.spec_md).toContain("开发者");
    expect(req2?.active_question_id).toBeTruthy();
    expect(req2?.active_question_id).not.toBe(activeQid); // 新问题
  });

  it("US-4: finish-clarification → 进 awaiting_approval + /now 卡片移除", async () => {
    const fin = new Request("http://localhost/api/requirements/e2e-1/finish-clarification", { method: "POST" });
    const finRes = await handleRequest(fin);
    expect(finRes.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    const req = getRequirementById("e2e-1");
    expect(req?.status).toBe("awaiting_approval");
    expect(req?.active_question_id).toBeNull();

    const cards = agg.getCards();
    expect(cards.find(c => c.id === "open-question:e2e-1")).toBeUndefined();
  });

  it("GET /api/requirements/:id/spec-revisions 看修订历史", async () => {
    const res = await handleRequest(new Request("http://localhost/api/requirements/e2e-1/spec-revisions"));
    expect(res.status).toBe(200);
    const body = await res.json() as { revisions: Array<{ summary: string | null }> };
    expect(body.revisions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 11.2: 验证测试通过**

Run: `bun test tests/clarifier-e2e.test.ts`
Expected: PASS（4 cases）

Run: `bun test`
Expected: 全套 pass，无回归。

Run: `bun run typecheck`
Expected: clean。

- [ ] **Step 11.3: Commit**

```bash
git add tests/clarifier-e2e.test.ts
git commit -m "test: clarifier 重设计 e2e smoke（spec_md 修订 + active 流转 + /now 卡片）"
```

---

## 收尾

- [ ] PR-A 完整测试套件最终验证

```bash
bun test
bun run typecheck
```
Expected: 全部 pass、clean。

- [ ] **PR 描述模板**

```markdown
## 改了什么

实现 `docs/superpowers/specs/2026-05-13-clarifier-redesign-design.md` 的 PR-A 范围：

- Migrations 012-014：spec_revisions 表 + active_question_id 字段 + 一次性清理孤儿
- protocol.ts：4 个新事件（active-question-changed / spec-revised / clarifier-error / question-resolved）
- spec-revisions CRUD 模块
- requirements.ts：setActiveQuestionId / finishClarification helper
- requirement-questions.resolveQuestion: emit 新 question-resolved 事件
- requirement-clarifier 完整重写：B 模式（每轮 1 AI 调用 + JSON 输出 + spec_md 修订 + 错误恢复）
- 3 个新 daemon route：finish-clarification / retry-clarify / spec-revisions GET
- open-question CardSource 重写：按 req_id 出卡（1 需求 1 卡）
- 新 CardSource: clarifier-error（P0 异常兜底）

## 验证

- bun test：全部 pass（含 ~30 个新 case）
- bun run typecheck：clean
- e2e smoke 跑通 4 条用户故事：创建→澄清→一问一答→spec_md 演进→finish

## 后续

- PR-B：前端 RequirementDetail 改造（双区布局 + 修订历史 Sheet + 强制结束按钮）
```

---

## Self-Review

逐条对照 spec § 2 / § 3 / § 4.1 / § 4.2 / § 6（PR-A 范围）核对：

- ✅ §2.1 spec_revisions 表（Task 1）
- ✅ §2.2 active_question_id 字段（Task 2）
- ✅ §2.3 现有数据迁移（Task 3）
- ✅ §3.1 触发时机（Task 7 init + Task 8 retry-clarify）
- ✅ §3.2 单轮 clarifier 算法（Task 7）
- ✅ §3.3 强制结束（Task 6 finishClarification + Task 8 route）
- ✅ §3.4 错误恢复（Task 7 重试 + emit clarifier-error）
- ✅ §3.5 4 个新事件（Task 4 + Task 6）
- ✅ §4.1 open-question CardSource 改造（Task 9）
- ✅ §4.2 clarifier-error CardSource（Task 10）

类型一致性：
- `CreateSpecRevisionOpts` 字段在 Task 5 定义，Task 7 内调用一致
- `setActiveQuestionId(reqId, qId | null)` 签名在 Task 6 定义，Task 7 / 8 调用一致
- `finishClarification(reqId)` 签名在 Task 6 定义，Task 8 调用一致
- `runClarifierRound(reqId)` 签名在 Task 7 定义，Task 8 route 调用一致
- `_setClarifyFnForTest` 测试 helper 在 Task 7 导出，Task 8/11 使用一致

事件名前后一致：
- `requirement:active-question-changed`、`spec-revised`、`clarifier-error`、`question-resolved` 在 Task 4 定义，Task 6/7/9/10 引用一致

API path 一致：
- `/api/requirements/:id/finish-clarification`、`/retry-clarify`、`/spec-revisions` 在 Task 8 定义，Task 10 clarifier-error CardSource 的 invoke path 一致

无 placeholder / TBD / TODO。
