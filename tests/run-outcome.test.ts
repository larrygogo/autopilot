/**
 * reportRunOutcome 单口回归（需求中心架构 v2 R1）。
 * 覆盖：各 outcome kind 的需求状态写入、delivered 的 hasPr 两分支（主 PR / sub_prs）、
 *       终态 reason/reasonSource 落库、非法转换跳过、评审遗留沉淀为需求评论、防御路径。
 * 行为基线 = 收口前 requirement-task-bridge 的同步逻辑（行为零变化）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate010 } from "../src/migrations/010-question-suggestions";
import { up as migrate018 } from "../src/migrations/018-task-phase-events";
import { up as migrate019 } from "../src/migrations/019-task-requirement-id";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate028 } from "../src/migrations/028-requirement-status-reason";
import { up as migrate029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as migrate030 } from "../src/migrations/030-requirement-status-logs";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { up as migrate044 } from "../src/migrations/044-task-run-columns";
import { up as migrate045 } from "../src/migrations/045-requirement-input-mode";
import { up as migrate046 } from "../src/migrations/046-requirement-deliveries";
import { _setDbForTest, createTask } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { listComments } from "../src/core/requirements/comments";
import { appendSubPr } from "../src/core/requirements/sub-prs";
import { reportRunOutcome } from "../src/daemon/run-outcome";
import { _releaseAllLocks } from "../src/core/infra";

let db: Database;
let tmpHome: string;

const ALL_MIGRATIONS = [
  migrate001, migrate002, migrate004, migrate005, migrate006, migrate007,
  migrate008, migrate009, migrate010, migrate018, migrate019, migrate021,
  migrate024, migrate028, migrate029, migrate030, migrate033, migrate044,
  migrate045, migrate046];

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-runoutcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of ALL_MIGRATIONS) m(db);
  _setDbForTest(db);
});

afterEach(() => {
  _releaseAllLocks();
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

let seq = 0;

function makeRequirement(status: string, opts?: { withTask?: boolean; taskExtra?: Record<string, unknown> }): {
  reqId: string;
  runId: string;
} {
  seq += 1;
  const pid = `proj-ro${seq}`;
  createProject({ id: pid, name: "p" });
  createWorkspace({ id: `ws-ro${seq}`, project_id: pid, alias: "r", path: "/tmp/r", default_branch: "main" });
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: pid, workspace_id: `ws-ro${seq}`, title: "T" });
  const path: Record<string, string[]> = {
    running: ["clarifying", "ready", "queued", "running"],
    awaiting_review: ["clarifying", "ready", "queued", "running", "awaiting_review"],
    drafting: [],
  };
  for (const s of path[status] ?? []) setRequirementStatus(reqId, s);
  const runId = `tk-ro${String(seq).padStart(2, "0")}`;
  if (opts?.withTask !== false) {
    createTask({
      id: runId, title: "T", workflow: "dev", initialStatus: "running_design",
      requirementId: reqId, extra: opts?.taskExtra,
    });
    updateRequirement(reqId, { task_id: runId });
  }
  return { reqId, runId };
}

describe("reportRunOutcome：delivered 的去向取决于交付 PR（req-018 验收死路基线）", () => {
  it("有主 PR → awaiting_review（验收，交 pr-poller 判 merge）", () => {
    const { reqId, runId } = makeRequirement("running");
    updateRequirement(reqId, { pr_number: 93, pr_url: "https://github.com/o/r/pull/93" });

    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });

  it("无主 PR 但 sub_prs 有交付 → awaiting_review（多库需求）", () => {
    const { reqId, runId } = makeRequirement("running");
    appendSubPr({
      requirement_id: reqId, child_workspace_id: `ws-ro${seq}`,
      pr_url: "https://github.com/o/r/pull/7", pr_number: 7,
    });

    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });

  it("无任何交付 PR → done（纯 adhoc 无交付物）", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(getRequirementById(reqId)!.status).toBe("done");
  });

  it("无 PR 但有 deliveries（artifacts 交付，v2 R5）→ awaiting_review（人工验收）", () => {
    const { reqId, runId } = makeRequirement("running");
    db.run(
      "INSERT INTO requirement_deliveries (id, requirement_id, task_id, round, path, summary, created_at) VALUES (?, ?, ?, 1, 'deliveries/round-1', NULL, ?)",
      ["dlv-001", reqId, runId, Date.now()],
    );
    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });

  it("hasPr 优先于 deliveries（混合交付不支持，PR 赢）：两者都有 → awaiting_review 由 PR 验收管", () => {
    const { reqId, runId } = makeRequirement("running");
    updateRequirement(reqId, { pr_number: 11, pr_url: "https://github.com/o/r/pull/11" });
    db.run(
      "INSERT INTO requirement_deliveries (id, requirement_id, task_id, round, path, summary, created_at) VALUES (?, ?, ?, 1, 'deliveries/round-1', NULL, ?)",
      ["dlv-002", reqId, runId, Date.now()],
    );
    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });
});

describe("reportRunOutcome：非终态委托路径", () => {
  it("awaiting_human → awaiting_review（带 await_review phase 的旧 workflow）", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "awaiting_human" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });

  it("fixing → fix_revision（从 awaiting_review 出发）", () => {
    const { reqId, runId } = makeRequirement("awaiting_review");
    reportRunOutcome(reqId, runId, { kind: "fixing" });
    expect(getRequirementById(reqId)!.status).toBe("fix_revision");
  });

  it("fixed → awaiting_review（fix run 修复完成回验收，v2 R3）", () => {
    const { reqId, runId } = makeRequirement("awaiting_review");
    setRequirementStatus(reqId, "fix_revision");
    reportRunOutcome(reqId, runId, { kind: "fixed" });
    expect(getRequirementById(reqId)!.status).toBe("awaiting_review");
  });

  it("fixed 从非法出发态（drafting）→ 静默跳过", () => {
    const { reqId, runId } = makeRequirement("drafting");
    expect(() => reportRunOutcome(reqId, runId, { kind: "fixed" })).not.toThrow();
    expect(getRequirementById(reqId)!.status).toBe("drafting");
  });

  it("非终态汇报不写 reason 列", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "awaiting_human" });
    const r = getRequirementById(reqId)!;
    expect(r.status_reason).toBe(null);
    expect(r.status_reason_source).toBe(null);
  });
});

describe("reportRunOutcome：终态 reason / reasonSource 落库", () => {
  it("failed 带 reason + source=task", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "failed", reason: "develop 阶段崩溃", reasonSource: "task" });
    const r = getRequirementById(reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toBe("develop 阶段崩溃");
    expect(r.status_reason_source).toBe("task");
  });

  it("cancelled 带 user 来源（翻译层映射后的手动取消）", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "cancelled", reason: "任务被手动取消", reasonSource: "user" });
    const r = getRequirementById(reqId)!;
    expect(r.status).toBe("cancelled");
    expect(r.status_reason).toBe("任务被手动取消");
    expect(r.status_reason_source).toBe("user");
  });

  it("reasonSource 缺省回落 task", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "failed", reason: "x" });
    expect(getRequirementById(reqId)!.status_reason_source).toBe("task");
  });
});

describe("reportRunOutcome：防御路径（静默跳过，不抛出）", () => {
  it("非法转换跳过：drafting 不接受 fixing 汇报", () => {
    const { reqId, runId } = makeRequirement("drafting");
    expect(() => reportRunOutcome(reqId, runId, { kind: "fixing" })).not.toThrow();
    expect(getRequirementById(reqId)!.status).toBe("drafting");
  });

  it("目标状态与当前相同时 no-op（不重复写终态原因）", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "failed", reason: "第一次" });
    reportRunOutcome(reqId, runId, { kind: "failed", reason: "第二次" });
    const r = getRequirementById(reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toBe("第一次");
  });

  it("需求不存在时不抛出", () => {
    expect(() => reportRunOutcome("req-nope", "tk-nope", { kind: "delivered" })).not.toThrow();
  });
});

describe("reportRunOutcome：评审遗留沉淀（防撞墙-失忆-重撞）", () => {
  it("终态 + task 有 rejection_reason → 写成需求评论（kind=feedback, from_role=agent）", () => {
    const { reqId, runId } = makeRequirement("running", {
      taskExtra: { rejection_reason: "这是第三次提交空 diff" },
    });
    reportRunOutcome(reqId, runId, {
      kind: "cancelled", reason: "代码审查驳回 3 次，已取消",
      reasonSource: "task", note: "代码审查驳回 3 次，已取消",
    });

    const comments = listComments(reqId, { kind: "feedback" });
    expect(comments.length).toBe(1);
    expect(comments[0].from_role).toBe("agent");
    expect(comments[0].body).toContain(`【执行评审遗留 · task ${runId}】代码审查驳回 3 次，已取消`);
    expect(comments[0].body).toContain("这是第三次提交空 diff");
  });

  it("终态但 task 无 rejection_reason → 不沉淀评论", () => {
    const { reqId, runId } = makeRequirement("running");
    reportRunOutcome(reqId, runId, { kind: "failed", reason: "崩了" });
    expect(listComments(reqId, { kind: "feedback" }).length).toBe(0);
  });

  it("非终态（delivered）不触发沉淀", () => {
    const { reqId, runId } = makeRequirement("running", {
      taskExtra: { rejection_reason: "上轮驳回残留" },
    });
    reportRunOutcome(reqId, runId, { kind: "delivered" });
    expect(listComments(reqId, { kind: "feedback" }).length).toBe(0);
  });
});
