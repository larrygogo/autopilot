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
import { appendFeedback, listFeedbacks } from "../src/core/requirement-feedbacks";

describe("调度器集成（不走真实 task runner，验证状态流转）", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);
    createRepo({ id: "repo-A", alias: "rA", path: "/tmp/A", default_branch: "main" });
    createRepo({ id: "repo-B", alias: "rB", path: "/tmp/B", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  // 辅助：把需求快速推到指定状态
  function pushTo(id: string, target: string) {
    const PATH: Record<string, string[]> = {
      ready: ["clarifying", "ready"],
      queued: ["clarifying", "ready", "queued"],
      running: ["clarifying", "ready", "queued", "running"],
      awaiting_review: ["clarifying", "ready", "queued", "running", "awaiting_review"],
      fix_revision: ["clarifying", "ready", "queued", "running", "awaiting_review", "fix_revision"],
    };
    for (const s of PATH[target] ?? []) {
      try {
        setRequirementStatus(id, s);
      } catch {
        /* 同状态忽略 */
      }
    }
  }

  it("「占用槽位」语义：running ∨ fix_revision 才算占用，awaiting_review 不算", () => {
    const a = nextRequirementId();
    createRequirement({ id: a, repo_id: "repo-A", title: "A" });
    pushTo(a, "awaiting_review");

    const b = nextRequirementId();
    createRequirement({ id: b, repo_id: "repo-A", title: "B" });
    pushTo(b, "queued");

    const all = listRequirements({ repo_id: "repo-A" });
    const active = all.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(0);

    const queued = all.filter((r) => r.status === "queued");
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe(b);
  });

  it("inject_feedback 路径：awaiting_review + 反馈 → fix_revision", () => {
    const a = nextRequirementId();
    createRequirement({ id: a, repo_id: "repo-A", title: "A" });
    pushTo(a, "awaiting_review");

    appendFeedback({ requirement_id: a, source: "manual", body: "请改 X" });

    // 模拟 routes.ts inject_feedback handler 的逻辑
    const r = getRequirementById(a);
    if (r?.status === "awaiting_review") {
      setRequirementStatus(a, "fix_revision");
    }

    expect(getRequirementById(a)?.status).toBe("fix_revision");
    const fbs = listFeedbacks(a);
    expect(fbs.length).toBe(1);
    expect(fbs[0].body).toContain("X");
  });

  it("跨 repo 互不阻塞", () => {
    const a = nextRequirementId();
    createRequirement({ id: a, repo_id: "repo-A", title: "A" });
    pushTo(a, "running");

    const b = nextRequirementId();
    createRequirement({ id: b, repo_id: "repo-B", title: "B" });
    pushTo(b, "queued");

    // repo-A 有 running，repo-B 无活跃 —— 调度器逻辑可独立处理
    const aActive = listRequirements({ repo_id: "repo-A" }).filter(
      (r) => r.status === "running" || r.status === "fix_revision"
    );
    const bActive = listRequirements({ repo_id: "repo-B" }).filter(
      (r) => r.status === "running" || r.status === "fix_revision"
    );
    expect(aActive.length).toBe(1);
    expect(bActive.length).toBe(0);
  });
});
