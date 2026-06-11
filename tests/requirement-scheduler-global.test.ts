import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
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

/** 把需求推到目标状态 */
function pushTo(id: string, target: "queued" | "running") {
  const steps: Record<string, string[]> = {
    queued: ["clarifying", "ready", "queued"],
    running: ["clarifying", "ready", "queued", "running"],
  };
  for (const s of steps[target]) setRequirementStatus(id, s);
}

describe("tickRepo 全局并发上限", () => {
  let db: Database;
  let tmpCfgDir: string;
  let tmpCfgFile: string;

  beforeAll(() => {
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
    _setDbForTest(db);
    createProject({ id: "proj-global", name: "global-test-proj" });
    // 三个独立 workspace（无 remote_url → startTaskFromTemplate 失败→ rollback "ready"）
    createWorkspace({ id: "ws-g1", project_id: "proj-global", alias: "g1", path: "/tmp/g1", default_branch: "main" });
    createWorkspace({ id: "ws-g2", project_id: "proj-global", alias: "g2", path: "/tmp/g2", default_branch: "main" });
    createWorkspace({ id: "ws-g3", project_id: "proj-global", alias: "g3", path: "/tmp/g3", default_branch: "main" });

    tmpCfgDir = join(tmpdir(), `ap-sched-global-${Date.now()}`);
    mkdirSync(tmpCfgDir, { recursive: true });
    tmpCfgFile = join(tmpCfgDir, "config.yaml");
    writeFileSync(tmpCfgFile, "", "utf-8");
    process.env.DEV_WORKFLOW_CONFIG = tmpCfgFile;
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    if (existsSync(tmpCfgDir)) rmSync(tmpCfgDir, { recursive: true, force: true });
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    writeFileSync(tmpCfgFile, "", "utf-8"); // 重置 max=1（默认）
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  // ──────── 基础阻塞行为 ────────

  it("N=1（默认）：ws-g1 有 running，ws-g2 的 queued 被全局上限阻塞", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running"); // 手动设 running 占位

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g2");

    // globalActive=1 >= N=1 → tickGroup 提前返回，idB 保持 queued
    expect(getRequirementById(idB)?.status).toBe("queued");
  });

  it("N=2：1 个 running 时不阻塞另一 workspace（调度器尝试启动，startTaskFromTemplate 失败回滚 → ready）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g2");

    // globalActive=1 < N=2 → 调度器尝试启动 ws-g2 的任务。
    // 测试环境无真实 workflow/remote_url，startTaskFromTemplate 抛错 →
    // tickGroup error handler 回滚：status = "ready"，schedule_error 写入。
    // "ready"（而非 "queued"）证明没被全局上限拦截。
    const req = getRequirementById(idB);
    expect(req?.status).toBe("ready");
    expect(req?.schedule_error).toBeTruthy();
  });

  it("N=2：2 个 running 时阻塞第 3 个（status 保持 queued）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "running");

    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");

    await tickRepo("ws-g3");

    // globalActive=2 >= N=2 → 调度器提前返回，idC 保持 queued
    expect(getRequirementById(idC)?.status).toBe("queued");
  });

  it("workspace_id = null 的高层需求不计入全局 active", async () => {
    // 直接写 DB：模拟 workspace_id=null 的需求处于 running 状态
    // （正常流程不会发生，但需要守卫防止未来意外影响调度）
    db.run(`
      INSERT INTO requirements (id, title, status, project_id, workspace_id, created_at, updated_at)
      VALUES ('req-null-ws', 'null ws req', 'running', 'proj-global', NULL, 0, 0)
    `);

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g1", title: "B" });
    pushTo(idB, "queued");

    await tickRepo("ws-g1");

    // workspace_id=null 的 running 不占槽位，ws-g1 的 queued 应被调度尝试
    // startTaskFromTemplate 失败 → "ready"（不应该是 "queued"）
    expect(getRequirementById(idB)?.status).not.toBe("queued");
    expect(getRequirementById(idB)?.status).toBe("ready");
  });

  // ──────── TOCTOU 全局锁：pending queue 不丢失 ────────

  it("全局锁：并发 tickRepo 时，被锁阻塞的 tick 进入 pending，锁释放后自动重试（不永久丢失）", async () => {
    // 两个 workspace 各有 queued 需求，无 running（N=1）
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g1", title: "B" });
    pushTo(idB, "queued");

    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g2", title: "C" });
    pushTo(idC, "queued");

    // 同时发起两个 tick（Promise.all 让两个调用"同时"进入 tickRepo）
    // 期望：
    //   - ws-g1 的 tick 先获取全局锁，尝试 startTaskFromTemplate → 失败 → "ready"
    //   - ws-g2 的 tick 发现锁被占用，加入 _pendingTicks 后立即 resolve
    //   - ws-g1 tick 完成后，drain 异步触发 ws-g2 的 tick
    //   - ws-g2 tick 也尝试 startTaskFromTemplate → 失败 → "ready"
    await Promise.all([tickRepo("ws-g1"), tickRepo("ws-g2")]);

    // 等待 drain 链完成：ws-g2 的 tick 通过微任务触发，整个 tick 是 async 的。
    // 轮询最多 500ms（实测通常 < 50ms）
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (getRequirementById(idC)?.status !== "queued") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // 两个需求都不应停留在 "queued"（均被调度器处理过，失败后回滚 → "ready"）
    // 关键断言：ws-g2 的需求最终脱离了 "queued"，证明 pending queue 没有丢失它
    expect(getRequirementById(idB)?.status).not.toBe("queued");
    expect(getRequirementById(idC)?.status).not.toBe("queued");
  });

  it("全局计数在 N 上限满时不超量（running 数 ≤ N）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    // 已有 2 running
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "running");

    // 第 3 个试图入队
    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");

    await tickRepo("ws-g3");

    // 调度器看到 2 running >= N=2，不尝试启动
    const allActive = listRequirements({}).filter(
      (r) => r.workspace_id !== null && (r.status === "running" || r.status === "fix_revision"),
    );
    expect(allActive.length).toBeLessThanOrEqual(2); // 不超量
    expect(getRequirementById(idC)?.status).toBe("queued"); // 第 3 个被阻塞
  });
});
