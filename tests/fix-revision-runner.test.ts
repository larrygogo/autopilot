/**
 * fix-revision-runner：fix_revision 修复执行器（方案 B）。
 *
 * 覆盖：修复成功 → 转回 awaiting_review；agent 失败 → failed + 原因；
 * 无 task / 无沙盒布局 → failed；inflight 防重；prompt 含反馈与仓库布局。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate028 } from "../src/migrations/028-requirement-status-reason";
import { up as migrate029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as migrate030 } from "../src/migrations/030-requirement-status-logs";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { up as migrate038 } from "../src/migrations/038-sub-pr-review-watermark";
import { up as migrate039 } from "../src/migrations/039-sub-pr-ci-watermark";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { appendFeedback, listFeedbacks } from "../src/core/requirement-feedbacks";
import type { TaskRepoCtx } from "../src/core/sandbox";
import {
  runFixRevision,
  _setFixFnForTest,
  _setListReposForTest,
  _resetFixInflightForTest,
} from "../src/daemon/fix-revision-runner";
import { _resetFixProgressForTest } from "../src/daemon/fix-progress";

let db: Database;
let tmpRepo: string;

const MIGRATIONS = [
  migrate001, migrate004, migrate005, migrate006, migrate007, migrate008,
  migrate021, migrate024, migrate028, migrate029, migrate030, migrate033, migrate038, migrate039,
];

beforeEach(() => {
  db = new Database(":memory:");
  for (const m of MIGRATIONS) m(db);
  _setDbForTest(db);
  createProject({ id: "proj-fx1", name: "p" });
  createWorkspace({ id: "ws-fx1", project_id: "proj-fx1", alias: "app", path: "/tmp/app", default_branch: "main" });
  tmpRepo = join(tmpdir(), `autopilot-fxr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRepo, { recursive: true });
});

afterEach(() => {
  _setFixFnForTest(null);
  _setListReposForTest(null);
  _resetFixInflightForTest();
  _resetFixProgressForTest();
  _setDbForTest(null);
  db.close();
  if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true });
});

function makeFixRevisionReq(opts?: { taskId?: string | null }): string {
  const id = nextRequirementId();
  createRequirement({ id, project_id: "proj-fx1", workspace_id: "ws-fx1", title: "修这个" });
  for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review", "fix_revision"]) {
    setRequirementStatus(id, s);
  }
  if (opts?.taskId !== null) {
    updateRequirement(id, { task_id: opts?.taskId ?? "tk-fxr001", pr_number: 7, pr_url: "https://github.com/o/r/pull/7" });
  }
  return id;
}

function fakeRepos(): TaskRepoCtx[] {
  return [{
    workspace_id: "ws-fx1", alias: "app", path: tmpRepo, dir: "",
    branch: "feat/x", base: "main", remote_url: "https://github.com/o/r.git", primary: true,
  }];
}

describe("fix-revision-runner", () => {
  it("修复成功 → 需求转回 awaiting_review；prompt 含反馈正文与仓库布局", async () => {
    const id = makeFixRevisionReq();
    appendFeedback({ requirement_id: id, source: "manual", body: "按钮文案要改成保存" });
    _setListReposForTest(fakeRepos);
    let seenPrompt = "";
    let seenCwd = "";
    _setFixFnForTest(async (prompt, cwd) => {
      seenPrompt = prompt;
      seenCwd = cwd;
      return "已修复并 push";
    });

    await runFixRevision(id);

    expect(getRequirementById(id)?.status).toBe("awaiting_review");
    expect(seenPrompt).toContain("按钮文案要改成保存");
    expect(seenPrompt).toContain("feat/x");
    expect(seenPrompt).toContain("#7");
    expect(seenCwd).toBe(tmpRepo);
    // 产出可见性：agent 总结落需求反馈（from_role=agent，UI 显示「Agent 修复」）
    const fbs = listFeedbacks(id);
    const agentFb = fbs.find((f) => f.from_role === "agent");
    expect(agentFb?.body).toContain("修复完成");
    expect(agentFb?.body).toContain("已修复并 push");
  });

  it("agent 执行失败 → 需求 failed + status_reason 带原因（停下报人）", async () => {
    const id = makeFixRevisionReq();
    _setListReposForTest(fakeRepos);
    _setFixFnForTest(async () => { throw new Error("agent 崩了"); });

    await runFixRevision(id);

    const r = getRequirementById(id)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toContain("修复执行失败");
    expect(r.status_reason).toContain("agent 崩了");
  });

  it("无关联 task → failed（没有可修复的交付沙盒）", async () => {
    const id = makeFixRevisionReq({ taskId: null });
    _setFixFnForTest(async () => "不该被调");

    await runFixRevision(id);

    expect(getRequirementById(id)?.status).toBe("failed");
  });

  it("沙盒布局缺失（listTaskRepos 空）→ failed", async () => {
    const id = makeFixRevisionReq();
    _setListReposForTest(() => []);
    _setFixFnForTest(async () => "不该被调");

    await runFixRevision(id);

    expect(getRequirementById(id)?.status).toBe("failed");
  });

  it("修复期间需求被取消 → 不写回 awaiting_review", async () => {
    const id = makeFixRevisionReq();
    _setListReposForTest(fakeRepos);
    _setFixFnForTest(async () => {
      setRequirementStatus(id, "cancelled"); // 模拟用户在修复中取消
      return "修完了但已取消";
    });

    await runFixRevision(id);

    expect(getRequirementById(id)?.status).toBe("cancelled");
  });

  it("inflight 防重：同需求并发触发只跑一次", async () => {
    const id = makeFixRevisionReq();
    _setListReposForTest(fakeRepos);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    _setFixFnForTest(async () => {
      calls++;
      await gate;
      return "ok";
    });

    const p1 = runFixRevision(id);
    const p2 = runFixRevision(id); // 第二次应被锁拒掉
    release();
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(getRequirementById(id)?.status).toBe("awaiting_review");
  });
});
