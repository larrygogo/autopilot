import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate026 } from "../src/migrations/026-requirement-schedule-error";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { up as migrate044 } from "../src/migrations/044-task-run-columns";
import { _setDbForTest } from "../src/core/db";
import type { Task } from "../src/core/db";
import { createWorkspace } from "../src/core/workspaces";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  nextRequirementId,
} from "../src/core/requirements";
import { tick, _setTaskStartersForTest } from "../src/daemon/requirement-scheduler";

// 注：原「同仓库串行 / 组级锁（父 + 子模块同组）」用例已删除——调度已改为
// 纯全局上限 FIFO（每任务独立 clone 沙盒，仓库不再是冲突域），不再有
// tickRepo / tickGroup / groupId 概念。

/** 把需求推到目标状态 */
function pushTo(id: string, target: "queued" | "running" | "fix_revision" | "awaiting_review") {
  const steps: Record<string, string[]> = {
    queued: ["clarifying", "ready", "queued"],
    running: ["clarifying", "ready", "queued", "running"],
    awaiting_review: ["clarifying", "ready", "queued", "running", "awaiting_review"],
    fix_revision: ["clarifying", "ready", "queued", "running", "awaiting_review", "fix_revision"],
  };
  for (const s of steps[target]) setRequirementStatus(id, s);
}

/** 测试 seam：mock 起任务成功（记录调用顺序，不真 clone / 跑 agent） */
function mockStartOk(calls: string[]) {
  _setTaskStartersForTest({
    startTaskFromTemplate: async (opts) => {
      const reqId = String(opts.requirement_id);
      calls.push(reqId);
      return { id: `tsk-${reqId}` } as unknown as Task;
    },
  });
}

describe("tick 全局并发上限（基础语义）", () => {
  let db: Database;
  let tmpCfgDir: string;

  beforeAll(() => {
    // 隔离 scheduler 配置：不设的话 loadSchedulerConfig 会读真实用户 config.yaml，
    // max_concurrent_tasks > 1 时 N=1 语义的用例全部失真
    tmpCfgDir = join(tmpdir(), `ap-sched-basic-${Date.now()}`);
    mkdirSync(tmpCfgDir, { recursive: true });
    const tmpCfgFile = join(tmpCfgDir, "config.yaml");
    writeFileSync(tmpCfgFile, "", "utf-8"); // 空配置 = 默认 N=1
    process.env.DEV_WORKFLOW_CONFIG = tmpCfgFile;

    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate009(db);
    migrate021(db);
    migrate024(db);
    migrate026(db);
    migrate033(db);
    migrate044(db);
    _setDbForTest(db);
    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "r1", path: "/tmp/r1", default_branch: "main" });
    createWorkspace({ id: "cb-002", project_id: "proj-001", alias: "r2", path: "/tmp/r2", default_branch: "main" });
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    if (existsSync(tmpCfgDir)) rmSync(tmpCfgDir, { recursive: true, force: true });
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirement_workspaces");
    db.run("DELETE FROM requirements");
  });

  afterEach(() => {
    _setTaskStartersForTest(null);
  });

  it("有 running 需求时不拉新（N=1 默认，全局上限——跨 workspace 也阻塞）", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    pushTo(idA, "running"); // 模拟正在跑

    // 不同 workspace 上的 queued —— 旧模型互不阻塞，新模型受全局上限约束
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-001", workspace_id: "cb-002", title: "B" });
    pushTo(idB, "queued");

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([]); // 不应尝试起任务
    expect(getRequirementById(idA)?.status).toBe("running");
    expect(getRequirementById(idB)?.status).toBe("queued"); // 仍 queued
  });

  it("awaiting_review 不算占用槽位（释放后 queued 被调度）", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    pushTo(idA, "awaiting_review");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-001", workspace_id: "cb-002", title: "B" });
    pushTo(idB, "queued");

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([idB]);
    expect(getRequirementById(idB)?.status).toBe("running");
  });

  it("fix_revision 算占用槽位", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-001", workspace_id: "cb-001", title: "A" });
    pushTo(idA, "fix_revision");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-001", workspace_id: "cb-002", title: "B" });
    pushTo(idB, "queued");

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([]);
    expect(getRequirementById(idB)?.status).toBe("queued");
  });

  it("workspace_id = null 的需求处于 running 也计入全局 active（不再按列过滤）", async () => {
    // 旧模型把 workspace_id IS NULL 的 running 排除在 active 之外；
    // 纯全局上限下一切 running|fix_revision 都占槽。
    db.run(`
      INSERT INTO requirements (id, title, status, project_id, workspace_id, created_at, updated_at)
      VALUES ('req-null-ws', 'null ws req', 'running', 'proj-001', NULL, 0, 0)
    `);

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-001", workspace_id: "cb-001", title: "B" });
    pushTo(idB, "queued");

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([]);
    expect(getRequirementById(idB)?.status).toBe("queued");
  });

  it("无库需求（集合为空）可被调度：起任务成功 → running", async () => {
    // proj-001 下有 2 个 workspace，不触发 createRequirement 的单库自动派生
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", title: "no-ws" });
    expect(getRequirementById(id)?.workspace_id).toBeNull();
    pushTo(id, "queued");

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([id]); // 没有被「无库守卫」静默跳过
    expect(getRequirementById(id)?.status).toBe("running");
  });

  it("无库需求起任务失败 → 回滚 ready + schedule_error 可见（不静默卡 queued）", async () => {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-001", title: "no-ws-fail" });
    pushTo(id, "queued");

    _setTaskStartersForTest({
      startTaskFromTemplate: async () => {
        throw new Error("sandbox 建立失败（无代码库）");
      },
    });
    await tick();

    const req = getRequirementById(id);
    expect(req?.status).toBe("ready");
    expect(req?.schedule_error).toContain("sandbox 建立失败");
  });
});
