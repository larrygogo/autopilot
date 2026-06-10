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
import { up as migrate029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as migrate030 } from "../src/migrations/030-requirement-status-logs";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest, createTask, getTask } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import {
  createRequirement,
  setRequirementStatus,
  nextRequirementId,
} from "../src/core/requirements";
import { acquireLock, _releaseAllLocks } from "../src/core/infra";
import { cancelRequirementWithTasks, cancelTasksForRequirements, restartTaskAction, TaskActionError } from "../src/daemon/task-actions";

let db: Database;
let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-taskactions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of [migrate001, migrate002, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009, migrate010, migrate018, migrate019, migrate021, migrate024, migrate028, migrate029, migrate030, migrate033]) {
    m(db);
  }
  _setDbForTest(db);
});

afterEach(() => {
  _releaseAllLocks();
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("cancelRequirementWithTasks（取消=只保留需求本身，清空执行痕迹）", () => {
  it("取消运行中需求：任务被停止并连根清除，需求保留且 task_id 清空", () => {
    createProject({ id: "proj-001", name: "p" });
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "r", path: "/tmp/r", default_branch: "main" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-001", workspace_id: "cb-001", title: "T" });
    setRequirementStatus(reqId, "clarifying");
    setRequirementStatus(reqId, "ready");
    setRequirementStatus(reqId, "queued");
    setRequirementStatus(reqId, "running");
    createTask({ id: "tk-001", title: "T", workflow: "dev", initialStatus: "running_design", requirementId: reqId });

    const { requirement } = cancelRequirementWithTasks(reqId);

    expect(requirement.status).toBe("cancelled");
    expect(requirement.task_id).toBe(null);          // 执行关联清空
    expect(getTask("tk-001")).toBeFalsy();            // 任务记录被连根清除（取消只留需求本身）
  });

  it("名下无存活任务时仅置需求 cancelled（不报错）", () => {
    createProject({ id: "proj-002", name: "p2" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-002", title: "T2" });
    setRequirementStatus(reqId, "clarifying");
    setRequirementStatus(reqId, "ready");

    const { requirement } = cancelRequirementWithTasks(reqId);
    expect(requirement.status).toBe("cancelled");
  });
});

describe("cancelTasksForRequirements（级联取消单一实现）", () => {
  it("级联取消多个需求名下的所有 root 任务，返回取消数", () => {
    createProject({ id: "proj-c1", name: "p" });
    const reqA = nextRequirementId();
    createRequirement({ id: reqA, project_id: "proj-c1", title: "A" });
    const reqB = nextRequirementId();
    createRequirement({ id: reqB, project_id: "proj-c1", title: "B" });
    createTask({ id: "tk-a1", title: "A1", workflow: "dev", initialStatus: "running_design", requirementId: reqA });
    createTask({ id: "tk-b1", title: "B1", workflow: "dev", initialStatus: "running_design", requirementId: reqB });

    const { cancelled } = cancelTasksForRequirements([reqA, reqB]);

    expect(cancelled).toBe(2);
    expect(getTask("tk-a1")?.status).toBe("cancelled");
    expect(getTask("tk-b1")?.status).toBe("cancelled");
  });

  it("best-effort：已终态任务被跳过、不抛错、不计入取消数", () => {
    createProject({ id: "proj-c2", name: "p2" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-c2", title: "T" });
    createTask({ id: "tk-live", title: "live", workflow: "dev", initialStatus: "running_design", requirementId: reqId });
    createTask({ id: "tk-dead", title: "dead", workflow: "dev", initialStatus: "done", requirementId: reqId });

    const { cancelled } = cancelTasksForRequirements([reqId]);

    expect(cancelled).toBe(1); // 只取消了存活的那个
    expect(getTask("tk-live")?.status).toBe("cancelled");
    expect(getTask("tk-dead")?.status).toBe("done"); // 终态不动
  });
});

describe("restartTaskAction（SC-2：运行中且持锁时拒绝重启）", () => {
  it("running 且持文件锁 → 抛 TaskActionError(409)，状态不被翻动", () => {
    createProject({ id: "proj-003", name: "p3" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-003", title: "T3" });
    createTask({ id: "tk-run", title: "T3", workflow: "dev", initialStatus: "running_design", requirementId: reqId });
    acquireLock("tk-run"); // 模拟阶段正在执行、持有文件锁

    let err: TaskActionError | null = null;
    try {
      restartTaskAction("tk-run");
    } catch (e) {
      err = e as TaskActionError;
    }
    expect(err).toBeInstanceOf(TaskActionError);
    expect(err?.status).toBe(409);
    // 守卫在改状态前抛出，status 仍是 running_design（修前会被翻成 pending_ 永久卡死）
    expect(getTask("tk-run")?.status).toBe("running_design");
  });
});
