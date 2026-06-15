/**
 * requirement_deliveries（迁移 045/046 + core/requirements/deliveries，v2 R5）：
 *   - 迁移幂等（重复跑 up 不炸、结果一致；045 回填只补 NULL）
 *   - deliverArtifacts：promote 到 runtime/requirements/<reqId>/deliveries/round-<N>/、
 *     round 递增、同 round 目标先清（幂等）、空目录/缺目录拒绝
 *   - listDeliveryFiles 递归列文件；resolveDeliveryFilePath 防目录穿越
 *   - setRequirementWorkspaces 写 input_mode（空集 'none' / 非空 'git'）
 *   - deleteRequirement 级联删 deliveries 行
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
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
import { up as migrate018 } from "../src/migrations/018-task-phase-events";
import { up as migrate019 } from "../src/migrations/019-task-requirement-id";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
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
  setRequirementWorkspaces,
  deleteRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import {
  deliverArtifacts,
  listDeliveries,
  hasDeliveries,
  maxDeliveryRound,
  listDeliveryFiles,
  resolveDeliveryFilePath,
  getDeliveryRoundDir,
} from "../src/core/requirements/deliveries";
import { _clearTaskRootCacheForTest } from "../src/core/sandbox";
import { _releaseAllLocks } from "../src/core/infra";

let db: Database;
let tmpHome: string;
let n = 0;

const MIGRATIONS = [
  migrate001, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009,
  migrate018, migrate019, migrate021, migrate024, migrate033, migrate044, migrate045, migrate046,
];

beforeEach(() => {
  n += 1;
  tmpHome = join(tmpdir(), `autopilot-dlv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of MIGRATIONS) m(db);
  _setDbForTest(db);
  _clearTaskRootCacheForTest();
});

afterEach(() => {
  _releaseAllLocks();
  _clearTaskRootCacheForTest();
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function makeFixture(): { reqId: string; taskId: string } {
  const pid = `proj-dlv${n}`;
  createProject({ id: pid, name: "p" });
  createWorkspace({ id: `ws-dlv${n}`, project_id: pid, alias: "r", path: "/tmp/r", default_branch: "main" });
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: pid, workspace_id: `ws-dlv${n}`, title: "T" });
  const taskId = `tkdlv${String(n).padStart(3, "0")}`;
  createTask({ id: taskId, title: "T", workflow: "artifact", initialStatus: "running_produce", requirementId: reqId });
  return { reqId, taskId };
}

function makeSrcDir(files: Record<string, string>): string {
  const dir = join(tmpHome, `src-${Math.random().toString(36).slice(2, 8)}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

describe("迁移 045/046 幂等", () => {
  it("重复 up 不炸；045 回填只补 NULL、不覆盖已有值", () => {
    // beforeEach 已跑全量；再跑一次
    migrate045(db);
    migrate046(db);
    migrate045(db);

    const pid = `proj-mig${n}`;
    createProject({ id: pid, name: "p" });
    createWorkspace({ id: `ws-mig${n}`, project_id: pid, alias: "r", path: "/tmp/r", default_branch: "main" });
    const withWs = nextRequirementId();
    createRequirement({ id: withWs, project_id: pid, workspace_id: `ws-mig${n}`, title: "有库" });
    db.run("UPDATE requirements SET input_mode = NULL WHERE id = ?", [withWs]);
    const noWs = nextRequirementId();
    createRequirement({ id: noWs, project_id: pid, workspace_id: null, title: "无库" });
    db.run("UPDATE requirements SET input_mode = 'none' WHERE id = ?", [noWs]);

    migrate045(db); // 回填
    expect(getRequirementById(withWs)!.input_mode).toBe("git");
    expect(getRequirementById(noWs)!.input_mode).toBe("none"); // 已有值不被覆盖
  });
});

describe("setRequirementWorkspaces 写 input_mode", () => {
  it("非空集 → 'git'；显式空集 → 清集合 + 'none'", () => {
    const { reqId } = makeFixture();
    setRequirementWorkspaces(reqId, [`ws-dlv${n}`]);
    expect(getRequirementById(reqId)!.input_mode).toBe("git");

    setRequirementWorkspaces(reqId, []);
    const r = getRequirementById(reqId)!;
    expect(r.input_mode).toBe("none");
    expect(r.workspace_id).toBe(null);
  });
});

describe("deliverArtifacts promote", () => {
  it("promote 到需求 deliveries/round-1/ 并落表；round 递增；目录内容完整", () => {
    const { reqId, taskId } = makeFixture();
    const src = makeSrcDir({ "index.html": "<html>1</html>", "assets/a.css": "body{}", "SUMMARY.md": "首轮" });

    const d1 = deliverArtifacts(taskId, src, "第一轮摘要");
    expect(d1.round).toBe(1);
    expect(d1.requirement_id).toBe(reqId);
    expect(d1.task_id).toBe(taskId);
    expect(d1.path).toBe("deliveries/round-1");
    expect(d1.summary).toBe("第一轮摘要");
    const dest1 = getDeliveryRoundDir(reqId, 1);
    expect(readFileSync(join(dest1, "index.html"), "utf-8")).toBe("<html>1</html>");
    expect(existsSync(join(dest1, "assets", "a.css"))).toBe(true);

    expect(hasDeliveries(reqId)).toBe(true);
    expect(maxDeliveryRound(reqId)).toBe(1);

    // 第二轮：round+1，第一轮原样保留
    writeFileSync(join(src, "index.html"), "<html>2</html>", "utf-8");
    const d2 = deliverArtifacts(taskId, src);
    expect(d2.round).toBe(2);
    expect(d2.summary).toBe(null);
    expect(readFileSync(join(getDeliveryRoundDir(reqId, 2), "index.html"), "utf-8")).toBe("<html>2</html>");
    expect(readFileSync(join(dest1, "index.html"), "utf-8")).toBe("<html>1</html>");
    expect(listDeliveries(reqId).map((d) => d.round)).toEqual([1, 2]);
  });

  it("promote 前清同 round 残留（上次崩在拷完没落表的半套不会污染）", () => {
    const { reqId, taskId } = makeFixture();
    // 伪造崩溃残留：round-1 目录有旧文件但表里没行
    const stale = getDeliveryRoundDir(reqId, 1);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "stale.txt"), "残留", "utf-8");

    const src = makeSrcDir({ "fresh.txt": "新" });
    const d = deliverArtifacts(taskId, src);
    expect(d.round).toBe(1);
    expect(existsSync(join(stale, "stale.txt"))).toBe(false);
    expect(existsSync(join(stale, "fresh.txt"))).toBe(true);
  });

  it("产物目录缺失 / 为空 → 抛错（防静默空交付）", () => {
    const { taskId } = makeFixture();
    expect(() => deliverArtifacts(taskId, join(tmpHome, "no-such-dir"))).toThrow("产物目录不存在");
    const empty = join(tmpHome, "empty-src");
    mkdirSync(empty, { recursive: true });
    expect(() => deliverArtifacts(taskId, empty)).toThrow("产物目录为空");
  });
});

describe("验收浏览", () => {
  it("listDeliveryFiles 递归列文件（相对路径 / 排序）；无目录 → []", () => {
    const { reqId, taskId } = makeFixture();
    const src = makeSrcDir({ "b.txt": "b", "a/x.txt": "x", "a/y/z.txt": "z" });
    deliverArtifacts(taskId, src);

    const files = listDeliveryFiles(reqId, 1);
    expect(files.map((f) => f.path)).toEqual(["a/x.txt", "a/y/z.txt", "b.txt"]);
    expect(files[2].size).toBe(1);
    expect(listDeliveryFiles(reqId, 9)).toEqual([]);
  });

  it("resolveDeliveryFilePath 防穿越", () => {
    const { reqId, taskId } = makeFixture();
    deliverArtifacts(taskId, makeSrcDir({ "ok.txt": "ok" }));
    expect(resolveDeliveryFilePath(reqId, 1, "ok.txt")).toContain("round-1");
    expect(resolveDeliveryFilePath(reqId, 1, "../../../etc/passwd")).toBe(null);
    expect(resolveDeliveryFilePath(reqId, 1, "a\0b")).toBe(null);
  });
});

describe("删除级联", () => {
  it("deleteRequirement 删 deliveries 行 + 整树目录", () => {
    const { reqId, taskId } = makeFixture();
    deliverArtifacts(taskId, makeSrcDir({ "f.txt": "f" }));
    expect(hasDeliveries(reqId)).toBe(true);

    // 先删 task 行避免 FK 残留（deleteRequirement 只删需求侧）
    db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
    deleteRequirement(reqId);
    expect(hasDeliveries(reqId)).toBe(false);
    expect(existsSync(join(tmpHome, "runtime", "requirements", reqId))).toBe(false);
  });
});
