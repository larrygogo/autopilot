import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate035 } from "../src/migrations/035-notifications";
import { _setDbForTest } from "../src/core/db";
import { enableBus, disableBus, emit, onEvent, offEvent } from "../src/core/event-bus";
import type { AutopilotEvent } from "../src/core/events";
import { initNotificationRecorder } from "../src/daemon/notification-recorder";
import { listNotifications } from "../src/core/notifications";

/** 最小表夹具：只建 recorder 读取路径需要的列（getTask/getRequirementById 是 SELECT *） */
function setupDb(): Database {
  const db = new Database(":memory:");
  migrate035(db);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, workflow TEXT,
    requirement_id TEXT, created_at TEXT, updated_at TEXT
  )`);
  db.run(`CREATE TABLE requirements (
    id TEXT PRIMARY KEY, title TEXT, status TEXT,
    project_id TEXT, workspace_id TEXT, created_at INTEGER, updated_at INTEGER
  )`);
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)`);
  db.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, alias TEXT, default_branch TEXT)`);
  db.run(`CREATE TABLE requirement_comments (id TEXT PRIMARY KEY, body TEXT)`);
  return db;
}

describe("notification-recorder", () => {
  let dispose: (() => void) | null = null;
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    _setDbForTest(db);
    enableBus();
    dispose = initNotificationRecorder();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    disableBus();
  });

  const seedTask = () => {
    db.run(`INSERT INTO projects (id, name) VALUES ('proj-1', '测试项目')`);
    db.run(`INSERT INTO workspaces (id, alias, default_branch) VALUES ('ws-1', 'repo', 'main')`);
    db.run(`INSERT INTO requirements (id, title, status, project_id, workspace_id, created_at, updated_at)
            VALUES ('req-1', '需求标题', 'running', 'proj-1', 'ws-1', 1, 1)`);
    db.run(`INSERT INTO tasks (id, title, status, workflow, requirement_id, created_at, updated_at)
            VALUES ('t1', '任务标题', 'running_dev', 'dev', 'req-1', '2026-01-01', '2026-01-01')`);
  };

  it("task:transition → done/failed/cancelled/await_review 各记一条，context 含项目快照", () => {
    seedTask();
    const transition = (to: string) =>
      emit({ type: "task:transition", payload: { taskId: "t1", from: "x", to, trigger: "t", note: null } });
    transition("done");
    transition("failed");
    transition("cancelled");
    transition("running_await_review");
    transition("running_dev"); // 非目标状态，不记

    const { items } = listNotifications({ limit: 50 });
    expect(items.map((n) => n.type as string).sort()).toEqual(
      ["task_await_review", "task_cancelled", "task_done", "task_failed"].sort(),
    );
    const done = items.find((n) => n.type === "task_done")!;
    expect(done.severity).toBe("info");
    expect(done.body).toBe("任务标题");
    expect(done.context?.project_name).toBe("测试项目");
    expect(done.context?.requirement_title).toBe("需求标题");
    expect(done.actions[0]?.intent.kind).toBe("view_task");
    const review = items.find((n) => n.type === "task_await_review")!;
    expect(review.actions.some((a) => a.intent.kind === "reject_review")).toBe(true);
  });

  it("notification:created 事件随写入广播", () => {
    seedTask();
    const seen: AutopilotEvent[] = [];
    const spy = (e: AutopilotEvent) => seen.push(e);
    onEvent("notification:created", spy);
    emit({ type: "task:transition", payload: { taskId: "t1", from: "x", to: "done", trigger: "t", note: null } });
    offEvent("notification:created", spy);
    expect(seen.length).toBe(1);
    const ev = seen[0];
    if (ev.type === "notification:created") {
      expect(ev.payload.notification.type).toBe("task_done");
    }
  });

  it("requirement:status-changed → awaiting_approval 记通知，其他状态不记", () => {
    seedTask();
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "awaiting_approval" } });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "awaiting_approval", to: "queued" } });
    const { items } = listNotifications({});
    expect(items.length).toBe(1);
    expect(items[0].type).toBe("requirement_awaiting_approval");
    expect(items[0].severity).toBe("action");
  });

  it("agent 提问：active-question-changed 带 question_id 时记通知并快照提问预览", () => {
    seedTask();
    db.run(`INSERT INTO requirement_comments (id, body) VALUES ('qst-1', '这个按钮要放哪？')`);
    emit({ type: "requirement:active-question-changed", payload: { id: "req-1", question_id: "qst-1" } });
    emit({ type: "requirement:active-question-changed", payload: { id: "req-1", question_id: null } }); // 清空不记
    const { items } = listNotifications({});
    expect(items.length).toBe(1);
    expect(items[0].type).toBe("agent_question");
    expect(items[0].body).toBe("这个按钮要放哪？");
  });

  it("clarifier-error / schedule-error / watcher:recovery 翻译为对应通知", () => {
    seedTask();
    emit({ type: "requirement:clarifier-error", payload: { id: "req-1", reason: "provider down" } });
    emit({ type: "requirement:schedule-error", payload: { id: "req-1", reason: "起任务失败：clone 失败" } });
    emit({ type: "watcher:recovery", payload: { taskId: "t1", phase: "dev", fromStatus: "running_dev", toStatus: "pending_dev" } });
    const { items } = listNotifications({});
    expect(items.map((n) => n.type as string).sort()).toEqual(
      ["clarifier_error", "schedule_error", "watcher_recovery"].sort(),
    );
    expect(items.find((n) => n.type === "clarifier_error")?.severity).toBe("error");
    expect(items.find((n) => n.type === "watcher_recovery")?.severity).toBe("info");
  });

  it("dispose 后不再记录", () => {
    seedTask();
    dispose?.();
    dispose = null;
    emit({ type: "task:transition", payload: { taskId: "t1", from: "x", to: "done", trigger: "t", note: null } });
    expect(listNotifications({}).items.length).toBe(0);
  });
});
