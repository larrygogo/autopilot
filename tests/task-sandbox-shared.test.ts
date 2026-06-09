import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
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

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  _setDbForTest(db);
  initDb();
  await runPendingMigrations();

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

describe("共用沙盒 · diff 看得到 committed + 新建改动（审计 P1 回归）", () => {
  it("develop 在 clone 里自己 commit 了 + 新建文件 → computeDiffStat 仍统计到", async () => {
    const { computeDiffStat } = await import("../src/daemon/task-outcome");
    const id = taskId("shrcr");
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, `feat/${id}`);
    const ws = getTaskSandbox(id);
    const gitc = (args: string[]) => Bun.spawnSync(["git", "-C", ws, ...args], { stdout: "pipe", stderr: "pipe" });
    gitc(["config", "user.email", "t@t.io"]);
    gitc(["config", "user.name", "t"]);
    gitc(["config", "commit.gpgsign", "false"]);
    // 模拟 develop agent：改已跟踪文件 + 新建文件，并自己 commit（这正是审计 P1 里
    // `git diff`(工作树 vs HEAD) 看空 diff 的场景——commit 后工作树==HEAD）。
    writeFileSync(join(ws, "README.md"), "base\nfeature\n", "utf-8");
    writeFileSync(join(ws, "new.ts"), "export const y = 2;\n", "utf-8");
    gitc(["add", "-A"]);
    gitc(["commit", "-m", "dev commit"]);

    // computeDiffStat 用 origin/<base> + add -A + diff --cached：即便已 commit、含新文件，仍看得到。
    // 旧的 `git diff`(工作树 vs HEAD) 在此场景会返回空 → code_review 反复驳回杀任务。
    const stat = computeDiffStat(ws, "main");
    expect(stat).not.toBeNull();
    expect(stat!.files).toBe(2); // README 改 + new.ts 新增
  });
});

describe("共用沙盒 · 重跑重新 clone（Task 5）", () => {
  it("重跑删旧 workspace 并重新 clone（上一轮残留不带过来）", async () => {
    const { createTask, updateTask } = await import("../src/core/db");
    const { createProject } = await import("../src/core/projects");
    const { createWorkspace } = await import("../src/core/workspaces");
    const { resetTaskForRerun } = await import("../src/core/task-factory");
    const registry = await import("../src/core/registry");
    registry._clearRegistry();
    registry.register({
      name: "shr_wf",
      description: "共用沙盒测试工作流",
      phases: [{ name: "develop", pending_state: "pending_develop", running_state: "running_develop", trigger: "start_develop", complete_trigger: "develop_complete", fail_trigger: "develop_fail", label: "DEV", func: async () => {} }],
      initial_state: "pending_develop",
      terminal_states: ["done", "cancelled", "failed"],
      sandbox: { git: true },
    } as never);

    createProject({ id: "proj-1", name: "p" });
    createWorkspace({ id: "ws-1", project_id: "proj-1", alias: "r", path: srcRepo, default_branch: "main" });

    const id = taskId("shr5");
    ensureTaskSandbox(id, "shr_wf", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, `feat/${id}`);
    const ws = getTaskSandbox(id);
    createTask({ id, title: "t", workflow: "shr_wf", initialStatus: "running_develop", requirementId: undefined });
    updateTask(id, { workspace_id: "ws-1", branch: `feat/${id}`, default_branch: "main", workspace_path: ws });
    writeFileSync(join(ws, "stale.txt"), "old\n", "utf-8"); // 上一轮残留

    resetTaskForRerun(id);

    // 重跑 = 重新 clone 干净：旧残留没了，源仓库 README 在
    expect(existsSync(join(ws, "stale.txt"))).toBe(false);
    expect(existsSync(join(ws, "README.md"))).toBe(true);
  });
});
