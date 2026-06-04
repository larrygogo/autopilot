import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up } from "../src/migrations/023-backfill-orphan-task-requirements";

/**
 * 模拟「迁移 022 之后」的最终 schema：tasks 已有 requirement_id / codebase_id /
 * parent_task_id / extra；requirements 已是 project_id + codebase_id 形态。
 */
function buildSchema(db: Database): void {
  db.run(
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE codebases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      alias TEXT,
      path TEXT
    )`,
  );
  db.run(
    `CREATE TABLE requirements (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      codebase_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      spec_md TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE requirement_codebases (
      requirement_id TEXT NOT NULL,
      codebase_id TEXT NOT NULL,
      PRIMARY KEY (requirement_id, codebase_id)
    )`,
  );
  db.run(
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workflow TEXT NOT NULL,
      status TEXT NOT NULL,
      extra TEXT DEFAULT '{}',
      requirement_id TEXT DEFAULT NULL,
      codebase_id TEXT DEFAULT NULL,
      parent_task_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
}

function insertTask(
  db: Database,
  t: {
    id: string;
    title?: string;
    status?: string;
    extra?: string;
    requirement_id?: string | null;
    codebase_id?: string | null;
    parent_task_id?: string | null;
  },
): void {
  db.run(
    "INSERT INTO tasks (id, title, workflow, status, extra, requirement_id, codebase_id, parent_task_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      t.id,
      t.title ?? t.id,
      "dev",
      t.status ?? "running_design",
      t.extra ?? "{}",
      t.requirement_id ?? null,
      t.codebase_id ?? null,
      t.parent_task_id ?? null,
      "2026-01-01",
      "2026-01-01",
    ],
  );
}

function reqFor(db: Database, taskId: string) {
  return db
    .query<{ id: string; project_id: string; codebase_id: string | null; status: string; spec_md: string }, [string]>(
      "SELECT id, project_id, codebase_id, status, spec_md FROM requirements WHERE task_id = ?",
    )
    .get(taskId);
}

function taskReqId(db: Database, taskId: string): string | null {
  return (
    db
      .query<{ requirement_id: string | null }, [string]>("SELECT requirement_id FROM tasks WHERE id = ?")
      .get(taskId)?.requirement_id ?? null
  );
}

describe("migration 023: 回填历史游离任务需求", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    buildSchema(db);
    db.run(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-001', 'p', 0, 0)",
    );
    db.run("INSERT INTO codebases (id, project_id, alias, path) VALUES ('cb-001', 'proj-001', 'a', '/tmp')");
  });

  it("顶层游离 task → 建一条需求并双向回填", async () => {
    insertTask(db, {
      id: "task-a",
      title: "做个登录页",
      status: "running_design",
      extra: JSON.stringify({ requirement: "需要登录页 spec" }),
      codebase_id: "cb-001",
    });

    await up(db);

    const req = reqFor(db, "task-a");
    expect(req).toBeTruthy();
    expect(req!.project_id).toBe("proj-001"); // 从 codebase 反查
    expect(req!.codebase_id).toBe("cb-001");
    expect(req!.spec_md).toBe("需要登录页 spec");
    expect(req!.status).toBe("running");
    expect(taskReqId(db, "task-a")).toBe(req!.id);

    // requirement_codebases 关联也写了
    const link = db
      .query<{ requirement_id: string }, [string]>(
        "SELECT requirement_id FROM requirement_codebases WHERE codebase_id = ?",
      )
      .get("cb-001");
    expect(link?.requirement_id).toBe(req!.id);
  });

  it("无 codebase 的游离 task → 挂兜底项目 proj-default", async () => {
    insertTask(db, { id: "task-x", title: "杂活", status: "done" });

    await up(db);

    // 兜底项目已建
    const proj = db.query<{ id: string }, []>("SELECT id FROM projects WHERE id='proj-default'").get();
    expect(proj?.id).toBe("proj-default");

    const req = reqFor(db, "task-x");
    expect(req!.project_id).toBe("proj-default");
    expect(req!.codebase_id).toBeNull();
    expect(req!.status).toBe("done"); // 终态对齐
    expect(req!.spec_md).toBe("杂活"); // extra 无 requirement → 用 title
  });

  it("子 task 继承父 task 的 requirement_id", async () => {
    // 父非游离（已有 requirement_id），子游离
    db.run(
      "INSERT INTO requirements (id, project_id, codebase_id, title, status, spec_md, task_id, created_at, updated_at) " +
        "VALUES ('req-100', 'proj-001', 'cb-001', 'parent req', 'running', 'x', 'task-parent', 0, 0)",
    );
    insertTask(db, { id: "task-parent", requirement_id: "req-100", codebase_id: "cb-001" });
    insertTask(db, { id: "task-child", parent_task_id: "task-parent", codebase_id: "cb-001" });

    await up(db);

    expect(taskReqId(db, "task-child")).toBe("req-100");
    // 不该为子 task 另建需求
    const childOwnReq = reqFor(db, "task-child");
    expect(childOwnReq).toBeNull();
  });

  it("父也游离时：父建需求后子继承父的新需求", async () => {
    insertTask(db, { id: "task-p", title: "父任务", codebase_id: "cb-001" });
    insertTask(db, { id: "task-c", parent_task_id: "task-p", codebase_id: "cb-001" });

    await up(db);

    const parentReq = taskReqId(db, "task-p");
    expect(parentReq).toBeTruthy();
    expect(taskReqId(db, "task-c")).toBe(parentReq); // 子继承父新建的需求
  });

  it("已挂需求的 task 不被改动", async () => {
    db.run(
      "INSERT INTO requirements (id, project_id, codebase_id, title, status, spec_md, task_id, created_at, updated_at) " +
        "VALUES ('req-keep', 'proj-001', NULL, 'keep', 'running', '', 'task-kept', 0, 0)",
    );
    insertTask(db, { id: "task-kept", requirement_id: "req-keep" });

    await up(db);
    expect(taskReqId(db, "task-kept")).toBe("req-keep");
  });

  it("幂等：重跑不重复建需求", async () => {
    insertTask(db, { id: "task-1", title: "t1" });
    insertTask(db, { id: "task-2", title: "t2", codebase_id: "cb-001" });

    await up(db);
    const countAfterFirst = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM requirements")
      .get()!.n;

    await up(db);
    const countAfterSecond = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM requirements")
      .get()!.n;

    expect(countAfterSecond).toBe(countAfterFirst);
    // 每个 task 仍各自指向稳定的 requirement_id
    expect(taskReqId(db, "task-1")).toBeTruthy();
    expect(taskReqId(db, "task-2")).toBeTruthy();
  });

  it("requirements 表不存在时不抛", async () => {
    db.run("DROP TABLE requirements");
    await up(db); // 应静默返回
    expect(true).toBe(true);
  });
});
