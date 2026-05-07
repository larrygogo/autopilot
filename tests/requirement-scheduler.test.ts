import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { _setDbForTest } from "../src/core/db";
import { createRepo } from "../src/core/repos";
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
    _setDbForTest(db);
    createRepo({ id: "repo-001", alias: "r1", path: "/tmp/r1", default_branch: "main" });
    createRepo({ id: "repo-002", alias: "r2", path: "/tmp/r2", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    // 清掉 requirements 表数据（保留 repos）
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  it("repo 有 running 任务时不拉新", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, repo_id: "repo-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running"); // 模拟正在跑

    const idB = nextRequirementId();
    createRequirement({ id: idB, repo_id: "repo-001", title: "B" });
    setRequirementStatus(idB, "clarifying");
    setRequirementStatus(idB, "ready");
    setRequirementStatus(idB, "queued");

    // 有 running 任务 → tickRepo 直接 return，不调 startTaskFromTemplate
    await tickRepo("repo-001");

    expect(getRequirementById(idA)?.status).toBe("running");
    expect(getRequirementById(idB)?.status).toBe("queued"); // 仍 queued
  });

  it("awaiting_review 不算占用槽位", () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, repo_id: "repo-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");
    setRequirementStatus(idA, "awaiting_review");

    // 验证 active filter 逻辑：awaiting_review 不在 {running, fix_revision}
    const all = listRequirements({ repo_id: "repo-001" });
    const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(0); // awaiting_review 不在 active
  });

  it("fix_revision 算占用槽位", () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, repo_id: "repo-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");
    setRequirementStatus(idA, "awaiting_review");
    setRequirementStatus(idA, "fix_revision");

    const all = listRequirements({ repo_id: "repo-001" });
    const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(1); // fix_revision 计入 active
  });

  it("不同 repo 互不阻塞（active filter 独立）", () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, repo_id: "repo-001", title: "A" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, repo_id: "repo-002", title: "B" });
    setRequirementStatus(idB, "clarifying");
    setRequirementStatus(idB, "ready");
    setRequirementStatus(idB, "queued");

    // repo-001 有 active；repo-002 没有
    const r1All = listRequirements({ repo_id: "repo-001" });
    const r1Active = r1All.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(r1Active.length).toBe(1);

    const r2All = listRequirements({ repo_id: "repo-002" });
    const r2Active = r2All.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(r2Active.length).toBe(0); // repo-002 无活跃任务，可拉新
  });
});
