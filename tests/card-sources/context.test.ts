import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { up as m019 } from "../../src/migrations/019-task-requirement-id";
import { up as m021 } from "../../src/migrations/021-requirement-comments";
import { up as m024 } from "../../src/migrations/024-codebase-to-workspace";
import { _setDbForTest, createTask } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createWorkspace } from "../../src/core/workspaces";
import { createRequirement } from "../../src/core/requirements";
import { contextForRequirement, contextForTask } from "../../src/core/card-sources/context";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m019, m021, m024].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("card-sources/context", () => {
  beforeEach(() => {
    initSchema();
    createProject({ id: "proj-001", name: "测试项目" });
    createWorkspace({
      id: "ws-001", project_id: "proj-001", alias: "my-repo",
      path: "/tmp/my-repo", default_branch: "main",
    });
  });

  it("contextForRequirement 解析需求标题 + 项目名 + 仓库别名/分支", () => {
    createRequirement({
      id: "req-001", project_id: "proj-001", workspace_id: "ws-001",
      title: "改 hover bug", spec_md: "",
    });
    expect(contextForRequirement("req-001")).toEqual({
      requirement_id: "req-001",
      requirement_title: "改 hover bug",
      project_name: "测试项目",
      workspace_alias: "my-repo",
      branch: "main",
    });
  });

  it("无 workspace 的需求：alias/branch 缺省，其余照填", () => {
    // 注意 createRequirement 会自动关联项目下唯一 workspace，故用无 workspace 的项目
    createProject({ id: "proj-002", name: "空项目" });
    createRequirement({ id: "req-002", project_id: "proj-002", title: "纯 adhoc", spec_md: "" });
    const ctx = contextForRequirement("req-002");
    expect(ctx?.requirement_title).toBe("纯 adhoc");
    expect(ctx?.project_name).toBe("空项目");
    expect(ctx?.workspace_alias).toBeUndefined();
    expect(ctx?.branch).toBeUndefined();
  });

  it("contextForTask 经 task.requirement_id 解析同一份上下文", () => {
    createRequirement({
      id: "req-001", project_id: "proj-001", workspace_id: "ws-001",
      title: "改 hover bug", spec_md: "",
    });
    createTask({
      id: "task-1", title: "T", workflow: "dev",
      initialStatus: "draft", requirementId: "req-001",
    });
    expect(contextForTask("task-1")).toEqual({
      requirement_id: "req-001",
      requirement_title: "改 hover bug",
      project_name: "测试项目",
      workspace_alias: "my-repo",
      branch: "main",
    });
  });

  it("游离任务（无 requirement_id）/ 不存在的实体返回 undefined", () => {
    createTask({ id: "task-orphan", title: "T", workflow: "dev", initialStatus: "draft" });
    expect(contextForTask("task-orphan")).toBeUndefined();
    expect(contextForTask("nope")).toBeUndefined();
    expect(contextForRequirement("nope")).toBeUndefined();
  });
});
