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
  it("ensureTaskSandbox 对 git 工作流建出含源仓库内容的工作树（统一布局：单库也在 ./alias/ 子目录）", () => {
    const id = taskId("shr1");
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", remote_url: srcRepo, default_branch: "main" }, "feat/shr1");
    const ws = getTaskSandbox(id);
    // 无 alias → 子目录名回退 workspace id
    const repo = join(ws, "ws-1");
    expect(existsSync(join(ws, ".git"))).toBe(false); // 根不再是仓库根
    expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toContain("base");
  });
});

describe("共用沙盒 · 跨 phase 直接可见（Task 2）", () => {
  it("phase1 在共用 clone 改文件，phase2 在同一 clone 直接看到（无 patch 中转）", async () => {
    const { runWithTaskContext, getCurrentSandboxDir } = await import("../src/core/task-context");
    const id = taskId("shr2");
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", remote_url: srcRepo, default_branch: "main" }, "feat/shr2");
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
    ensureTaskSandbox(id, "dev", { git: true }, { id: "ws-1", remote_url: srcRepo, default_branch: "main" }, `feat/${id}`);
    const repo = join(getTaskSandbox(id), "ws-1"); // 统一布局：仓库在 ./<alias|id>/ 子目录
    const gitc = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    gitc(["config", "user.email", "t@t.io"]);
    gitc(["config", "user.name", "t"]);
    gitc(["config", "commit.gpgsign", "false"]);
    // 模拟 develop agent：改已跟踪文件 + 新建文件，并自己 commit（这正是审计 P1 里
    // `git diff`(工作树 vs HEAD) 看空 diff 的场景——commit 后工作树==HEAD）。
    writeFileSync(join(repo, "README.md"), "base\nfeature\n", "utf-8");
    writeFileSync(join(repo, "new.ts"), "export const y = 2;\n", "utf-8");
    gitc(["add", "-A"]);
    gitc(["commit", "-m", "dev commit"]);

    // computeDiffStat 用 origin/<base> + add -A + diff --cached：即便已 commit、含新文件，仍看得到。
    // 旧的 `git diff`(工作树 vs HEAD) 在此场景会返回空 → code_review 反复驳回杀任务。
    const stat = computeDiffStat(repo, "main");
    expect(stat).not.toBeNull();
    expect(stat!.files).toBe(2); // README 改 + new.ts 新增
  });
});

