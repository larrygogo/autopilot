import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { listFeedbacks } from "../src/core/requirement-feedbacks";
import { pollOne, _setGhRunnerForTest, type GhRunner } from "../src/daemon/pr-poller";

describe("pr-poller pollOne", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);
    createRepo({
      id: "repo-A",
      alias: "rA",
      path: "/tmp/A",
      default_branch: "main",
      github_owner: "test-owner",
      github_repo: "test-repo",
    });
  });

  afterAll(() => {
    _setGhRunnerForTest(null);
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  afterEach(() => {
    _setGhRunnerForTest(null); // 恢复
  });

  // 辅助：把需求快速推到 awaiting_review，并设 pr_number
  function setupReqAwaitingReview(prNumber = 42, lastReviewId: string | null = null): string {
    const id = nextRequirementId();
    createRequirement({ id, repo_id: "repo-A", title: "T" });
    setRequirementStatus(id, "clarifying");
    setRequirementStatus(id, "ready");
    setRequirementStatus(id, "queued");
    setRequirementStatus(id, "running");
    setRequirementStatus(id, "awaiting_review");
    updateRequirement(id, {
      pr_number: prNumber,
      pr_url: `https://github.com/test-owner/test-repo/pull/${prNumber}`,
      last_reviewed_event_id: lastReviewId,
    });
    return id;
  }

  function mockGh(stdoutJson: unknown): GhRunner {
    return async () => ({
      exitCode: 0,
      stdout: JSON.stringify(stdoutJson),
      stderr: "",
    });
  }

  it("PR merged → setStatus(done) + 不注入反馈", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(mockGh({
      state: "MERGED",
      reviews: [],
      mergeCommit: { oid: "abc123" },
    }));

    await pollOne(id, "gh");

    expect(getRequirementById(id)?.status).toBe("done");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("无新 CHANGES_REQUESTED → 状态不变 + 不注入", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        { id: "r1", state: "APPROVED", body: "looks good", author: { login: "alice" } },
        { id: "r2", state: "COMMENTED", body: "nit: typo", author: { login: "bob" } },
      ],
      mergeCommit: null,
    }));

    await pollOne(id, "gh");

    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("新 CHANGES_REQUESTED → 注入 + setStatus(fix_revision) + 写 last_reviewed_event_id", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        {
          id: "PRR_001",
          state: "CHANGES_REQUESTED",
          body: "请把 X 改成 Y",
          author: { login: "carol" },
        },
      ],
      mergeCommit: null,
    }));

    await pollOne(id, "gh");

    const after = getRequirementById(id);
    expect(after?.status).toBe("fix_revision");
    expect(after?.last_reviewed_event_id).toBe("PRR_001");

    const fbs = listFeedbacks(id);
    expect(fbs.length).toBe(1);
    expect(fbs[0].source).toBe("github_review");
    expect(fbs[0].github_review_id).toBe("PRR_001");
    expect(fbs[0].body).toContain("carol");
    expect(fbs[0].body).toContain("X 改成 Y");
  });

  it("已处理过的 review id 不重复注入（去重）", async () => {
    const id = setupReqAwaitingReview(42, "PRR_005");
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        // 都 ≤ "PRR_005"，应被去重
        { id: "PRR_003", state: "CHANGES_REQUESTED", body: "old", author: { login: "x" } },
        { id: "PRR_005", state: "CHANGES_REQUESTED", body: "still old", author: { login: "y" } },
      ],
      mergeCommit: null,
    }));

    await pollOne(id, "gh");

    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("repo 缺 github_owner/repo → 跳过 + 状态不变", async () => {
    // 创建 repo-B 不填 github
    createRepo({ id: "repo-B", alias: "rB", path: "/tmp/B", default_branch: "main" });
    const id = nextRequirementId();
    createRequirement({ id, repo_id: "repo-B", title: "T" });
    setRequirementStatus(id, "clarifying");
    setRequirementStatus(id, "ready");
    setRequirementStatus(id, "queued");
    setRequirementStatus(id, "running");
    setRequirementStatus(id, "awaiting_review");
    updateRequirement(id, { pr_number: 10 });

    // mock gh 不会被调用（早 return）
    _setGhRunnerForTest(async () => {
      throw new Error("ghRunner should not be called");
    });

    await pollOne(id, "gh");

    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("混合 reviews：取新 CHANGES_REQUESTED 拼合反馈", async () => {
    const id = setupReqAwaitingReview(42, "PRR_001");
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        { id: "PRR_001", state: "APPROVED", body: "old approval", author: { login: "x" } },
        { id: "PRR_002", state: "COMMENTED", body: "minor", author: { login: "y" } },
        { id: "PRR_003", state: "CHANGES_REQUESTED", body: "改 A", author: { login: "alice" } },
        { id: "PRR_004", state: "CHANGES_REQUESTED", body: "改 B", author: { login: "bob" } },
      ],
      mergeCommit: null,
    }));

    await pollOne(id, "gh");

    const after = getRequirementById(id);
    expect(after?.status).toBe("fix_revision");
    expect(after?.last_reviewed_event_id).toBe("PRR_004");

    const fbs = listFeedbacks(id);
    expect(fbs.length).toBe(1);
    expect(fbs[0].body).toContain("alice");
    expect(fbs[0].body).toContain("bob");
    expect(fbs[0].body).toContain("改 A");
    expect(fbs[0].body).toContain("改 B");
  });

  it("gh 调用失败 → 状态不变 + 下周期重试", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: not authenticated",
    }));

    await pollOne(id, "gh");

    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });
});
