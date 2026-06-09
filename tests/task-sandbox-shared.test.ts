import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../src/core/db";
import { ensureTaskSandbox, getTaskSandbox } from "../src/core/sandbox";
import { AUTOPILOT_HOME } from "../src/index";

// 共用沙盒模型回归测试。AUTOPILOT_HOME 是 import 期冻结常量（测试改 env 不生效），故用唯一
// taskId、afterEach 清真实 home 下该 taskId 目录，源仓库在 tmpdir。

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败: ${new TextDecoder().decode(p.stderr)}`);
}

let db: Database;
let tmpHome: string;
let srcRepo: string;
const usedTaskIds: string[] = [];

function taskId(prefix: string): string {
  const id = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  usedTaskIds.push(id);
  return id;
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of [m001, m004, m005, m006, m007, m008, m009, m010, m019, m021, m024]) m(db);
  _setDbForTest(db);

  srcRepo = join(tmpdir(), `autopilot-shared-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(srcRepo, { recursive: true });
  git(["init", "-q"], srcRepo);
  git(["config", "user.email", "t@t.io"], srcRepo);
  git(["config", "user.name", "t"], srcRepo);
  git(["config", "commit.gpgsign", "false"], srcRepo);
  writeFileSync(join(srcRepo, "README.md"), "base\n", "utf-8");
  git(["add", "-A"], srcRepo);
  git(["commit", "-q", "-m", "base"], srcRepo);
  git(["branch", "-M", "main"], srcRepo);
});

afterEach(() => {
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  for (const id of usedTaskIds) {
    try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  usedTaskIds.length = 0;
  for (const d of [tmpHome, srcRepo]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("共用沙盒 · ensureTaskSandbox 建 clone（Task 1）", () => {
  it("ensureTaskSandbox 对 git 工作流建出含源仓库内容的工作树", () => {
    const id = taskId("shr1");
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, "feat/shr1");
    const ws = getTaskSandbox(id);
    expect(existsSync(join(ws, ".git"))).toBe(true);
    expect(existsSync(join(ws, "README.md"))).toBe(true);
    expect(readFileSync(join(ws, "README.md"), "utf-8")).toContain("base");
  });
});

describe("共用沙盒 · 跨 phase 直接可见（Task 2）", () => {
  it("phase1 在共用 clone 改文件，phase2 在同一 clone 直接看到（无 patch 中转）", async () => {
    const { runWithTaskContext, getCurrentSandboxDir } = await import("../src/core/task-context");
    const id = taskId("shr2");
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, "feat/shr2");
    const ws = getTaskSandbox(id);

    // 模拟 runner：phase1 在注入的共用沙盒里写文件
    await runWithTaskContext({ taskId: id, phase: "develop", sandboxDir: ws }, async () => {
      writeFileSync(join(getCurrentSandboxDir()!, "feature.ts"), "export const x = 1;\n", "utf-8");
    });
    // phase2：同一共用沙盒应直接看到 phase1 的改动
    await runWithTaskContext({ taskId: id, phase: "review", sandboxDir: ws }, async () => {
      expect(existsSync(join(getCurrentSandboxDir()!, "feature.ts"))).toBe(true);
    });
  });
});
