import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask, updateTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { computeTaskOutcome, computeDiffStat } from "../src/daemon/task-outcome";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("computeTaskOutcome", () => {
  it("非终态返回 null", async () => {
    createTask({ id: "task-001", title: "x", workflow: "dev", initialStatus: "running_design" });
    const o = await computeTaskOutcome("task-001");
    expect(o).toBeNull();
  });

  it("终态返回 outcome，包含 total_duration_ms + top_phases", async () => {
    createTask({ id: "task-002", title: "x", workflow: "dev", initialStatus: "running_design" });
    const a = startTaskPhase("task-002", "design");
    await new Promise((r) => setTimeout(r, 10));
    endTaskPhase(a, "done");
    const b = startTaskPhase("task-002", "review");
    await new Promise((r) => setTimeout(r, 20));
    endTaskPhase(b, "done");
    updateTask("task-002", { status: "done" });

    const o = await computeTaskOutcome("task-002");
    expect(o).not.toBeNull();
    expect(o!.status).toBe("done");
    expect(o!.total_duration_ms).toBeGreaterThan(0);
    expect(o!.top_phases.length).toBeGreaterThan(0);
    expect(o!.top_phases[0]!.duration_ms).toBeGreaterThanOrEqual(o!.top_phases[o!.top_phases.length - 1]!.duration_ms);
  });

  it("workspace 不存在 → diff_stat = null", async () => {
    createTask({ id: "task-003", title: "x", workflow: "dev", initialStatus: "done" });
    const o = await computeTaskOutcome("task-003");
    expect(o!.diff_stat).toBeNull();
  });

});

// 共用沙盒模型：diff_stat 对任务 clone 工作树跑 git diff（add -A + diff --cached <base>），
// 覆盖 committed + 未提交 + 未跟踪。用真实临时 git 仓库测。
describe("computeDiffStat（共用沙盒，对任务 clone 跑 git diff）", () => {
  function git(args: string[], cwd: string): void {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  }
  function makeRepo(name: string): string {
    const repo = join(tmpHome, name);
    mkdirSync(repo, { recursive: true });
    git(["init", "-q"], repo);
    git(["config", "user.email", "t@t.io"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(join(repo, "README.md"), "base\n", "utf-8");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "base"], repo);
    git(["branch", "-M", "main"], repo);
    return repo;
  }

  it("统计 committed + 未提交 + 未跟踪改动（add -A + diff --cached base）", () => {
    const repo = makeRepo("repo1");
    writeFileSync(join(repo, "README.md"), "base\nmore\n", "utf-8");   // 改已跟踪文件
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n", "utf-8"); // 未跟踪新文件
    const stat = computeDiffStat(repo, "main");
    expect(stat).not.toBeNull();
    expect(stat!.files).toBe(2);                       // README 改 + feature 新增
    expect(stat!.insertions).toBeGreaterThanOrEqual(2);
  });

  it("无改动 → 全 0（非 null）", () => {
    const repo = makeRepo("repo2");
    expect(computeDiffStat(repo, "main")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("非 git 目录 → null", () => {
    const dir = join(tmpHome, "notgit");
    mkdirSync(dir, { recursive: true });
    expect(computeDiffStat(dir, "main")).toBeNull();
  });
});
