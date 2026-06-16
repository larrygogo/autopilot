/**
 * 「删除一件工作」级联测试 —— 验证 deleteRequirementWithTasks 在删需求的同时
 * 级联强删该需求名下的全部任务树（含非终态、含子任务）及 task_phase_events，
 * 返回被删 task id 列表，且严格隔离不波及其他需求/项目的任务。
 *
 * 对照：core 裸 deleteRequirement 仍只删需求行（见 requirements.test.ts），
 * 不级联任务 —— 项目级联删除走 forceDeleteTasksForProject 先清任务那条路。
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
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById, updateRequirement } from "../src/core/requirements";
import { deleteRequirementWithTasks } from "../src/core/task/delete";

describe("删除一件工作（需求 + 任务级联）", () => {
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

  it("删需求连带删其终态任务 + task_phase_events，返回 task id 列表", () => {
    createProject({ id: "proj-1", name: "P1" });
    seedReqWithTask("proj-1", "req-1", "task-1", "done");
    startTaskPhase("task-1", "design");
    expect(listTaskPhaseEvents("task-1").length).toBe(1);

    const { deletedTasks } = deleteRequirementWithTasks("req-1");

    expect(deletedTasks).toContain("task-1");
    expect(getRequirementById("req-1")).toBeNull();
    expect(getTask("task-1")).toBeNull();
    expect(listTaskPhaseEvents("task-1").length).toBe(0);
  });

  it("强删非终态（running）任务也清，不抛终态错", () => {
    createProject({ id: "proj-2", name: "P2" });
    seedReqWithTask("proj-2", "req-2", "task-2", "running_design");

    expect(() => deleteRequirementWithTasks("req-2")).not.toThrow();
    expect(getTask("task-2")).toBeNull();
    expect(getRequirementById("req-2")).toBeNull();
  });

  it("父 + 子任务整棵清（子任务不被当根漏删）", () => {
    createProject({ id: "proj-3", name: "P3" });
    createRequirement({ id: "req-3", project_id: "proj-3", title: "r3", spec_md: "x" });
    createTask({ id: "root-3", title: "root", workflow: "test_wf", initialStatus: "running_dev", requirementId: "req-3" });
    createSubTask({ parentTaskId: "root-3", subTaskId: "child-3a", phaseName: "dev", parallelGroup: "g", parallelIndex: 0, initialStatus: "running_dev" });
    createSubTask({ parentTaskId: "root-3", subTaskId: "child-3b", phaseName: "dev", parallelGroup: "g", parallelIndex: 1, initialStatus: "done" });

    const { deletedTasks } = deleteRequirementWithTasks("req-3");

    expect(deletedTasks).toContain("root-3");
    expect(deletedTasks).toContain("child-3a");
    expect(deletedTasks).toContain("child-3b");
    expect(getTask("root-3")).toBeNull();
    expect(getTask("child-3a")).toBeNull();
    expect(getTask("child-3b")).toBeNull();
  });

  it("需求无关联任务时正常删，deletedTasks 为空", () => {
    createProject({ id: "proj-4", name: "P4" });
    createRequirement({ id: "req-4", project_id: "proj-4", title: "r4", spec_md: "x" });

    const { deletedTasks } = deleteRequirementWithTasks("req-4");

    expect(deletedTasks).toEqual([]);
    expect(getRequirementById("req-4")).toBeNull();
  });

  it("需求隔离：不误删其他需求的任务", () => {
    createProject({ id: "proj-5", name: "P5" });
    seedReqWithTask("proj-5", "req-5a", "task-5a", "done");
    seedReqWithTask("proj-5", "req-5b", "task-5b", "done");

    deleteRequirementWithTasks("req-5a");

    expect(getTask("task-5a")).toBeNull();
    expect(getRequirementById("req-5a")).toBeNull();
    expect(getTask("task-5b")).not.toBeNull();
    expect(getRequirementById("req-5b")).not.toBeNull();
  });
});
