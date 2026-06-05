/**
 * 项目级联删除测试 —— 验证 deleteProject 在删 requirements/workspaces 之外，
 * 还级联强删项目下的全部任务（含非终态、含子任务树）及 task_phase_events，
 * 且严格隔离不波及其他项目。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  _setDbForTest,
  initDb,
  createTask,
  createSubTask,
  getTask,
  startTaskPhase,
  listTaskPhaseEvents,
} from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { createProject, deleteProject, getProjectById } from "../src/core/projects";
import { createRequirement, getRequirementById, updateRequirement } from "../src/core/requirements";
import { forceDeleteTasksForProject } from "../src/core/task-delete";

describe("项目级联删除", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM task_phase_events");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM requirement_workspaces");
    db.run("DELETE FROM requirements");
    db.run("DELETE FROM projects");
  });

  function seedReqWithTask(projectId: string, reqId: string, taskId: string, status: string): void {
    createRequirement({ id: reqId, project_id: projectId, title: reqId, spec_md: "x" });
    createTask({ id: taskId, title: taskId, workflow: "test_wf", initialStatus: status, requirementId: reqId });
    updateRequirement(reqId, { task_id: taskId });
  }

  it("删项目级联清 requirements + tasks + task_phase_events（终态任务）", () => {
    createProject({ id: "proj-1", name: "P1" });
    seedReqWithTask("proj-1", "req-1", "task-1", "done");
    startTaskPhase("task-1", "design");
    expect(listTaskPhaseEvents("task-1").length).toBe(1);

    deleteProject("proj-1");

    expect(getProjectById("proj-1")).toBeNull();
    expect(getRequirementById("req-1")).toBeNull();
    expect(getTask("task-1")).toBeNull();
    expect(listTaskPhaseEvents("task-1").length).toBe(0);
  });

  it("强删非终态（running）任务也清，不抛终态错", () => {
    createProject({ id: "proj-2", name: "P2" });
    seedReqWithTask("proj-2", "req-2", "task-2", "running_design");

    expect(() => deleteProject("proj-2")).not.toThrow();
    expect(getTask("task-2")).toBeNull();
    expect(getProjectById("proj-2")).toBeNull();
  });

  it("父 + 子任务树整棵清（子任务不被当根漏删）", () => {
    createProject({ id: "proj-3", name: "P3" });
    createRequirement({ id: "req-3", project_id: "proj-3", title: "r3", spec_md: "x" });
    createTask({ id: "root-3", title: "root", workflow: "test_wf", initialStatus: "running_dev", requirementId: "req-3" });
    createSubTask({ parentTaskId: "root-3", subTaskId: "child-3a", phaseName: "dev", parallelGroup: "g", parallelIndex: 0, initialStatus: "running_dev" });
    createSubTask({ parentTaskId: "root-3", subTaskId: "child-3b", phaseName: "dev", parallelGroup: "g", parallelIndex: 1, initialStatus: "done" });

    deleteProject("proj-3");

    expect(getTask("root-3")).toBeNull();
    expect(getTask("child-3a")).toBeNull();
    expect(getTask("child-3b")).toBeNull();
  });

  it("项目隔离：不误删其他项目的任务/需求", () => {
    createProject({ id: "proj-A", name: "A" });
    createProject({ id: "proj-B", name: "B" });
    seedReqWithTask("proj-A", "req-A", "task-A", "done");
    seedReqWithTask("proj-B", "req-B", "task-B", "done");

    deleteProject("proj-A");

    expect(getTask("task-A")).toBeNull();
    expect(getTask("task-B")).not.toBeNull();
    expect(getProjectById("proj-B")).not.toBeNull();
    expect(getRequirementById("req-B")).not.toBeNull();
  });

  it("需求无关联任务时正常删，不抛", () => {
    createProject({ id: "proj-4", name: "P4" });
    createRequirement({ id: "req-4", project_id: "proj-4", title: "r4", spec_md: "x" });

    expect(() => deleteProject("proj-4")).not.toThrow();
    expect(getRequirementById("req-4")).toBeNull();
    expect(getProjectById("proj-4")).toBeNull();
  });

  it("forceDeleteTasksForProject 返回被删 task id 列表", () => {
    createProject({ id: "proj-5", name: "P5" });
    seedReqWithTask("proj-5", "req-5", "task-5", "running_x");

    const { deleted } = forceDeleteTasksForProject("proj-5");

    expect(deleted).toContain("task-5");
    expect(getTask("task-5")).toBeNull();
  });
});
