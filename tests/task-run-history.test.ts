/**
 * 需求中心架构 v2 R2：run 多历史。
 *  - 迁移 044：tasks 加 kind/seq + 按需求分组回填 seq
 *  - getTaskRoot 双根解析（legacy 存量只读 / 新任务落 runs/）+ bindTaskRunRoot 种子
 *  - listManifestTaskIds 双根遍历（rebuild-index 找得回新根 manifest）
 *  - scanTaskSandboxes / applyRetentionPolicy 双根扫描
 *
 * startNewRunForRequirement 序列 / 活跃 run 守卫的端到端覆盖在
 * tests/task-sandbox-shared.test.ts（需要真 git clone 环境）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate044 } from "../src/migrations/044-task-run-columns";
import { _setDbForTest } from "../src/core/db";
import * as sandbox from "../src/core/sandbox";
import * as retention from "../src/core/sandbox-retention";
import * as manifestModule from "../src/core/manifest";

// ──────────────────────────────────────────────
// 迁移 044：回填 seq
// ──────────────────────────────────────────────

function makePre044Db(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL,
    failure_count INTEGER DEFAULT 0, channel TEXT DEFAULT 'log', notify_target TEXT,
    extra TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, parent_task_id TEXT, parallel_index INTEGER, parallel_group TEXT,
    requirement_id TEXT
  );`);
  return db;
}

function insertTask(
  db: Database,
  id: string,
  opts: { createdAt: string; reqId?: string | null; parentId?: string | null } ,
): void {
  db.run(
    "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at, requirement_id, parent_task_id) VALUES (?, ?, 'dev', 'done', ?, ?, ?, ?)",
    [id, "t " + id, opts.createdAt, opts.createdAt, opts.reqId ?? null, opts.parentId ?? null],
  );
}

function seqOf(db: Database, id: string): { kind: string; seq: number } {
  return db.query<{ kind: string; seq: number }, [string]>("SELECT kind, seq FROM tasks WHERE id = ?").get(id)!;
}

describe("迁移 044：tasks 加 kind/seq + 回填", () => {
  it("按 requirement_id 分组 created_at 升序编号；游离/子任务保持默认 1", () => {
    const db = makePre044Db();
    insertTask(db, "a1", { createdAt: "2026-01-01T00:00:00Z", reqId: "req-001" });
    insertTask(db, "a2", { createdAt: "2026-01-02T00:00:00Z", reqId: "req-001" });
    insertTask(db, "a3", { createdAt: "2026-01-03T00:00:00Z", reqId: "req-001" });
    insertTask(db, "b1", { createdAt: "2026-01-05T00:00:00Z", reqId: "req-002" });
    insertTask(db, "orphan", { createdAt: "2026-01-01T00:00:00Z", reqId: null });
    // 并行块子任务：不参与 run 编号
    insertTask(db, "a1-sub", { createdAt: "2026-01-01T12:00:00Z", reqId: "req-001", parentId: "a1" });

    migrate044(db);

    expect(seqOf(db, "a1")).toEqual({ kind: "execution", seq: 1 });
    expect(seqOf(db, "a2")).toEqual({ kind: "execution", seq: 2 });
    expect(seqOf(db, "a3")).toEqual({ kind: "execution", seq: 3 });
    expect(seqOf(db, "b1").seq).toBe(1);
    expect(seqOf(db, "orphan").seq).toBe(1);
    expect(seqOf(db, "a1-sub").seq).toBe(1);
    db.close();
  });

  it("同刻并列按 id 字典序裁决（确定性）", () => {
    const db = makePre044Db();
    insertTask(db, "zz", { createdAt: "2026-01-01T00:00:00Z", reqId: "req-001" });
    insertTask(db, "aa", { createdAt: "2026-01-01T00:00:00Z", reqId: "req-001" });
    migrate044(db);
    expect(seqOf(db, "aa").seq).toBe(1);
    expect(seqOf(db, "zz").seq).toBe(2);
    db.close();
  });

  it("幂等：重复执行结果不变", () => {
    const db = makePre044Db();
    insertTask(db, "a1", { createdAt: "2026-01-01T00:00:00Z", reqId: "req-001" });
    insertTask(db, "a2", { createdAt: "2026-01-02T00:00:00Z", reqId: "req-001" });
    migrate044(db);
    migrate044(db);
    expect(seqOf(db, "a1").seq).toBe(1);
    expect(seqOf(db, "a2").seq).toBe(2);
    db.close();
  });
});

// ──────────────────────────────────────────────
// getTaskRoot 双根解析
// ──────────────────────────────────────────────

const TASKS_SCHEMA_WITH_044 = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL,
  failure_count INTEGER DEFAULT 0, channel TEXT DEFAULT 'log', notify_target TEXT,
  extra TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, parent_task_id TEXT, parallel_index INTEGER, parallel_group TEXT,
  requirement_id TEXT, kind TEXT NOT NULL DEFAULT 'execution', seq INTEGER NOT NULL DEFAULT 1
);`;

describe("getTaskRoot 双根解析（v2 R2）", () => {
  let home: string;
  let db: Database;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "autopilot-dualroot-"));
    prevHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = home;
    db = new Database(":memory:");
    db.exec(TASKS_SCHEMA_WITH_044);
    _setDbForTest(db);
    sandbox._clearTaskRootCacheForTest();
  });

  afterEach(() => {
    _setDbForTest(null);
    db.close();
    sandbox._clearTaskRootCacheForTest();
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function insertRow(id: string, reqId: string | null): void {
    db.run(
      "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at, requirement_id) VALUES (?, 't', 'dev', 'done', '2026-01-01', '2026-01-01', ?)",
      [id, reqId],
    );
  }

  it("legacy 根存在 → 旧根（存量只读，即便 DB 行带 requirement_id）", () => {
    const legacy = join(home, "runtime", "tasks", "oldtask1");
    mkdirSync(legacy, { recursive: true });
    insertRow("oldtask1", "req-001");
    expect(sandbox.getTaskRoot("oldtask1")).toBe(legacy);
  });

  it("legacy 不存在 + DB 行有 requirement_id → 新根 runs/", () => {
    insertRow("newtask1", "req-001");
    expect(sandbox.getTaskRoot("newtask1")).toBe(
      join(home, "runtime", "requirements", "req-001", "runs", "newtask1"),
    );
  });

  it("无 DB 行 / 无需求关联 → 兜底 legacy（且不缓存——行入库后再查解析到新根）", () => {
    const legacy = join(home, "runtime", "tasks", "ghost1");
    expect(sandbox.getTaskRoot("ghost1")).toBe(legacy);
    // 行入库后（无 bind、legacy 目录始终没建出）应解析到新根——兜底不污染缓存
    insertRow("ghost1", "req-002");
    expect(sandbox.getTaskRoot("ghost1")).toBe(
      join(home, "runtime", "requirements", "req-002", "runs", "ghost1"),
    );
  });

  it("bindTaskRunRoot 种子：task 行未入库也解析到新根（startTaskFromTemplate 的 clone 先于 createTask）", () => {
    const root = sandbox.bindTaskRunRoot("seedtask1", "req-003");
    expect(root).toBe(join(home, "runtime", "requirements", "req-003", "runs", "seedtask1"));
    expect(sandbox.getTaskRoot("seedtask1")).toBe(root);
    expect(sandbox.getTaskSandbox("seedtask1")).toBe(join(root, "workspace"));
  });

  it("bindTaskRunRoot 对 legacy 存量让位（两根互斥）", () => {
    const legacy = join(home, "runtime", "tasks", "mixed1");
    mkdirSync(legacy, { recursive: true });
    expect(sandbox.bindTaskRunRoot("mixed1", "req-004")).toBe(legacy);
  });

  it("删除任务级联删新根 runs/<taskId>/ 目录（deleteTaskRuntimeDir 经 getTaskRoot 自动适配）", () => {
    insertRow("deltask1", "req-005");
    const root = sandbox.getTaskRoot("deltask1");
    expect(root).toBe(join(home, "runtime", "requirements", "req-005", "runs", "deltask1"));
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "phase-x.log"), "x\n", "utf-8");
    expect(sandbox.deleteTaskRuntimeDir("deltask1")).toBe(true);
    expect(existsSync(root)).toBe(false);
    // 需求目录本身保留（删任务≠删需求）
    expect(existsSync(join(home, "runtime", "requirements", "req-005"))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// listManifestTaskIds / scan / retention 双根
// ──────────────────────────────────────────────

describe("双根遍历（manifest 扫描 / sandbox 扫描 / retention）", () => {
  let home: string;
  let db: Database;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "autopilot-dualscan-"));
    prevHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = home;
    db = new Database(":memory:");
    db.exec(TASKS_SCHEMA_WITH_044);
    _setDbForTest(db);
    sandbox._clearTaskRootCacheForTest();
  });

  afterEach(() => {
    _setDbForTest(null);
    db.close();
    sandbox._clearTaskRootCacheForTest();
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeManifestAt(dir: string, taskId: string): void {
    mkdirSync(dir, { recursive: true });
    const m = {
      version: 1, taskId, title: "t", workflow: "dev",
      workflow_snapshot: { name: "dev", initial_state: "pending_x", terminal_states: ["done"], phases: [] },
      status: "done", failure_count: 0, channel: "log", notify_target: null,
      created_at: "2026-01-01", updated_at: "2026-01-01", started_at: null,
      parent_task_id: null, parallel_index: null, parallel_group: null, extra: {}, transitions: [],
    };
    writeFileSync(join(dir, "task-manifest.json"), JSON.stringify(m));
  }

  it("listManifestTaskIds 双根：legacy + runs/ 都扫到，readManifest 经种子解析新根", () => {
    writeManifestAt(join(home, "runtime", "tasks", "legacy01"), "legacy01");
    writeManifestAt(join(home, "runtime", "requirements", "req-009", "runs", "newrun01"), "newrun01");

    const ids = manifestModule.listManifestTaskIds().sort();
    expect(ids).toEqual(["legacy01", "newrun01"]);
    // 新根 manifest（DB 无行）也能按 taskId 读回——listManifestTaskIds 内已 bindTaskRunRoot 种子
    expect(manifestModule.readManifest("newrun01")?.taskId).toBe("newrun01");
    expect(manifestModule.readManifest("legacy01")?.taskId).toBe("legacy01");
  });

  it("scanTaskSandboxes 默认双根扫描；applyRetentionPolicy 能清新根下的 workspace", () => {
    const dayMs = 86400 * 1000;
    const old = Date.now() - 30 * dayMs;
    const seed = (root: string) => {
      const ws = join(root, "workspace");
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, "data.txt"), Buffer.alloc(64, 0x41));
      utimesSync(join(ws, "data.txt"), old / 1000, old / 1000);
      utimesSync(ws, old / 1000, old / 1000);
    };
    const legacyRoot = join(home, "runtime", "tasks", "legtask1");
    const newRoot = join(home, "runtime", "requirements", "req-010", "runs", "runtask1");
    seed(legacyRoot);
    seed(newRoot);

    const scanned = retention.scanTaskSandboxes();
    const byId = Object.fromEntries(scanned.map((u) => [u.taskId, u]));
    expect(byId["legtask1"]?.exists).toBe(true);
    expect(byId["legtask1"]?.root).toBe(legacyRoot);
    expect(byId["runtask1"]?.exists).toBe(true);
    expect(byId["runtask1"]?.root).toBe(newRoot);

    // retention：days=1，两根下 30 天前的终态任务 workspace 都被清
    const r = retention.applyRetentionPolicy({ days: 1 }, { isTerminal: () => true });
    expect(r.removed.sort()).toEqual(["legtask1", "runtask1"]);
    expect(existsSync(join(legacyRoot, "workspace"))).toBe(false);
    expect(existsSync(join(newRoot, "workspace"))).toBe(false);
  });
});
