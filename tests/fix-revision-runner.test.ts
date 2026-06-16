/**
 * fix-revision-runner（v2 R3：fix = kind=fix 的标准 run）。
 *
 * 覆盖：
 *   - __fix 内置工作流注册（getWorkflow 可取 / listWorkflows 隐藏 / reload 后存活）
 *   - fix_revision 事件 → 创建 fix run（kind=fix、seq 递增、task_id 指向新 run、
 *     沙盒 = clone 远程交付分支续作；不删远程分支、不清旧 run workspace）
 *   - 端到端：fix run done → bridge 翻译 fixed → reportRunOutcome → awaiting_review；
 *     修复总结落需求评论；prompt 含反馈 / 仓库布局 / PR 号
 *   - 失败路径：agent 连续失败 → runner 确定性止损 failed → 需求 failed 带原因
 *   - 防重入（需求已有活跃 run 不重复创建）/ 无 task / 无交付分支记录 → failed 停下报人
 *   - 启动补跑：fix_revision 且无活跃 run → init 扫描补建 fix run
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
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
import { up as migrate028 } from "../src/migrations/028-requirement-status-reason";
import { up as migrate029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as migrate030 } from "../src/migrations/030-requirement-status-logs";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { up as migrate038 } from "../src/migrations/038-sub-pr-review-watermark";
import { up as migrate039 } from "../src/migrations/039-sub-pr-ci-watermark";
import { up as migrate044 } from "../src/migrations/044-task-run-columns";
import { up as migrate045 } from "../src/migrations/045-requirement-input-mode";
import { up as migrate046 } from "../src/migrations/046-requirement-deliveries";
import { _setDbForTest, createTask, getTask } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
  nextRequirementId,
} from "../src/core/requirements";
import { appendFeedback, listFeedbacks } from "../src/core/requirements/feedbacks";
import { appendSubPr } from "../src/core/requirements/sub-prs";
import { deliverArtifacts, listDeliveries, getDeliveryRoundDir } from "../src/core/requirements/deliveries";
import { getWorkflow, listWorkflows, reload, _clearRegistry } from "../src/core/workflow/registry";
import { getTaskRoot, getTaskSandbox, _clearTaskRootCacheForTest } from "../src/core/sandbox";
import { executePhase } from "../src/core/runner";
import { enableBus, disableBus } from "../src/core/event-bus";
import { initRequirementTaskBridge, disposeRequirementTaskBridge } from "../src/daemon/requirement-task-bridge";
import { _releaseAllLocks } from "../src/core/infra";
import {
  initFixRevisionRunner,
  disposeFixRevisionRunner,
  startFixRun,
  buildFixPrompt,
  _setFixFnForTest,
  _setListReposForTest,
  FIX_WORKFLOW_NAME,
} from "../src/daemon/fix-revision-runner";
import { createComment, nextCommentId } from "../src/core/requirements/comments";

let db: Database;
let tmpHome: string;

const MIGRATIONS = [
  migrate001, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009,
  migrate018, migrate019, migrate021, migrate024, migrate028, migrate029,
  migrate030, migrate033, migrate038, migrate039, migrate044, migrate045, migrate046,
];

let n = 0;

beforeEach(() => {
  n += 1;
  tmpHome = join(tmpdir(), `autopilot-fxr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  for (const m of MIGRATIONS) m(db);
  _setDbForTest(db);
  _clearTaskRootCacheForTest();
  createProject({ id: `proj-fx${n}`, name: "p" });
  initFixRevisionRunner(); // 注册 __fix + 订阅事件（bus 默认未激活 = 订阅静默）
});

afterEach(async () => {
  // 后台 executePhase 的 finally 尾巴（getTask / closeAgents）给一点 settle 时间，
  // 防止 db.close 后异步尾部触发真实 home 的惰性 DB 初始化
  await new Promise((r) => setTimeout(r, 30));
  disposeFixRevisionRunner();
  disposeRequirementTaskBridge();
  disableBus();
  _setFixFnForTest(null);
  _setListReposForTest(null);
  _releaseAllLocks();          // 锁路径按 env 算——必须在恢复 env 之前清
  _clearRegistry();
  _clearTaskRootCacheForTest();
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────

async function waitFor(cond: () => boolean, label: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitFor 超时：${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim();
  return { ok: p.exitCode === 0, out };
}

function mustGit(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} 失败`);
  return r.out;
}

/** 造一个本地"远程"仓库（main + 可选既有交付分支） */
function makeRemoteRepo(featBranch?: string): string {
  const dir = join(tmpHome, `remote-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  mustGit(dir, "init", "-b", "main");
  mustGit(dir, "config", "user.email", "t@t.t");
  mustGit(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  mustGit(dir, "add", "-A");
  mustGit(dir, "commit", "-m", "init");
  if (featBranch) mustGit(dir, "branch", featBranch);
  return dir;
}

interface Fixture {
  reqId: string;
  wsId: string;
  prevTaskId: string;
  remoteDir: string;
  branch: string;
}

/**
 * 标准夹具：需求走到 awaiting_review，有上一轮 done 的 execution run（带 .worktree.json
 * 交付分支记录 + 旧 workspace 残留文件），交付 PR #7。**不**转 fix_revision（由各测试自行
 * 触发——bus 开启时转入即触发 fix run 创建）。
 */
function makeDeliveredFixture(opts?: { withPrevTask?: boolean; withMeta?: boolean }): Fixture {
  const remoteDir = makeRemoteRepo("feat/fix-me-1234");
  const branch = "feat/fix-me-1234";
  const wsId = `ws-fx${n}`;
  createWorkspace({
    id: wsId, project_id: `proj-fx${n}`, alias: "app",
    path: remoteDir, remote_url: remoteDir, default_branch: "main",
  });
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: `proj-fx${n}`, workspace_id: wsId, title: "修这个" });
  for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) {
    setRequirementStatus(reqId, s);
  }
  updateRequirement(reqId, { pr_number: 7, pr_url: "https://github.com/o/r/pull/7" });
  appendSubPr({ requirement_id: reqId, child_workspace_id: wsId, pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });

  let prevTaskId = "";
  if (opts?.withPrevTask !== false) {
    prevTaskId = `tkprev${String(n).padStart(2, "0")}`;
    createTask({
      id: prevTaskId, title: "修这个", workflow: "dev", initialStatus: "done",
      requirementId: reqId, kind: "execution", seq: 1,
    });
    updateRequirement(reqId, { task_id: prevTaskId });
    const root = getTaskRoot(prevTaskId);
    mkdirSync(join(root, "workspace", "app"), { recursive: true });
    writeFileSync(join(root, "workspace", "app", "marker.txt"), "旧 run 的 clone（fix 续作不应清它）");
    if (opts?.withMeta !== false) {
      writeFileSync(join(root, ".worktree.json"), JSON.stringify({
        mode: "multi-clone", workspace_id: wsId, workspace_path: "",
        branch, base: "main", remote_url: remoteDir, created_at: Date.now(),
        repos: [{ workspace_id: wsId, alias: "app", dir: "app", branch, base: "main", remote_url: remoteDir, primary: true }],
      }, null, 2));
    }
  }
  return { reqId, wsId, prevTaskId, remoteDir, branch };
}

// ──────────────────────────────────────────────
// __fix 工作流注册
// ──────────────────────────────────────────────

describe("__fix 内置工作流", () => {
  it("注册可取（getWorkflow），但 listWorkflows 隐藏", () => {
    const wf = getWorkflow(FIX_WORKFLOW_NAME);
    expect(wf).not.toBeNull();
    expect(wf!.initial_state).toBe("pending_fix");
    expect(wf!.terminal_states).toContain("failed");
    expect(wf!.sandbox?.git).toBe(true);
    expect(listWorkflows().map((w) => w.name)).not.toContain(FIX_WORKFLOW_NAME);
  });

  it("registry reload 后内置工作流仍存活（registerBuiltin 不依赖磁盘发现）", async () => {
    await reload();
    expect(getWorkflow(FIX_WORKFLOW_NAME)).not.toBeNull();
    expect(listWorkflows().map((w) => w.name)).not.toContain(FIX_WORKFLOW_NAME);
  });
});

// ──────────────────────────────────────────────
// fix run 创建 + 端到端（事件触发 → 标准管线 → bridge 汇报）
// ──────────────────────────────────────────────

describe("fix run（标准管线端到端）", () => {
  it("fix_revision 事件 → 创建 kind=fix run（seq 递增、续作交付分支）→ done → 需求回 awaiting_review", async () => {
    const fx = makeDeliveredFixture();
    appendFeedback({ requirement_id: fx.reqId, source: "manual", body: "按钮文案要改成保存" });

    let seenPrompt = "";
    let seenCwd = "";
    _setFixFnForTest(async (prompt, cwd) => {
      seenPrompt = prompt;
      seenCwd = cwd;
      return "已修复并 push";
    });
    enableBus();
    initRequirementTaskBridge();

    setRequirementStatus(fx.reqId, "fix_revision"); // 事件触发 fix run 创建

    await waitFor(() => getRequirementById(fx.reqId)?.status === "awaiting_review", "需求回 awaiting_review");

    const req = getRequirementById(fx.reqId)!;
    expect(req.task_id).not.toBe(fx.prevTaskId);
    const fixTask = getTask(req.task_id!)!;
    expect(fixTask.kind).toBe("fix");
    expect(fixTask.seq).toBe(2);
    expect(fixTask.workflow).toBe(FIX_WORKFLOW_NAME);
    expect(fixTask.status).toBe("done");

    // prompt 含反馈正文 / 仓库布局（交付分支 + 子目录）/ PR 号；cwd = fix run 沙盒根
    expect(seenPrompt).toContain("按钮文案要改成保存");
    expect(seenPrompt).toContain(fx.branch);
    expect(seenPrompt).toContain("子目录 app/");
    expect(seenPrompt).toContain("#7");
    expect(seenCwd).toBe(getTaskSandbox(fixTask.id));

    // 沙盒 = 新 clone 且 checkout 了既有远程交付分支（续作，不从 base 新建）
    const cloneDir = join(getTaskSandbox(fixTask.id), "app");
    expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
    expect(mustGit(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(fx.branch);

    // 续作不重来：远程交付分支仍在、旧 run 的 workspace 未被清
    expect(git(fx.remoteDir, "rev-parse", "--verify", fx.branch).ok).toBe(true);
    expect(existsSync(join(getTaskRoot(fx.prevTaskId), "workspace", "app", "marker.txt"))).toBe(true);

    // 修复总结落需求评论（from_role=agent）
    const agentFb = listFeedbacks(fx.reqId).find((f) => f.from_role === "agent");
    expect(agentFb?.body).toContain("修复完成");
    expect(agentFb?.body).toContain("已修复并 push");
  });

  it("agent 连续同错失败 → runner 确定性止损 failed → 需求 failed 带原因（停下报人）", async () => {
    const fx = makeDeliveredFixture();
    _setFixFnForTest(async () => { throw new Error("agent 崩了"); });
    enableBus();
    initRequirementTaskBridge();

    setRequirementStatus(fx.reqId, "fix_revision");

    // 第一次失败：标准管线不立即终结（留重试机会），failure_count=1、状态停 running_fix
    await waitFor(() => {
      const r = getRequirementById(fx.reqId);
      if (!r?.task_id || r.task_id === fx.prevTaskId) return false;
      const t = getTask(r.task_id);
      return !!t && ((t.failure_count as number | undefined) ?? 0) >= 1;
    }, "fix run 第一次失败落计数");

    const fixTaskId = getRequirementById(fx.reqId)!.task_id!;
    expect(getTask(fixTaskId)!.status).toBe("running_fix");
    expect(getRequirementById(fx.reqId)!.status).toBe("fix_revision");

    // 第二次同指纹失败（模拟 watcher 重试）→ 确定性止损 → task failed → bridge → 需求 failed
    await executePhase(fixTaskId, "fix");
    await waitFor(() => getRequirementById(fx.reqId)?.status === "failed", "需求 failed");

    const r = getRequirementById(fx.reqId)!;
    expect(getTask(fixTaskId)!.status).toBe("failed");
    expect(r.status_reason).toContain("agent 崩了");
  });
});

// ──────────────────────────────────────────────
// artifacts 修复模式（v2 R5：无 PR、有 deliveries → 重做产物 promote round+1）
// ──────────────────────────────────────────────

/** artifacts 夹具：无库需求（项目无 workspace，不会自动派生）、prev run 已交付 round-1、无 PR */
function makeArtifactFixture(): { reqId: string; prevTaskId: string } {
  const reqId = nextRequirementId();
  createRequirement({ id: reqId, project_id: `proj-fx${n}`, workspace_id: null, title: "做个 demo" });
  for (const s of ["clarifying", "ready", "queued", "running", "awaiting_review"]) {
    setRequirementStatus(reqId, s);
  }
  const prevTaskId = `tkart${String(n).padStart(2, "0")}`;
  createTask({
    id: prevTaskId, title: "做个 demo", workflow: "artifact", initialStatus: "done",
    requirementId: reqId, kind: "execution", seq: 1,
  });
  updateRequirement(reqId, { task_id: prevTaskId });
  // round-1 交付（经正式 promote 通道）
  const src = join(tmpHome, `art-src-${n}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.html"), "<html>v1</html>", "utf-8");
  writeFileSync(join(src, "SUMMARY.md"), "首轮交付", "utf-8");
  deliverArtifacts(prevTaskId, src, "首轮交付");
  return { reqId, prevTaskId };
}

describe("artifacts 修复模式（fix run 重做产物）", () => {
  it("端到端：驳回 → fix run 种入上一轮产物 → 重做 → promote round-2 → 回 awaiting_review", async () => {
    const fx = makeArtifactFixture();
    appendFeedback({ requirement_id: fx.reqId, source: "manual", body: "标题颜色改成红色" });

    let seenPrompt = "";
    let seenCwd = "";
    let preSeeded = false;
    _setFixFnForTest(async (prompt, cwd) => {
      seenPrompt = prompt;
      seenCwd = cwd;
      // 框架已把上一轮产物种入 cwd/deliverables/（增量修改语义）
      preSeeded = readFileSync(join(cwd, "deliverables", "index.html"), "utf-8") === "<html>v1</html>";
      writeFileSync(join(cwd, "deliverables", "index.html"), "<html>v2-red</html>", "utf-8");
      writeFileSync(join(cwd, "deliverables", "SUMMARY.md"), "标题已改红", "utf-8");
      return "已按反馈把标题改成红色";
    });
    enableBus();
    initRequirementTaskBridge();

    setRequirementStatus(fx.reqId, "fix_revision"); // 事件触发 fix run（无 .worktree.json 也不 failed）

    await waitFor(() => getRequirementById(fx.reqId)?.status === "awaiting_review", "需求回 awaiting_review");

    const req = getRequirementById(fx.reqId)!;
    const fixTask = getTask(req.task_id!)!;
    expect(fixTask.kind).toBe("fix");
    expect(fixTask.status).toBe("done");

    // artifacts 模式 prompt：反馈 + 重做产物指引，无 git push 要求
    expect(preSeeded).toBe(true);
    expect(seenPrompt).toContain("标题颜色改成红色");
    expect(seenPrompt).toContain("deliverables/");
    expect(seenPrompt).not.toContain("git push");
    expect(seenCwd).toBe(getTaskSandbox(fixTask.id));

    // promote round-2：新内容落需求 deliveries/；round-1 原样保留
    const rounds = listDeliveries(fx.reqId).map((d) => d.round);
    expect(rounds).toEqual([1, 2]);
    expect(readFileSync(join(getDeliveryRoundDir(fx.reqId, 2), "index.html"), "utf-8")).toBe("<html>v2-red</html>");
    expect(readFileSync(join(getDeliveryRoundDir(fx.reqId, 1), "index.html"), "utf-8")).toBe("<html>v1</html>");

    // 修复总结落需求评论（带轮次）
    const agentFb = listFeedbacks(fx.reqId).find((f) => f.from_role === "agent");
    expect(agentFb?.body).toContain("修复完成 · 第 2 轮");
    expect(agentFb?.body).toContain("已按反馈把标题改成红色");
  });

  it("agent 未产出 deliverables/ → fix run 失败（不静默空交付）", async () => {
    const fx = makeArtifactFixture();
    _setFixFnForTest(async (_prompt, cwd) => {
      // 把种入的产物删光，模拟 agent 清空了产物目录
      rmSync(join(cwd, "deliverables"), { recursive: true, force: true });
      return "啥也没做";
    });
    enableBus();
    initRequirementTaskBridge();

    setRequirementStatus(fx.reqId, "fix_revision");

    // 第一次失败留重试；直接对 fix run 再跑一次同指纹失败 → 确定性止损 → 需求 failed
    await waitFor(() => {
      const r = getRequirementById(fx.reqId);
      if (!r?.task_id || r.task_id === fx.prevTaskId) return false;
      const t = getTask(r.task_id);
      return !!t && ((t.failure_count as number | undefined) ?? 0) >= 1;
    }, "fix run 第一次失败落计数");
    const fixTaskId = getRequirementById(fx.reqId)!.task_id!;
    await executePhase(fixTaskId, "fix");
    await waitFor(() => getRequirementById(fx.reqId)?.status === "failed", "需求 failed");
    expect(getRequirementById(fx.reqId)!.status_reason).toContain("未按约定产出");
    // 没有第二轮交付
    expect(listDeliveries(fx.reqId).map((d) => d.round)).toEqual([1]);
  });
});

// ──────────────────────────────────────────────
// startFixRun 守卫路径（无 bus，直接调用）
// ──────────────────────────────────────────────

describe("startFixRun 守卫", () => {
  it("防重入：需求已有活跃（非终态）run → 不创建新 fix run", async () => {
    const fx = makeDeliveredFixture();
    setRequirementStatus(fx.reqId, "fix_revision");
    const activeId = `tkact${String(n).padStart(3, "0")}`;
    createTask({
      id: activeId, title: "修这个", workflow: FIX_WORKFLOW_NAME, initialStatus: "running_fix",
      requirementId: fx.reqId, kind: "fix", seq: 2,
    });
    updateRequirement(fx.reqId, { task_id: activeId });

    await startFixRun(fx.reqId);

    const r = getRequirementById(fx.reqId)!;
    expect(r.task_id).toBe(activeId);          // 未被换成新 run
    expect(r.status).toBe("fix_revision");     // 也没被判失败
  });

  it("无关联 task（task_id 空）→ failed 停下报人", async () => {
    const fx = makeDeliveredFixture({ withPrevTask: false });
    setRequirementStatus(fx.reqId, "fix_revision");

    await startFixRun(fx.reqId);

    const r = getRequirementById(fx.reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toContain("修复执行失败");
  });

  it("上一轮无交付分支记录（.worktree.json 缺失）→ failed 并提示整轮重跑", async () => {
    const fx = makeDeliveredFixture({ withMeta: false });
    setRequirementStatus(fx.reqId, "fix_revision");

    await startFixRun(fx.reqId);

    const r = getRequirementById(fx.reqId)!;
    expect(r.status).toBe("failed");
    expect(r.status_reason).toContain("重新入队");
  });

  it("需求不在 fix_revision → no-op", async () => {
    const fx = makeDeliveredFixture();
    await startFixRun(fx.reqId); // 当前 awaiting_review
    const r = getRequirementById(fx.reqId)!;
    expect(r.status).toBe("awaiting_review");
    expect(r.task_id).toBe(fx.prevTaskId);
  });
});

// ──────────────────────────────────────────────
// daemon 启动补跑
// ──────────────────────────────────────────────

describe("启动补跑", () => {
  it("fix_revision 且无活跃 run → init 扫描补建 fix run（旧模型存量需求兼容路径）", async () => {
    const fx = makeDeliveredFixture();
    setRequirementStatus(fx.reqId, "fix_revision"); // bus 未激活：事件 no-op，模拟 daemon 死前转入
    _setFixFnForTest(async () => "补跑修复完成");

    disposeFixRevisionRunner();
    initFixRevisionRunner(); // 模拟 daemon 重启：扫描 stranded 需求

    await waitFor(() => {
      const r = getRequirementById(fx.reqId);
      return !!r?.task_id && r.task_id !== fx.prevTaskId;
    }, "补建 fix run");

    const fixTask = getTask(getRequirementById(fx.reqId)!.task_id!)!;
    expect(fixTask.kind).toBe("fix");
    expect(fixTask.workflow).toBe(FIX_WORKFLOW_NAME);
    await waitFor(() => getTask(fixTask.id)!.status === "done", "fix run 跑完");
  });

  it("fix_revision 但已有活跃 fix run → init 扫描不重复创建（交标准恢复机制）", async () => {
    const fx = makeDeliveredFixture();
    setRequirementStatus(fx.reqId, "fix_revision");
    const activeId = `tkact${String(n).padStart(3, "0")}`;
    createTask({
      id: activeId, title: "修这个", workflow: FIX_WORKFLOW_NAME, initialStatus: "running_fix",
      requirementId: fx.reqId, kind: "fix", seq: 2,
    });
    updateRequirement(fx.reqId, { task_id: activeId });

    disposeFixRevisionRunner();
    initFixRevisionRunner();
    await new Promise((r) => setTimeout(r, 100)); // 给扫描的异步路径一点时间

    const r = getRequirementById(fx.reqId)!;
    expect(r.task_id).toBe(activeId);
    expect(r.status).toBe("fix_revision");
  });
});

describe("buildFixPrompt 反馈过滤（#9）", () => {
  it("排除 fixer 自产的 from_role=agent 总结，只喂评审/用户反馈", () => {
    const reqId = nextRequirementId();
    createProject({ id: `proj-fb${n}`, name: "fb" });
    createRequirement({ id: reqId, project_id: `proj-fb${n}`, workspace_id: null, title: "修这个" });

    // 用户反馈（appendFeedback source:manual → from_role:user）
    appendFeedback({ requirement_id: reqId, source: "manual", body: "用户要求：按钮文案改成保存" });
    // fixer 上一轮自产的「修复完成」总结（createComment kind=feedback from_role:agent）——不该喂回
    createComment({
      id: nextCommentId(),
      requirement_id: reqId,
      kind: "feedback",
      from_role: "agent",
      body: "修复完成：已改 3 个文件并 push",
      status: "open",
    });

    const prompt = buildFixPrompt(reqId, "修这个", [], [], null);
    expect(prompt).toContain("用户要求：按钮文案改成保存"); // 用户反馈进 prompt
    expect(prompt).not.toContain("修复完成：已改 3 个文件并 push"); // agent 自产被过滤掉
  });
});
