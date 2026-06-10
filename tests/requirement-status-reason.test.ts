/**
 * 需求终态原因（status_reason / status_reason_source）回归测试。
 * 背景：req-008 被「code_review 驳回 3 次自动取消」后面板毫无原因展示（dogfood）。
 * 覆盖：bridge 终态同步带原因、手动取消 user 来源覆盖、failed 重试清空、
 *       computeTaskOutcome terminal_reason / rejection_*、migration 028 幂等 + 回填。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate010 } from "../src/migrations/010-question-suggestions";
import { up as migrate018 } from "../src/migrations/018-task-phase-events";
import { up as migrate019 } from "../src/migrations/019-task-requirement-id";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate028 } from "../src/migrations/028-requirement-status-reason";
import { _setDbForTest, createTask, getTask, getDb } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  setRequirementStatusReason,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { enableBus } from "../src/core/event-bus";
import { initRequirementTaskBridge, disposeRequirementTaskBridge } from "../src/daemon/requirement-task-bridge";
import { cancelRequirementWithTasks } from "../src/daemon/task-actions";
import { computeTaskOutcome } from "../src/daemon/task-outcome";
import { _releaseAllLocks } from "../src/core/infra";

let db: Database;
let tmpHome: string;

const ALL_MIGRATIONS = [
  migrate001, migrate002, migrate004, migrate005, migrate006, migrate007,
  migrate008, migrate009, migrate010, migrate018, migrate019, migrate021,
  migrate024, migrate028,
];

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-statusreason-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of ALL_MIGRATIONS) m(db);
  _setDbForTest(db);
});

afterEach(() => {
  disposeRequirementTaskBridge();
  _releaseAllLocks();
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function makeRunningRequirement(opts?: { withTask?: boolean }): { reqId: string; taskId: string | null } {
  createProject({ id: "proj-sr1", name: "p" });
  createWorkspace({ id: "ws-sr1", project_id: "proj-sr1", alias: "r", path: "/tmp/r", default_branch: "main" });
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: "proj-sr1", workspace_id: "ws-sr1", title: "T" });
  setRequirementStatus(reqId, "clarifying");
  setRequirementStatus(reqId, "ready");
  setRequirementStatus(reqId, "queued");
  setRequirementStatus(reqId, "running");
  let taskId: string | null = null;
  if (opts?.withTask !== false) {
    taskId = "tk-sr01";
    createTask({ id: taskId, title: "T", workflow: "dev", initialStatus: "running_design", requirementId: reqId });
    updateRequirement(reqId, { task_id: taskId });
  }
  return { reqId, taskId };
}

describe("setRequirementStatus 终态原因写入与清空", () => {
  it("进 failed 带 reason → 两列写入；failed → queued 重试 → 两列清空", () => {
    const { reqId } = makeRunningRequirement({ withTask: false });
    setRequirementStatus(reqId, "failed", { reason: "develop 阶段崩溃", reason_source: "task" });
    let r = getRequirementById(reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toBe("develop 阶段崩溃");
    expect(r.status_reason_source).toBe("task");

    setRequirementStatus(reqId, "queued");
    r = getRequirementById(reqId)!;
    expect(r.status).toBe("queued");
    expect(r.status_reason).toBe(null);
    expect(r.status_reason_source).toBe(null);
  });

  it("非终态转换不碰原因列", () => {
    const { reqId } = makeRunningRequirement({ withTask: false });
    setRequirementStatusReason(reqId, "残留原因", "system");
    setRequirementStatus(reqId, "awaiting_review");
    const r = getRequirementById(reqId)!;
    expect(r.status_reason).toBe("残留原因"); // running → awaiting_review 不清不写
  });
});

describe("requirement-task-bridge 终态同步带原因（req-008 链路复现）", () => {
  it("task cancel transition（带 note）→ req cancelled + reason=note + source=task", () => {
    enableBus();
    initRequirementTaskBridge();
    const { reqId, taskId } = makeRunningRequirement();

    const { transition } = require("../src/core/state-machine");
    transition(taskId!, "cancel", {
      transitions: { running_design: [["cancel", "cancelled"]] },
      note: "代码审查驳回 3 次，已取消",
    });

    const r = getRequirementById(reqId)!;
    expect(r.status).toBe("cancelled");
    expect(r.status_reason).toBe("代码审查驳回 3 次，已取消");
    expect(r.status_reason_source).toBe("task");
  });

  it("task failed transition 无 note → fallback 描述串", () => {
    enableBus();
    initRequirementTaskBridge();
    const { reqId, taskId } = makeRunningRequirement();

    const { transition } = require("../src/core/state-machine");
    transition(taskId!, "fail", {
      transitions: { running_design: [["fail", "failed"]] },
    });

    const r = getRequirementById(reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toContain(taskId!);
    expect(r.status_reason_source).toBe("task");
  });
});

describe("cancelRequirementWithTasks 手动取消 user 来源", () => {
  it("无 task：reason 默认「用户手动取消」+ source=user", () => {
    createProject({ id: "proj-sr2", name: "p2" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-sr2", title: "T2" });
    const { requirement } = cancelRequirementWithTasks(reqId);
    expect(requirement.status).toBe("cancelled");
    expect(requirement.status_reason).toBe("用户手动取消");
    expect(requirement.status_reason_source).toBe("user");
  });

  it("有运行中 task：bridge 抢先写 task 来源后，最终覆盖为 user", () => {
    enableBus();
    initRequirementTaskBridge();
    const { reqId } = makeRunningRequirement();

    const { requirement } = cancelRequirementWithTasks(reqId, "不做了");
    expect(requirement.status).toBe("cancelled");
    expect(requirement.status_reason).toBe("不做了");
    expect(requirement.status_reason_source).toBe("user");
    // DB 落库值与返回值一致
    const r = getRequirementById(reqId)!;
    expect(r.status_reason).toBe("不做了");
    expect(r.status_reason_source).toBe("user");
  });
});

describe("computeTaskOutcome terminal_reason / rejection_*", () => {
  it("cancelled 任务取最后一条进终态的 note；驳回详情从 extra 带出", async () => {
    const { taskId } = makeRunningRequirement();
    const { transition } = require("../src/core/state-machine");
    transition(taskId!, "cancel", {
      transitions: { running_design: [["cancel", "cancelled"]] },
      note: "代码审查驳回 3 次，已取消",
      extraUpdates: {
        rejection_counts: JSON.stringify({ design: 1, code: 3 }),
        rejection_reason: "这是第三次提交空 diff",
      },
    });

    const outcome = await computeTaskOutcome(taskId!);
    expect(outcome?.status).toBe("cancelled");
    expect(outcome?.terminal_reason).toBe("代码审查驳回 3 次，已取消");
    expect(outcome?.rejection_counts).toEqual({ design: 1, code: 3 });
    expect(outcome?.rejection_reason).toBe("这是第三次提交空 diff");
  });

  it("done 任务 terminal_reason 为 null；坏 rejection_counts JSON 容错为 null", async () => {
    createProject({ id: "proj-sr3", name: "p3" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-sr3", title: "T3" });
    createTask({ id: "tk-done1", title: "T", workflow: "dev", initialStatus: "done", requirementId: reqId });
    getDb().run("UPDATE tasks SET extra = ? WHERE id = ?", [JSON.stringify({ rejection_counts: "{broken" }), "tk-done1"]);

    const outcome = await computeTaskOutcome("tk-done1");
    expect(outcome?.status).toBe("done");
    expect(outcome?.terminal_reason).toBe(null);
    expect(outcome?.rejection_counts).toBe(null);
  });
});

describe("migration 028 幂等 + 历史回填", () => {
  it("跑两遍不炸；终态需求从 task_logs 回填、已有值不覆盖", () => {
    const freshDb = new Database(":memory:");
    for (const m of ALL_MIGRATIONS) m(freshDb);

    const ts = Date.now();
    freshDb.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-m', 'm', ?, ?)", [ts, ts]);
    freshDb.run(
      "INSERT INTO requirements (id, project_id, title, status, spec_md, task_id, created_at, updated_at) VALUES ('req-m1', 'proj-m', 't', 'cancelled', '', 'tk-m1', ?, ?)",
      [ts, ts],
    );
    freshDb.run(
      "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at) VALUES ('tk-m1', 't', 'dev', 'cancelled', ?, ?)",
      [String(ts), String(ts)],
    );
    freshDb.run(
      "INSERT INTO task_logs (task_id, from_status, to_status, trigger_name, note, created_at) VALUES ('tk-m1', 'running_code_review', 'cancelled', 'cancel', '代码审查驳回 3 次，已取消', ?)",
      [String(ts)],
    );

    migrate028(freshDb); // 第二遍：列已存在 → 只跑回填
    const row = freshDb
      .query<{ status_reason: string | null; status_reason_source: string | null }, []>(
        "SELECT status_reason, status_reason_source FROM requirements WHERE id = 'req-m1'",
      )
      .get()!;
    expect(row.status_reason).toBe("代码审查驳回 3 次，已取消");
    expect(row.status_reason_source).toBe("task");

    // 已有值不被第三遍覆盖
    freshDb.run("UPDATE requirements SET status_reason = '手工改过' WHERE id = 'req-m1'");
    migrate028(freshDb);
    const row2 = freshDb
      .query<{ status_reason: string | null }, []>("SELECT status_reason FROM requirements WHERE id = 'req-m1'")
      .get()!;
    expect(row2.status_reason).toBe("手工改过");
    freshDb.close();
  });
});
