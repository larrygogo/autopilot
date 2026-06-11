import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/workspaces";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  nextRequirementId,
  listRequirements,
} from "../src/core/requirements";
import { tickRepo } from "../src/daemon/requirement-scheduler";

describe("tickRepo", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate021(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);
    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "r1", path: "/tmp/r1", default_branch: "main" });
    createWorkspace({ id: "cb-002", project_id: "proj-001", alias: "r2", path: "/tmp/r2", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    // 清掉 requirements 表数据（保留 repos）
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  it("repo 有 running 任务时不拉新", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running"); // 模拟正在跑

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-001", workspace_id: "cb-001", title: "B" });
    setRequirementStatus(idB, "clarifying");
    setRequirementStatus(idB, "ready");
    setRequirementStatus(idB, "queued");

    // 有 running 任务 → tickRepo 直接 return，不调 startTaskFromTemplate
    await tickRepo("cb-001");

    expect(getRequirementById(idA)?.status).toBe("running");
    expect(getRequirementById(idB)?.status).toBe("queued"); // 仍 queued
  });

  it("awaiting_review 不算占用槽位", () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");
    setRequirementStatus(idA, "awaiting_review");

    // 验证 active filter 逻辑：awaiting_review 不在 {running, fix_revision}
    const all = listRequirements({ workspace_id: "cb-001" });
    const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(0); // awaiting_review 不在 active
  });

  it("fix_revision 算占用槽位", () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");
    setRequirementStatus(idA, "awaiting_review");
    setRequirementStatus(idA, "fix_revision");

    const all = listRequirements({ workspace_id: "cb-001" });
    const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(1); // fix_revision 计入 active
  });

  // 注：原「不同 repo 互不阻塞」测试已删除——调度已改为全局总上限
  // （scheduler.max_concurrent_tasks，默认 1），跨 repo 行为见
  // tests/requirement-scheduler-global.test.ts。
});

describe("tickRepo 组级锁（父 + 子模块同组 1 active）", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate021(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);
    createProject({ id: "proj-grp", name: "group-test-proj" });
    // 父 codebase
    createWorkspace({ id: "cb-p1", project_id: "proj-grp", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    // 子模块（parent_workspace_id = cb-p1）
    createWorkspace({
      id: "cb-c1",
      project_id: "proj-grp",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_workspace_id: "cb-p1",
      submodule_path: "child1",
    });
    // 另一独立父 codebase
    createWorkspace({ id: "cb-p2", project_id: "proj-grp", alias: "parent2", path: "/tmp/p2", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  it("子模块上的 running 阻塞父 repo 拉新（组级锁）", async () => {
    const idChild = nextRequirementId();
    createRequirement({ id: idChild, project_id: "proj-grp", workspace_id: "cb-c1", title: "child-task" });
    setRequirementStatus(idChild, "clarifying");
    setRequirementStatus(idChild, "ready");
    setRequirementStatus(idChild, "queued");
    setRequirementStatus(idChild, "running");

    const idParent = nextRequirementId();
    createRequirement({ id: idParent, project_id: "proj-grp", workspace_id: "cb-p1", title: "parent-task" });
    setRequirementStatus(idParent, "clarifying");
    setRequirementStatus(idParent, "ready");
    setRequirementStatus(idParent, "queued");

    await tickRepo("cb-p1");
    expect(getRequirementById(idParent)?.status).toBe("queued");
  });

  it("传入子模块 id 也走同一组（groupId 归一化）", async () => {
    const idParent = nextRequirementId();
    createRequirement({ id: idParent, project_id: "proj-grp", workspace_id: "cb-p1", title: "parent-task" });
    setRequirementStatus(idParent, "clarifying");
    setRequirementStatus(idParent, "ready");
    setRequirementStatus(idParent, "queued");
    setRequirementStatus(idParent, "running");

    await tickRepo("cb-c1");
    expect(getRequirementById(idParent)?.status).toBe("running");
  });

  it("组级 candidate 仅从组主仓库（父）拉取，子模块上的 queued 被忽略", async () => {
    const idChildQueued = nextRequirementId();
    createRequirement({ id: idChildQueued, project_id: "proj-grp", workspace_id: "cb-c1", title: "child-only-queued" });
    setRequirementStatus(idChildQueued, "clarifying");
    setRequirementStatus(idChildQueued, "ready");
    setRequirementStatus(idChildQueued, "queued");

    await tickRepo("cb-p1");
    expect(getRequirementById(idChildQueued)?.status).toBe("queued");
  });

  // 注：原「不同组之间不互相阻塞」测试已删除——调度已改为全局总上限，
  // 一组的 running 在 N=1 时会阻塞其他组拉新，见 tests/requirement-scheduler-global.test.ts。
});
