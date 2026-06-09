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
import { up as migrate019 } from "../src/migrations/019-task-requirement-id";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest, createTask, getTask } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import {
  createRequirement,
  setRequirementStatus,
  nextRequirementId,
} from "../src/core/requirements";
import { acquireLock, _releaseAllLocks } from "../src/core/infra";
import { cancelRequirementWithTasks, restartTaskAction, TaskActionError } from "../src/daemon/task-actions";

let db: Database;
let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-taskactions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of [migrate001, migrate002, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009, migrate010, migrate019, migrate021, migrate024]) {
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

describe("cancelRequirementWithTasks（SC-1：cancel 级联停 task）", () => {
  it("取消运行中需求时级联取消其名下任务", () => {
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
    expect(getTask("tk-001")?.status).toBe("cancelled"); // 级联停 task，不再游离运行
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
