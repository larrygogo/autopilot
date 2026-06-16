import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
import { up as migrate046 } from "../src/migrations/046-requirement-deliveries";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { listFeedbacks } from "../src/core/requirements/feedbacks";
import { pollOne, _setGhRunnerForTest, defaultGhRunner, type GhRunner } from "../src/daemon/pr-poller";

describe("pr-poller pollOne", () => {
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
    migrate046(db);
    _setDbForTest(db);
    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({
      id: "cb-A",
      project_id: "proj-001",
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
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
    db.run("DELETE FROM requirement_deliveries");
  });

  afterEach(() => {
    _setGhRunnerForTest(null); // 恢复
  });

  // 辅助：把需求快速推到 awaiting_review，并设 pr_number
  function setupReqAwaitingReview(prNumber = 42, lastReviewId: string | null = null): string {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "cb-A", title: "T" });
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

  it("artifacts 交付（有 deliveries 无 PR）→ 静默 skip：不调 gh、状态不变（v2 R5）", async () => {
    const id = setupReqAwaitingReview();
    updateRequirement(id, { pr_number: null, pr_url: null }); // 无可跟踪 PR
    db.run(
      "INSERT INTO requirement_deliveries (id, requirement_id, task_id, round, path, summary, created_at) VALUES (?, ?, NULL, 1, 'deliveries/round-1', NULL, ?)",
      ["dlv-poller-1", id, Date.now()],
    );
    let ghCalled = 0;
    _setGhRunnerForTest(async () => {
      ghCalled++;
      return { exitCode: 1, stdout: "", stderr: "不应被调用" };
    });

    await pollOne(id, "gh");

    expect(ghCalled).toBe(0);
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

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
    // 创建 cb-B 不填 github
    createWorkspace({ id: "cb-B", project_id: "proj-001", alias: "rB", path: "/tmp/B", default_branch: "main" });
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "cb-B", title: "T" });
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

  it("requirement 不存在 → 静默 no-op，不调 gh", async () => {
    let called = 0;
    _setGhRunnerForTest(async () => {
      called++;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    await pollOne("nonexistent-req", "gh");
    expect(called).toBe(0);
  });

  it("requirement 状态非 awaiting_review → 跳过不调 gh", async () => {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "cb-A", title: "T" });
    setRequirementStatus(id, "clarifying"); // 不在 awaiting_review
    let called = 0;
    _setGhRunnerForTest(async () => {
      called++;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    await pollOne(id, "gh");
    expect(called).toBe(0);
    expect(getRequirementById(id)?.status).toBe("clarifying");
  });

  it("requirement 无 pr_number → 跳过不调 gh（典型：尚未跑到 submit_pr）", async () => {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "cb-A", title: "T" });
    setRequirementStatus(id, "clarifying");
    setRequirementStatus(id, "ready");
    setRequirementStatus(id, "queued");
    setRequirementStatus(id, "running");
    setRequirementStatus(id, "awaiting_review");
    // 故意不 set pr_number
    let called = 0;
    _setGhRunnerForTest(async () => {
      called++;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    await pollOne(id, "gh");
    expect(called).toBe(0);
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });

  it("gh 返回非法 JSON → 视为失败下周期重试，状态不变", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(async () => ({
      exitCode: 0,
      stdout: "not valid json {{{",
      stderr: "",
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("PR APPROVED 但未 merged → 不触发任何动作（仍 awaiting）", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        { id: "rev-approved-1", state: "APPROVED", body: "looks good", author: { login: "alice" } },
      ],
      mergeCommit: null,
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("PR COMMENTED （非 changes_requested）→ 不触发 fix_revision", async () => {
    const id = setupReqAwaitingReview();
    _setGhRunnerForTest(mockGh({
      state: "OPEN",
      reviews: [
        { id: "rev-cm-1", state: "COMMENTED", body: "btw, nice", author: { login: "bob" } },
      ],
      mergeCommit: null,
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("rank19：gh await 期间状态被抢先转走 → 本轮放弃注入（不写 comment / 不前移水位）", async () => {
    const id = setupReqAwaitingReview(42, null); // awaiting_review，无水位
    // mock gh runner：返回带 CHANGES_REQUESTED 的 PR，但在 await 内把需求抢先转走（模拟人工 reject）
    _setGhRunnerForTest(async () => {
      setRequirementStatus(id, "fix_revision");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          reviews: [{ id: "rev-x1", state: "CHANGES_REQUESTED", body: "改这里", author: { login: "a" } }],
          mergeCommit: null,
        }),
        stderr: "",
      };
    });

    await pollOne(id, "gh");

    // 旧实现会 createComment + 前移水位（last_reviewed_event_id=rev-x1）后 setStatus 撞 cur===to 早返回；
    // 新实现写回前复核状态已变 → 整体放弃。
    expect(getRequirementById(id)?.status).toBe("fix_revision"); // 保持被抢先转走的状态
    expect(listFeedbacks(id).length).toBe(0); // 未注入反馈
    expect(getRequirementById(id)?.last_reviewed_event_id ?? null).toBe(null); // 水位未前移，下轮可重处理 rev-x1
  });
});

describe("defaultGhRunner gh 缺失降级（rank24）", () => {
  it("gh 二进制不存在 → 返回结构化 exit 127 而非抛 ENOENT（走 ghPrView null 降级）", async () => {
    // 用一个绝不存在的二进制名触发 Bun.spawn 同步 ENOENT；不应冒泡，应降级成 {exitCode:127}
    const res = await defaultGhRunner(["autopilot-no-such-binary-xyz-9f3", "--version"]);
    expect(res.exitCode).toBe(127);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0); // 携带原始错误信息供诊断
  });
});
