import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as dbModule from "../src/core/db";
import * as manifestModule from "../src/core/manifest";
import * as rebuild from "../src/core/rebuild-index";

/**
 * 共用 db / manifest 模块（AUTOPILOT_HOME 已改为动态读 env）。
 * 每个测试独立 tmp home + 内存 SQLite，避免交叉污染。
 */
async function withTempEnv<T>(
  fn: (home: string) => T | Promise<T>
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "autopilot-rebuild-"));
  const prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = home;

  const { Database } = await import("bun:sqlite");
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, workflow TEXT NOT NULL,
      status TEXT NOT NULL, failure_count INTEGER DEFAULT 0,
      channel TEXT DEFAULT 'log', notify_target TEXT, extra TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, parent_task_id TEXT, parallel_index INTEGER, parallel_group TEXT
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, trigger_name TEXT, note TEXT,
      created_at TEXT NOT NULL
    );
  `);
  dbModule._setDbForTest(sqlite);

  try {
    return await fn(home);
  } finally {
    dbModule._setDbForTest(null);
    sqlite.close();
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function mkManifest(taskId: string, status = "done"): manifestModule.TaskManifest {
  return {
    version: manifestModule.MANIFEST_VERSION,
    taskId,
    title: "task " + taskId,
    workflow: "demo",
    workflow_snapshot: {
      name: "demo",
      initial_state: "pending_plan",
      terminal_states: ["done"],
      phases: [],
    },
    status,
    failure_count: 0,
    channel: "log",
    notify_target: null,
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:01:00.000Z",
    started_at: null,
    parent_task_id: null,
    parallel_index: null,
    parallel_group: null,
    extra: { reqId: "r-" + taskId },
    transitions: [],
  };
}

describe("rebuildIndexFromManifests", () => {
  it("manifest → DB：新任务被 INSERT", async () => {
    await withTempEnv(async () => {
      manifestModule.writeManifest(mkManifest("t1"));
      const result = rebuild.rebuildIndexFromManifests();
      expect(result.scanned).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
      const task = dbModule.getTask("t1");
      expect(task).not.toBeNull();
      expect(task?.workflow).toBe("demo");
      expect(task?.status).toBe("done");
      expect((task as any).reqId).toBe("r-t1");
    });
  });

  it("manifest → DB：已存在的任务被 UPDATE（manifest 赢）", async () => {
    await withTempEnv(async () => {
      dbModule.createTask({ id: "t1", title: "旧", workflow: "demo", initialStatus: "pending_plan" });
      manifestModule.writeManifest(mkManifest("t1", "done"));
      const result = rebuild.rebuildIndexFromManifests();
      expect(result.updated).toBe(1);
      expect(dbModule.getTask("t1")?.status).toBe("done");
      expect(dbModule.getTask("t1")?.title).toBe("task t1");
    });
  });
});

describe("rebuildManifestsFromIndex", () => {
  it("DB → manifest：只补缺失的", async () => {
    await withTempEnv(async () => {
      dbModule.createTask({ id: "t1", title: "需要补 manifest", workflow: "demo", initialStatus: "done" });
      dbModule.createTask({ id: "t2", title: "已有 manifest", workflow: "demo", initialStatus: "done" });
      manifestModule.writeManifest(mkManifest("t2", "done"));

      const result = rebuild.rebuildManifestsFromIndex();
      expect(result.scanned).toBe(2);
      expect(result.created).toBe(1);
      expect(result.alreadyExists).toBe(1);

      const m1 = manifestModule.readManifest("t1");
      expect(m1).not.toBeNull();
      expect(m1?.title).toBe("需要补 manifest");
      expect(m1?.workflow_snapshot._legacy).toBe(true);
    });
  });

  it("DB → manifest：把 task_logs 还原成 transitions", async () => {
    await withTempEnv(async () => {
      dbModule.createTask({ id: "t1", title: "t", workflow: "demo", initialStatus: "pending_plan" });
      const sqlite = dbModule.getDb();
      sqlite.run("INSERT INTO task_logs (task_id, from_status, to_status, trigger_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["t1", "pending_plan", "running_plan", "plan", null, "2026-04-17T00:00:01.000Z"]);
      sqlite.run("INSERT INTO task_logs (task_id, from_status, to_status, trigger_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["t1", "running_plan", "done", "plan_complete", null, "2026-04-17T00:00:02.000Z"]);

      rebuild.rebuildManifestsFromIndex();
      const m = manifestModule.readManifest("t1");
      expect(m?.transitions.length).toBe(2);
      expect(m?.transitions[0]?.to).toBe("running_plan");
      expect(m?.transitions[1]?.to).toBe("done");
    });
  });
});
