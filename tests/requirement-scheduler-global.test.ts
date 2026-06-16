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
import { _setDbForTest } from "../src/core/db";
import type { Task } from "../src/core/db";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  nextRequirementId,
  listRequirements,
} from "../src/core/requirements";
import {
  tick,
  initRequirementScheduler,
  disposeRequirementScheduler,
  _setTaskStartersForTest,
} from "../src/daemon/requirement-scheduler";

/** 把需求推到目标状态 */
function pushTo(id: string, target: "queued" | "running") {
  const steps: Record<string, string[]> = {
    queued: ["clarifying", "ready", "queued"],
    running: ["clarifying", "ready", "queued", "running"],
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

/** 轮询等待条件成立（drain / 启动补 tick 是异步触发的） */
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("tick 全局并发上限 FIFO", () => {
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
    // 三个独立 workspace（无 remote_url → 真实 startTaskFromTemplate 失败 → rollback "ready"）
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
    db.run("DELETE FROM requirement_workspaces");
    db.run("DELETE FROM requirements");
  });

  afterEach(() => {
    disposeRequirementScheduler();
    _setTaskStartersForTest(null);
  });

  // ──────── 基础阻塞行为（真实 startTaskFromTemplate 失败路径，不用 seam）────────

  it("N=1（默认）：ws-g1 有 running，ws-g2 的 queued 被全局上限阻塞", async () => {
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running"); // 手动设 running 占位

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tick();

    // active=1 >= N=1 → tickBody 提前返回，idB 保持 queued
    expect(getRequirementById(idB)?.status).toBe("queued");
  });

  it("N=2：1 个 running 时不阻塞下一个 queued（调度器尝试启动，startTaskFromTemplate 真实失败回滚 → ready）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "running");

    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");

    await tick();

    // active=1 < N=2 → 调度器尝试启动 idB。
    // 测试环境无真实 workflow/remote_url，startTaskFromTemplate 抛错 →
    // 失败回滚：status = "ready"，schedule_error 写入。
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

    await tick();

    // active=2 >= N=2 → 调度器提前返回，idC 保持 queued
    expect(getRequirementById(idC)?.status).toBe("queued");
    const allActive = listRequirements({}).filter(
      (r) => r.status === "running" || r.status === "fix_revision",
    );
    expect(allActive.length).toBeLessThanOrEqual(2); // 不超量
  });

  it("rank14：scheduleOne await 期间他方转入 fix_revision（占用方向）→ 每迭代重算 live active 不超 cap", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    // B 在 awaiting_review（不在 queued），稍后被「外部驱动者」（模拟 pr-poller）转 fix_revision
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) setRequirementStatus(idB, s);

    // A、C 两个 queued（A 先于 C）
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "queued");
    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");
    db.run("UPDATE requirements SET created_at = 1000 WHERE id = ?", [idA]);
    db.run("UPDATE requirements SET created_at = 2000 WHERE id = ?", [idC]);

    const calls: string[] = [];
    _setTaskStartersForTest({
      startTaskFromTemplate: async (opts) => {
        const reqId = String(opts.requirement_id);
        calls.push(reqId);
        // 模拟起 A 的 await 期间，外部驱动者把 B 转入 fix_revision，占住第二个槽
        if (reqId === idA) setRequirementStatus(idB, "fix_revision");
        return { id: `tsk-${reqId}` } as unknown as Task;
      },
    });

    await tick();

    // A 起跑→running，B 外部转 fix_revision → live active 已达 2=cap，C 不该再被起（旧「快照+started」
    // 会漏算 B 的占用而误起 C 致超 cap=3）。
    expect(calls).toEqual([idA]);
    expect(getRequirementById(idC)?.status).toBe("queued");
    const active = listRequirements({}).filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active.length).toBe(2); // A running + B fix_revision，未超 cap
  });

  // ──────── 全局 FIFO（created_at 序，跨 workspace）────────

  it("queued 按 created_at 先进先出调度（与 workspace 无关）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 3\n", "utf-8");

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "queued");
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");
    const idC = nextRequirementId();
    createRequirement({ id: idC, project_id: "proj-global", workspace_id: "ws-g3", title: "C" });
    pushTo(idC, "queued");

    // 显式设 created_at：C 最老 → A → B 最新（与创建顺序、id 序均不同）
    db.run("UPDATE requirements SET created_at = 100 WHERE id = ?", [idC]);
    db.run("UPDATE requirements SET created_at = 200 WHERE id = ?", [idA]);
    db.run("UPDATE requirements SET created_at = 300 WHERE id = ?", [idB]);

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([idC, idA, idB]); // 严格 FIFO
    expect(getRequirementById(idC)?.status).toBe("running");
    expect(getRequirementById(idA)?.status).toBe("running");
    expect(getRequirementById(idB)?.status).toBe("running");
  });

  it("N=2：一次 tick 填满两个空槽，第 3 个（最新）保持 queued", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = nextRequirementId();
      createRequirement({ id, project_id: "proj-global", workspace_id: `ws-g${i + 1}`, title: `R${i}` });
      pushTo(id, "queued");
      db.run("UPDATE requirements SET created_at = ? WHERE id = ?", [(i + 1) * 100, id]);
      ids.push(id);
    }

    const calls: string[] = [];
    mockStartOk(calls);
    await tick();

    expect(calls).toEqual([ids[0], ids[1]]); // 一次事件填满两槽（FIFO 取最老两个）
    expect(getRequirementById(ids[0])?.status).toBe("running");
    expect(getRequirementById(ids[1])?.status).toBe("running");
    expect(getRequirementById(ids[2])?.status).toBe("queued");
  });

  it("起任务失败不占槽：失败候选回滚 ready 后继续尝试下一个 queued", async () => {
    // N=1，两个 queued：第一个起失败（不占槽）→ 同一次 tick 内继续调度第二个
    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "queued");
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");
    db.run("UPDATE requirements SET created_at = 100 WHERE id = ?", [idA]);
    db.run("UPDATE requirements SET created_at = 200 WHERE id = ?", [idB]);

    const calls: string[] = [];
    _setTaskStartersForTest({
      startTaskFromTemplate: async (opts) => {
        const reqId = String(opts.requirement_id);
        calls.push(reqId);
        if (reqId === idA) throw new Error("boom");
        return { id: `tsk-${reqId}` } as unknown as Task;
      },
    });
    await tick();

    expect(calls).toEqual([idA, idB]);
    expect(getRequirementById(idA)?.status).toBe("ready"); // 失败可见
    expect(getRequirementById(idA)?.schedule_error).toContain("boom");
    expect(getRequirementById(idB)?.status).toBe("running");
  });

  // ──────── daemon 启动补 tick ────────

  it("initRequirementScheduler 启动时补一次 tick，捡起存量 queued（重启场景）", async () => {
    const id = nextRequirementId();
    createRequirement({ id, project_id: "proj-global", workspace_id: "ws-g1", title: "stale-queued" });
    pushTo(id, "queued"); // 模拟 daemon 重启前已入队、事件已消逝

    const calls: string[] = [];
    mockStartOk(calls);
    try {
      initRequirementScheduler(); // 末尾 void tick()
      await waitFor(() => getRequirementById(id)?.status === "running");
      expect(calls).toEqual([id]);
      expect(getRequirementById(id)?.status).toBe("running");
    } finally {
      disposeRequirementScheduler();
    }
  });

  // ──────── TOCTOU 全局锁：pending 标志不丢 tick ────────

  it("全局锁：tick 进行中再触发 tick → 记 pending，锁释放后补跑（不丢失）", async () => {
    writeFileSync(tmpCfgFile, "scheduler:\n  max_concurrent_tasks: 2\n", "utf-8");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const calls: string[] = [];
    _setTaskStartersForTest({
      startTaskFromTemplate: async (opts) => {
        const reqId = String(opts.requirement_id);
        calls.push(reqId);
        if (calls.length === 1) await firstGate; // 第一个 start 挂起，模拟 tick 进行中
        return { id: `tsk-${reqId}` } as unknown as Task;
      },
    });

    const idA = nextRequirementId();
    createRequirement({ id: idA, project_id: "proj-global", workspace_id: "ws-g1", title: "A" });
    pushTo(idA, "queued");

    const p1 = tick(); // 持锁，A 的 start 挂在 gate 上
    await waitFor(() => calls.length === 1);

    // tick 进行中：新需求入队并触发第二个 tick → 被锁挡住，置 _pendingTick 后立即返回
    const idB = nextRequirementId();
    createRequirement({ id: idB, project_id: "proj-global", workspace_id: "ws-g2", title: "B" });
    pushTo(idB, "queued");
    db.run("UPDATE requirements SET created_at = created_at + 1000 WHERE id = ?", [idB]);
    await tick();
    expect(getRequirementById(idB)?.status).toBe("queued"); // 还没轮到（被锁挡住）

    releaseFirst();
    await p1;

    // 锁释放后 pending 补跑（微任务异步触发）→ idB 被调度
    await waitFor(() => getRequirementById(idB)?.status === "running");
    expect(calls).toEqual([idA, idB]);
    expect(getRequirementById(idA)?.status).toBe("running");
    expect(getRequirementById(idB)?.status).toBe("running");
  });
});
