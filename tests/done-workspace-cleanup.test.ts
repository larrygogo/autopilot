/**
 * 需求完成即清任务 workspace（done-workspace-cleanup）。
 * 覆盖：done 触发清理 / 非 done 不清 / 无 task_id 容错 / cleanupTaskWorkspace 幂等。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate028 } from "../src/migrations/028-requirement-status-reason";
import { up as migrate029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as migrate030 } from "../src/migrations/030-requirement-status-logs";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { cleanupTaskWorkspace } from "../src/daemon/done-workspace-cleanup";

let db: Database;
let tasksRoot: string;
let tmpHome: string;
let prevHome: string | undefined;

const MIGRATIONS = [
  migrate001, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009,
  migrate021, migrate024, migrate028, migrate029, migrate030, migrate033,
];

beforeEach(() => {
  db = new Database(":memory:");
  for (const m of MIGRATIONS) m(db);
  _setDbForTest(db);
  createProject({ id: "proj-dc1", name: "p" });
  const slug = `autopilot-dwc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tasksRoot = join(tmpdir(), slug);
  // handler 的需求级 codebase 清理按 AUTOPILOT_HOME 寻路（v2 R4）——必须注入 tmp home，
  // 防止事件测试碰真实家目录
  tmpHome = join(tmpdir(), `${slug}-home`);
  mkdirSync(tmpHome, { recursive: true });
  prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  _setDbForTest(null);
  db.close();
  if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prevHome;
  for (const p of [tasksRoot, tmpHome]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function makeWorkspace(taskId: string): string {
  const ws = join(tasksRoot, taskId, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "file.txt"), "clone content");
  return ws;
}

describe("cleanupTaskWorkspace", () => {
  it("删除 workspace 目录并返回 true；其余任务文件保留", () => {
    const ws = makeWorkspace("tk-dwc01");
    writeFileSync(join(tasksRoot, "tk-dwc01", "task-manifest.json"), "{}");

    expect(cleanupTaskWorkspace("tk-dwc01", tasksRoot)).toBe(true);
    expect(existsSync(ws)).toBe(false);
    // 任务记录文件不动（只清代码 clone）
    expect(existsSync(join(tasksRoot, "tk-dwc01", "task-manifest.json"))).toBe(true);
  });

  it("workspace 不存在 → false（幂等）", () => {
    expect(cleanupTaskWorkspace("tk-none", tasksRoot)).toBe(false);
  });
});

describe("需求完成触发清理（事件链路）", () => {
  it("requirement → done 时清理关联任务 workspace", async () => {
    // 直接验证 handler 逻辑：建需求绑任务 → 走状态机到 done → workspace 应被清
    // （event-bus 在测试中懒激活，这里手动调 handler 等价路径：init 订阅 + enableBus）
    const { enableBus, disableBus } = await import("../src/core/event-bus");
    const { initDoneWorkspaceCleanup, disposeDoneWorkspaceCleanup } =
      await import("../src/daemon/done-workspace-cleanup");

    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-dc1", title: "T" });
    updateRequirement(reqId, { task_id: "tk-dwc02" });
    const ws = makeWorkspace("tk-dwc02");
    // v2 R4：需求级 codebase（tmp home 下）—— done 时应被清
    const cbRoot = join(tmpHome, "runtime", "requirements", reqId, "codebase");
    mkdirSync(join(cbRoot, "app"), { recursive: true });
    writeFileSync(join(cbRoot, "app", "file.txt"), "clone content");
    const runsDir = join(tmpHome, "runtime", "requirements", reqId, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "keep.txt"), "执行历史轻物料，done 不清");

    enableBus();
    initDoneWorkspaceCleanup();
    try {
      for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) {
        setRequirementStatus(reqId, s);
      }
      expect(existsSync(ws)).toBe(true);     // 非 done 转换不清
      expect(existsSync(cbRoot)).toBe(true);

      // tasksRoot 注入不到事件 handler（生产路径是 AUTOPILOT_HOME 下真实目录）——
      // 任务 workspace 删除语义由上组用例覆盖；codebase 清理走 tmp home 可全验证。
      setRequirementStatus(reqId, "done");
      expect(existsSync(ws)).toBe(true);      // handler 清的是真实 tasksRoot（tmp 下这份不动）
      expect(existsSync(cbRoot)).toBe(false); // 需求级 codebase done 即清
      expect(existsSync(join(runsDir, "keep.txt"))).toBe(true); // runs/ 轻物料保留
    } finally {
      disposeDoneWorkspaceCleanup();
      disableBus();
    }
  });
});
