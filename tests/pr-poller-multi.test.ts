/**
 * pr-poller 多 PR 聚合（多代码库需求 = sub_prs 全集 ∪ 主 PR）。
 *
 * 覆盖：全部 merged → done；部分 open → 不动；任一新 CHANGES_REQUESTED →
 * 合并一条反馈 + 转一次 fix_revision + per-PR 水位；旧 submodule 数据与主 PR 并集去重。
 */

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
import { up as migrate038 } from "../src/migrations/038-sub-pr-review-watermark";
import { up as migrate039 } from "../src/migrations/039-sub-pr-ci-watermark";
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
import { appendSubPr, listSubPrs } from "../src/core/requirements/sub-prs";
import { pollOne, _setGhRunnerForTest, type GhRunner } from "../src/daemon/pr-poller";

describe("pr-poller 多 PR 聚合", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    [migrate001, migrate004, migrate005, migrate006, migrate007, migrate008, migrate021, migrate024, migrate033, migrate038, migrate039]
      .forEach((fn) => fn(db));
    _setDbForTest(db);
    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({
      id: "ws-be", project_id: "proj-001", alias: "backend", path: "/tmp/be",
      default_branch: "main", github_owner: "o", github_repo: "backend",
    });
    createWorkspace({
      id: "ws-fe", project_id: "proj-001", alias: "frontend", path: "/tmp/fe",
      default_branch: "main", github_owner: "o", github_repo: "frontend",
    });
  });

  afterAll(() => {
    _setGhRunnerForTest(null);
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirement_sub_prs");
    db.run("DELETE FROM requirements");
  });

  afterEach(() => {
    _setGhRunnerForTest(null);
  });

  /** 多库需求：主 PR #1（backend，已落 sub_prs）+ #2（frontend） */
  function setupMultiReq(): string {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "ws-be", title: "T" });
    for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) {
      setRequirementStatus(id, s);
    }
    updateRequirement(id, { pr_number: 1, pr_url: "https://github.com/o/backend/pull/1" });
    appendSubPr({ requirement_id: id, child_workspace_id: "ws-be", pr_url: "https://github.com/o/backend/pull/1", pr_number: 1 });
    appendSubPr({ requirement_id: id, child_workspace_id: "ws-fe", pr_url: "https://github.com/o/frontend/pull/2", pr_number: 2 });
    return id;
  }

  /** 按 repo 名路由的 gh mock：args 含 -R o/<repo> */
  function mockGhByRepo(byRepo: Record<string, unknown>): GhRunner {
    return async (args) => {
      const rIdx = args.indexOf("-R");
      const repo = rIdx >= 0 ? String(args[rIdx + 1]).split("/")[1] : "";
      const data = byRepo[repo];
      if (!data) return { exitCode: 1, stdout: "", stderr: `no mock for ${repo}` };
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: "" };
    };
  }

  it("全部 PR merged → done", async () => {
    const id = setupMultiReq();
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "MERGED", reviews: [], mergeCommit: { oid: "a" } },
      frontend: { state: "MERGED", reviews: [], mergeCommit: { oid: "b" } },
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("done");
  });

  it("一个 merged 一个 open → 维持 awaiting_review", async () => {
    const id = setupMultiReq();
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "MERGED", reviews: [], mergeCommit: { oid: "a" } },
      frontend: { state: "OPEN", reviews: [], mergeCommit: null },
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });

  it("任一 PR 新 CHANGES_REQUESTED → 合并一条反馈（带库前缀）+ fix_revision + per-PR 水位", async () => {
    const id = setupMultiReq();
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "OPEN", reviews: [], mergeCommit: null },
      frontend: {
        state: "OPEN",
        reviews: [{ id: "R10", state: "CHANGES_REQUESTED", body: "前端组件缺空态", author: { login: "alice" } }],
        mergeCommit: null,
      },
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("fix_revision");
    const fbs = listFeedbacks(id);
    expect(fbs.length).toBe(1);
    expect(fbs[0].body).toContain("[frontend]");
    expect(fbs[0].body).toContain("前端组件缺空态");
    // per-PR 水位：frontend 行写了 R10，backend 行不动
    const subs = listSubPrs(id);
    expect(subs.find((s) => s.child_workspace_id === "ws-fe")?.last_reviewed_event_id).toBe("R10");
    expect(subs.find((s) => s.child_workspace_id === "ws-be")?.last_reviewed_event_id ?? null).toBeNull();
    // 同一 review 再轮询不重复注入（水位去重）；fix_revision ⇄ awaiting_review 直接回
    setRequirementStatus(id, "awaiting_review");
    await pollOne(id, "gh");
    expect(listFeedbacks(id).length).toBe(1);
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });

  it("CI 失败 → 注入反馈 + fix_revision + per-PR SHA 水位与计数；同 SHA 不重复触发", async () => {
    const id = setupMultiReq();
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "aaa111", statusCheckRollup: [] },
      frontend: {
        state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "bbb222",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/run/1" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("fix_revision");
    const fbs = listFeedbacks(id);
    expect(fbs.length).toBe(1);
    expect(fbs[0].body).toContain("[frontend]");
    expect(fbs[0].body).toContain("CI 检查失败");
    expect(fbs[0].body).toContain("test（https://ci/run/1）");
    const sub = listSubPrs(id).find((s) => s.child_workspace_id === "ws-fe");
    expect(sub?.ci_failed_head_sha).toBe("bbb222");
    expect(sub?.ci_fix_count).toBe(1);
    // 同一 head SHA 再轮询不重复触发
    setRequirementStatus(id, "awaiting_review");
    await pollOne(id, "gh");
    expect(listFeedbacks(id).length).toBe(1);
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });

  it("checks 未跑完（pending）不触发 CI 回路", async () => {
    const id = setupMultiReq();
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "aaa", statusCheckRollup: [] },
      frontend: {
        state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "bbb",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
        ],
      },
    }));
    await pollOne(id, "gh");
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
  });

  it("CI 自动修复触顶（ci_fix_count >= 上限）→ 停下报人，不再转 fix_revision，但记 SHA 防重复", async () => {
    const id = setupMultiReq();
    // 预置：frontend PR 已自动修过 2 次
    db.run(
      "UPDATE requirement_sub_prs SET ci_fix_count = 2, ci_failed_head_sha = 'old-sha' WHERE requirement_id = ? AND child_workspace_id = 'ws-fe'",
      [id],
    );
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "aaa", statusCheckRollup: [] },
      frontend: {
        state: "OPEN", reviews: [], mergeCommit: null, headRefOid: "new-sha",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      },
    }));
    await pollOne(id, "gh");
    // 不自动修：维持 awaiting_review、不注入反馈
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(listFeedbacks(id).length).toBe(0);
    // 但 SHA 写入（同一失败不重复报人）、计数不再涨
    const sub = listSubPrs(id).find((s) => s.child_workspace_id === "ws-fe");
    expect(sub?.ci_failed_head_sha).toBe("new-sha");
    expect(sub?.ci_fix_count).toBe(2);
  });

  it("兼容旧 submodule 数据：主 PR 不在 sub_prs 时并入跟踪集（按 pr_number 去重）", async () => {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", workspace_id: "ws-be", title: "T" });
    for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) {
      setRequirementStatus(id, s);
    }
    updateRequirement(id, { pr_number: 1, pr_url: "https://github.com/o/backend/pull/1" });
    // 只有 submodule 的 sub_pr（#2），主 PR #1 不在表里
    appendSubPr({ requirement_id: id, child_workspace_id: "ws-fe", pr_url: "https://github.com/o/frontend/pull/2", pr_number: 2 });
    _setGhRunnerForTest(mockGhByRepo({
      backend: { state: "OPEN", reviews: [], mergeCommit: null },   // 主 PR 还 open
      frontend: { state: "MERGED", reviews: [], mergeCommit: { oid: "b" } },
    }));
    await pollOne(id, "gh");
    // 主 PR 在跟踪集内（未全 merged）→ 不能 done
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });
});