describe("共用沙盒 · 需求级重跑 = 新 run（v2 R2，替代 resetTaskForRerun 清史复用）", () => {
  it("startNewRunForRequirement：旧 run 历史保留（workspace 清掉）、新 run 全新 clone 落 runs/、task_id/seq 更新", async () => {
    const { createTask, getTask, startTaskPhase, listTaskPhaseEvents } = await import("../src/core/db");
    const { createProject } = await import("../src/core/projects");
    const { createWorkspace } = await import("../src/core/workspaces");
    const { createRequirement, getRequirementById, updateRequirement, nextRequirementId } = await import("../src/core/requirements");
    const { startNewRunForRequirement } = await import("../src/core/task-factory");
    const { getTaskRoot } = await import("../src/core/sandbox");
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
    createWorkspace({ id: "ws-1", project_id: "proj-1", alias: "r", path: srcRepo, remote_url: srcRepo, default_branch: "main" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-1", workspace_id: "ws-1", title: "rerun as new run" });

    // 旧 run：模拟存量任务（legacy 根 runtime/tasks/<id>/，混根场景），已 failed 终态
    const oldId = taskId("shr5old");
    ensureTaskSandbox(oldId, "shr_wf", { git: true }, { id: "ws-1", remote_url: srcRepo, default_branch: "main" }, `feat/${oldId}`);
    const oldWs = getTaskSandbox(oldId);
    createTask({ id: oldId, title: "t", workflow: "shr_wf", initialStatus: "running_develop", requirementId: reqId });
    startTaskPhase(oldId, "develop"); // 残留 open phase event（重跑前应被幂等关闭）
    db.run("UPDATE tasks SET status='failed' WHERE id=?", [oldId]);
    updateRequirement(reqId, { task_id: oldId });
    // 旧 run 的执行历史物料（artifacts/logs）——新 run 后必须保留
    const oldRoot = getTaskRoot(oldId);
    mkdirSync(join(oldRoot, "artifacts"), { recursive: true });
    writeFileSync(join(oldRoot, "artifacts", "design.md"), "old run artifact\n", "utf-8");
    mkdirSync(join(oldRoot, "logs"), { recursive: true });
    writeFileSync(join(oldRoot, "logs", "phase-develop.log"), "old log\n", "utf-8");
    writeFileSync(join(oldWs, "stale.txt"), "old\n", "utf-8"); // 旧 clone 残留

    const newTask = await startNewRunForRequirement(reqId, { workflow: "shr_wf", title: "rerun as new run" });

    // 新 run：新 task 行、seq 递增、requirement.task_id 指向新 run
    expect(newTask.id).not.toBe(oldId);
    expect(newTask.seq).toBe(2);
    expect(newTask.kind).toBe("execution");
    expect(getRequirementById(reqId)?.task_id).toBe(newTask.id);

    // 新 run 文件落新根 runtime/requirements/<reqId>/runs/<taskId>/，clone 全新建出
    const newRoot = getTaskRoot(newTask.id);
    expect(newRoot).toBe(join(tmpHome, "runtime", "requirements", reqId, "runs", newTask.id));
    expect(existsSync(join(newRoot, "workspace", "r", "README.md"))).toBe(true);
    expect(existsSync(join(newRoot, "workspace", "r", "stale.txt"))).toBe(false);

    // 旧 run 历史保留：artifacts/logs/task 行都在；只有 workspace/ 代码 clone 被清
    expect(getTask(oldId)?.status).toBe("failed");
    expect(existsSync(join(oldRoot, "artifacts", "design.md"))).toBe(true);
    expect(existsSync(join(oldRoot, "logs", "phase-develop.log"))).toBe(true);
    expect(existsSync(oldWs)).toBe(false);

    // 旧 run 残留 open phase event 被关闭（aborted），不留僵尸 running 轮
    const oldEvents = listTaskPhaseEvents(oldId);
    expect(oldEvents.length).toBe(1);
    expect(oldEvents[0]!.status).toBe("aborted");
  });

  it("活跃 run 守卫：当前 run 非终态时 startNewRunForRequirement / startTaskFromTemplate 均 409", async () => {
    const { createTask } = await import("../src/core/db");
    const { createProject } = await import("../src/core/projects");
    const { createWorkspace } = await import("../src/core/workspaces");
    const { createRequirement, updateRequirement, nextRequirementId } = await import("../src/core/requirements");
    const { startNewRunForRequirement, startTaskFromTemplate } = await import("../src/core/task-factory");
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
    createWorkspace({ id: "ws-1", project_id: "proj-1", alias: "r", path: srcRepo, remote_url: srcRepo, default_branch: "main" });
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-1", workspace_id: "ws-1", title: "active run guard" });

    const activeId = taskId("shr5act");
    createTask({ id: activeId, title: "t", workflow: "shr_wf", initialStatus: "running_develop", requirementId: reqId });
    updateRequirement(reqId, { task_id: activeId });

    await expect(startNewRunForRequirement(reqId, { workflow: "shr_wf" }))
      .rejects.toThrow(/活跃/);
    await expect(startTaskFromTemplate({ workflow: "shr_wf", title: "x", requirement_id: reqId }))
      .rejects.toThrow(/活跃 run/);
    // 终态后允许追加新 run（409 解除）
    db.run("UPDATE tasks SET status='cancelled' WHERE id=?", [activeId]);
    const t = await startTaskFromTemplate({ workflow: "shr_wf", title: "x", requirement_id: reqId });
    expect(t.seq).toBe(2);
  });
});

describe("共用沙盒 · 全流程集成（真 runner → 共用 clone → phase 写 → diff_stat → 自动推进）", () => {
  it("executePhase 注入共用沙盒，phase 经 listTaskRepos 定位仓库写文件且 diff_stat 端到端看到", async () => {
    const { executePhase } = await import("../src/core/runner");
    const { getCurrentSandboxDir } = await import("../src/core/task-context");
    const { listTaskRepos } = await import("../src/core/sandbox");
    const { computeDiffStat } = await import("../src/daemon/task-outcome");
    const { createTask, updateTask, getTask } = await import("../src/core/db");
    const { createProject } = await import("../src/core/projects");
    const { createWorkspace } = await import("../src/core/workspaces");
    const registry = await import("../src/core/registry");

    // phase 函数完全不知道路径：沙盒根从 ALS 上下文取（runner 注入 getTaskSandbox(id)），
    // 仓库位置走 listTaskRepos（统一布局的唯一消费接口）——与 dev workflow 同款链路。
    let sawSandbox: string | undefined;
    let sawRepoPath: string | undefined;
    registry._clearRegistry();
    registry.register({
      name: "shr_int",
      description: "共用沙盒全流程集成测试工作流",
      phases: [{
        name: "develop", pending_state: "pending_develop", running_state: "running_develop",
        trigger: "start_develop", complete_trigger: "develop_complete", fail_trigger: "develop_fail",
        label: "DEV",
        func: async (tid: string) => {
          sawSandbox = getCurrentSandboxDir();
          const repos = listTaskRepos(tid);
          sawRepoPath = repos[0]?.path;
          writeFileSync(join(sawRepoPath!, "delivered.ts"), "export const ok = true;\n", "utf-8");
        },
      }],
      initial_state: "pending_develop",
      terminal_states: ["done", "cancelled", "failed"],
      sandbox: { git: true },
    } as never);

    createProject({ id: "proj-1", name: "p" });
    createWorkspace({ id: "ws-1", project_id: "proj-1", alias: "r", path: srcRepo, remote_url: srcRepo, default_branch: "main" });

    const id = taskId("shrint");
    ensureTaskSandbox(id, "shr_int", { git: true }, [{ id: "ws-1", alias: "r", remote_url: srcRepo, default_branch: "main" }] as never, `feat/${id}`);
    const ws = getTaskSandbox(id);
    createTask({ id, title: "t", workflow: "shr_int", initialStatus: "running_develop", requirementId: undefined });
    updateTask(id, { workspace_id: "ws-1", branch: `feat/${id}`, default_branch: "main", workspace_path: ws });

    // 真 runner 跑这一 phase：内部会注入 getTaskSandbox(id) 作 sandboxDir
    await executePhase(id, "develop");

    // 1) phase 函数确实拿到了共用沙盒路径（= 该 task 的沙盒根）+ 仓库子目录
    expect(sawSandbox).toBe(ws);
    expect(sawRepoPath).toBe(join(ws, "r"));
    // 2) 文件真落进了仓库 clone（统一布局：./r/ 子目录）
    expect(existsSync(join(ws, "r", "delivered.ts"))).toBe(true);
    // 3) diff_stat 端到端看到这次改动（add -A + diff --cached origin/main）
    const stat = computeDiffStat(join(ws, "r"), "main");
    expect(stat).not.toBeNull();
    expect(stat!.files).toBe(1);
    // 4) phase 成功 → 单 phase 工作流自动推进到终态 done（无下一阶段 spawn）
    expect(getTask(id)?.status).toBe("done");
  });
});
