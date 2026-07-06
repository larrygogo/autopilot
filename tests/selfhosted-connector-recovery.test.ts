/**
 * 测试 selfhosted-connector 启动恢复逻辑（recoverInflightLinks）
 *
 * 验证：
 * 1. 有 2 条进行中 reqgenie 需求 → registerLink + pushSnapshot 各被调用 2 次
 * 2. 有活跃 task 的需求 → registerTaskRequirement 也被调用
 * 3. 空列表时不报错、不调用任何方法
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest } from "../src/core/db";
import { recoverInflightLinks } from "../src/daemon/selfhosted-connector/index";
import type { MirrorPusher } from "../src/daemon/selfhosted-connector/mirror-pusher";
import type { ReqLink } from "../src/daemon/selfhosted-connector/types";

// ── 最小 DB 夹具 ────────────────────────────────────────────────

function setupDb(): Database {
  const db = new Database(":memory:");
  // 需要的表：requirements（含 source/external_ref/task_id 列）+ tasks
  db.run(`CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    workspace_id TEXT,
    title TEXT,
    status TEXT,
    spec_md TEXT DEFAULT '',
    chat_session_id TEXT,
    task_id TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    last_reviewed_event_id TEXT,
    active_question_id TEXT,
    clarifier_error TEXT,
    clarifier_provider TEXT,
    clarifier_model TEXT,
    schedule_error TEXT,
    status_reason TEXT,
    status_reason_source TEXT,
    status_before_terminal TEXT,
    workflow TEXT,
    input_mode TEXT,
    source TEXT,
    external_ref TEXT,
    callback_url TEXT,
    callback_secret TEXT,
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    workflow TEXT,
    requirement_id TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  // 其他 getRequirementById 用到的关联表（空表即可）
  db.run(`CREATE TABLE IF NOT EXISTS requirement_comments (id TEXT PRIMARY KEY, requirement_id TEXT, body TEXT)`);
  return db;
}

// ── MirrorPusher mock ────────────────────────────────────────────

function makeMockPusher() {
  const registeredLinks: ReqLink[] = [];
  const taskReqMappings: Array<{ taskId: string; reqId: string }> = [];
  const snapshots: string[] = [];

  const mock = {
    registerLink(link: ReqLink): void {
      registeredLinks.push({ ...link });
    },
    registerTaskRequirement(taskId: string, requirementId: string): void {
      taskReqMappings.push({ taskId, reqId: requirementId });
    },
    async pushSnapshot(autopilotReqId: string): Promise<void> {
      snapshots.push(autopilotReqId);
    },
    // 让 TypeScript 满意——只实现测试用的方法
  } as unknown as MirrorPusher;

  return { mock, registeredLinks, taskReqMappings, snapshots };
}

// ── 测试 ────────────────────────────────────────────────────────

describe("recoverInflightLinks", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    _setDbForTest(db);
  });

  afterEach(() => {
    // 不需要 dispose：没有订阅 event-bus
  });

  it("空列表时不报错，不调用任何方法", async () => {
    const { mock, registeredLinks, taskReqMappings, snapshots } = makeMockPusher();
    await recoverInflightLinks(mock);
    expect(registeredLinks).toHaveLength(0);
    expect(taskReqMappings).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("2 条进行中需求 → registerLink + pushSnapshot 各调用 2 次", async () => {
    // 插入 2 条 source=reqgenie 且非终态需求
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-001', 'proj-1', '需求A', 'clarifying', 'reqgenie', 'rg-aaa', 1, 1)`,
    );
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-002', 'proj-1', '需求B', 'running', 'reqgenie', 'rg-bbb', 2, 2)`,
    );

    const { mock, registeredLinks, taskReqMappings, snapshots } = makeMockPusher();
    await recoverInflightLinks(mock);

    expect(registeredLinks).toHaveLength(2);
    expect(registeredLinks.map((l) => l.reqgenie_req_id).sort()).toEqual(["rg-aaa", "rg-bbb"]);
    expect(registeredLinks.map((l) => l.autopilot_req_id).sort()).toEqual(["req-001", "req-002"]);
    expect(registeredLinks.every((l) => l.mirror_seq === 0)).toBe(true);

    expect(snapshots.sort()).toEqual(["req-001", "req-002"]);
    // 没有 task，不应调用 registerTaskRequirement
    expect(taskReqMappings).toHaveLength(0);
  });

  it("有活跃 task 的需求 → 也调用 registerTaskRequirement", async () => {
    // 插入需求（有 task_id）
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, task_id, created_at, updated_at)
       VALUES ('req-003', 'proj-1', '需求C', 'running', 'reqgenie', 'rg-ccc', 'task-001', 1, 1)`,
    );
    // 插入对应活跃 task（非终态）
    db.run(
      `INSERT INTO tasks (id, title, status, workflow, requirement_id, created_at, updated_at)
       VALUES ('task-001', '任务', 'running_develop', 'dev', 'req-003', '2026-01-01', '2026-01-01')`,
    );

    const { mock, registeredLinks, taskReqMappings, snapshots } = makeMockPusher();
    await recoverInflightLinks(mock);

    expect(registeredLinks).toHaveLength(1);
    expect(registeredLinks[0]!.reqgenie_req_id).toBe("rg-ccc");

    expect(taskReqMappings).toHaveLength(1);
    expect(taskReqMappings[0]!.taskId).toBe("task-001");
    expect(taskReqMappings[0]!.reqId).toBe("req-003");

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toBe("req-003");
  });

  it("终态需求（done/cancelled/failed）不被恢复", async () => {
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-010', 'proj-1', '已完成', 'done', 'reqgenie', 'rg-done', 1, 1)`,
    );
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-011', 'proj-1', '已取消', 'cancelled', 'reqgenie', 'rg-cancelled', 2, 2)`,
    );
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-012', 'proj-1', '已失败', 'failed', 'reqgenie', 'rg-failed', 3, 3)`,
    );

    const { mock, registeredLinks, snapshots } = makeMockPusher();
    await recoverInflightLinks(mock);

    expect(registeredLinks).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("source 非 reqgenie 的需求不被恢复", async () => {
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-020', 'proj-1', '原生需求', 'running', NULL, NULL, 1, 1)`,
    );
    db.run(
      `INSERT INTO requirements (id, project_id, title, status, source, external_ref, created_at, updated_at)
       VALUES ('req-021', 'proj-1', '其他来源', 'running', 'other', 'ext-1', 2, 2)`,
    );

    const { mock, registeredLinks, snapshots } = makeMockPusher();
    await recoverInflightLinks(mock);

    expect(registeredLinks).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });
});
