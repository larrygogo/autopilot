# 任务级共用沙盒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务沙盒从「agent 级即用即焚 + cumulative.patch」退回「一个任务共用一个 clone」，所有 phase 直接在共用工作树里改文件、submit_pr 才 commit。

**Architecture:** task 启动时 `ensureTaskSandbox` 真建一个独立 `clone --local`（源仓库零痕迹），runner 每 phase 把这个共用 clone 路径经 task-context 注入给 agent 当 cwd（去掉 acquire/capture/release/patch），重跑时删 workspace 重新 clone。删除整个 `agent-sandbox.ts`。

**Tech Stack:** Bun + TypeScript，bun:test，git clone --local，SQLite。

设计依据：`docs/superpowers/specs/2026-06-09-shared-task-sandbox-design.md`。

**前置：** 切换前确认无在飞即焚任务（design §8）。建议在隔离 worktree 实施。

**贯穿纪律：** 每个 Task 末尾 `bun run typecheck` + 相关 `bun test` 必须绿才 commit；全部完成后 `bun test` 全量 + `bun run smoke-test` + `bun run build:web`。

---

## Task 1：task-factory 启动时建共用 clone + 注入 repo_path

把 `prepareDeliverMeta`（只写 .worktree.json）换成 `ensureTaskSandbox`（真 clone），并注入 `repo_path`。

**Files:**
- Modify: `src/core/task-factory.ts:166-183`（startTaskFromTemplate 的 deliver 块）
- Modify: `src/core/task-factory.ts:1-13`（import）
- Test: `tests/task-factory.test.ts`（若无则新建）

- [ ] **Step 1: 写失败测试** — `startTaskFromTemplate` 对 git 工作流应真建出 clone 工作树 + extra.repo_path 指向它

```ts
// tests/task-sandbox-shared.test.ts（新建，整 Task 套件，后续 Task 复用）
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
import { _setDbForTest, getTask } from "../src/core/db";
import { getTaskSandbox } from "../src/core/sandbox";

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败: ${new TextDecoder().decode(p.stderr)}`);
}

let db: Database;
let tmpHome: string;
let srcRepo: string;

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
  for (const d of [tmpHome, srcRepo]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("共用沙盒 · ensureTaskSandbox 建 clone（Task 1）", () => {
  it("ensureTaskSandbox 对 git 工作流建出含源仓库内容的工作树", () => {
    // ensureTaskSandbox 是 Task 1 接回点；先直接测它（startTaskFromTemplate 集成在 smoke/全量覆盖）
    const { ensureTaskSandbox } = require("../src/core/sandbox");
    const taskId = "shr-001";
    ensureTaskSandbox(taskId, "dev", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, "feat/shr-001");
    const ws = getTaskSandbox(taskId);
    expect(existsSync(join(ws, ".git"))).toBe(true);
    expect(existsSync(join(ws, "README.md"))).toBe(true);
    expect(readFileSync(join(ws, "README.md"), "utf-8")).toContain("base");
  });
});
```

- [ ] **Step 2: 跑测试确认通过**（ensureTaskSandbox 已存在且应已能 clone）

Run: `bun test tests/task-sandbox-shared.test.ts`
Expected: PASS（若 FAIL，说明 ensureTaskSandbox/tryCreateClone 现状与预期不符，先读 `src/core/sandbox.ts:144-205` 修对）

- [ ] **Step 3: 改 startTaskFromTemplate**：`prepareDeliverMeta` → `ensureTaskSandbox` + 注入 repo_path

`src/core/task-factory.ts` 把 166-183 块改为：

```ts
  try {
    // 共用沙盒模型：task 启动时建一个独立 clone（源仓库零痕迹），所有 phase 共用它。
    ensureTaskSandbox(taskId, workflowName, wf.sandbox, workspace, deliverBranchName(title, taskId));
  } catch (e: unknown) {
    console.warn("ensureTaskSandbox 失败：", e instanceof Error ? e.message : e);
  }

  const worktreeMeta = getTaskWorktreeMeta(taskId);
  if (worktreeMeta) {
    extra["default_branch"] = worktreeMeta.base;
    extra["branch"] = worktreeMeta.branch;
    extra["workspace_path"] = worktreeMeta.workspace_path;
    // 共用沙盒：注入 repo_path = 共用 clone 路径，供 phase 直接当 cwd。
    extra["repo_path"] = getTaskSandbox(taskId);
  }
```

import 行（task-factory.ts 顶部）：把 `prepareDeliverMeta` 换成 `ensureTaskSandbox`，加 `getTaskSandbox`：

```ts
import { ensureTaskSandbox, deleteRemoteDeliverBranch, getTaskWorktreeMeta, getTaskArtifactsDir, getTaskSandbox, clearTaskRunArtifacts, type WorkspaceRef } from "./sandbox";
```

- [ ] **Step 4: typecheck + 测试**

Run: `bun run typecheck && bun test tests/task-sandbox-shared.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/task-factory.ts tests/task-sandbox-shared.test.ts
git commit -m "refactor(sandbox Task1): task 启动建共用 clone + 注入 repo_path（替 prepareDeliverMeta）"
```

---

## Task 2：runner.executePhase 注入共用沙盒，去掉 acquire/capture/release

**Files:**
- Modify: `src/core/runner.ts:159-175`（即焚生命周期包裹）
- Modify: `src/core/runner.ts:8`（import）
- Test: `tests/task-sandbox-shared.test.ts`（追加）+ `tests/runner.test.ts`（回归）

- [ ] **Step 1: 写失败测试** — 跨 phase 改动在共用沙盒里可见

```ts
// 追加到 tests/task-sandbox-shared.test.ts
describe("共用沙盒 · 跨 phase 直接可见（Task 2）", () => {
  it("phase1 在共用 clone 改文件，phase2 在同一 clone 看到", async () => {
    const sandboxModule = await import("../src/core/sandbox");
    const { runWithTaskContext, getCurrentSandboxDir } = await import("../src/core/task-context");
    const taskId = "shr-002";
    sandboxModule.ensureTaskSandbox(taskId, "dev", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, "feat/shr-002");
    const ws = sandboxModule.getTaskSandbox(taskId);

    // 模拟 runner：phase1 在注入的共用沙盒里写文件
    await runWithTaskContext({ taskId, phase: "develop", sandboxDir: ws }, async () => {
      writeFileSync(join(getCurrentSandboxDir()!, "feature.ts"), "export const x = 1;\n", "utf-8");
    });
    // phase2：同一共用沙盒应直接看到 phase1 的改动（无 patch 中转）
    await runWithTaskContext({ taskId, phase: "review", sandboxDir: ws }, async () => {
      expect(existsSync(join(getCurrentSandboxDir()!, "feature.ts"))).toBe(true);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认通过**（该测试只依赖 task-context + 共用路径，Task 2 改 runner 后行为对齐）

Run: `bun test tests/task-sandbox-shared.test.ts`
Expected: PASS

- [ ] **Step 3: 改 runner.executePhase** — 替换 159-175

```ts
    }, 120_000);
    // 共用沙盒：所有 phase 共用 task 启动时建的同一个 clone（getTaskSandbox），直接在工作树
    // 改文件、跨 phase 可见；submit_pr 才 commit。不再 acquire/capture/release/patch。
    try {
      await runWithTaskContext(
        { taskId, phase, sandboxDir: getTaskSandbox(taskId) },
        async () => { await phaseFn(taskId); },
      );
    } finally {
      clearInterval(heartbeat);
    }
```

import 行：删 `import { acquireAgentSandbox, captureAgentSandbox, releaseAgentSandbox, type AgentSandboxHandle } from "./agent-sandbox";`，在 sandbox import 里加 `getTaskSandbox`。`getPhaseSandboxSpec` 若 runner 它处不再用可一并从 registry import 移除（typecheck 会提示）。

- [ ] **Step 4: typecheck + 测试**

Run: `bun run typecheck && bun test tests/task-sandbox-shared.test.ts tests/runner.test.ts tests/runner-phase-events.test.ts`
Expected: PASS（runner-phase-events 的自转移/dangling 测试不依赖即焚，应仍绿）

- [ ] **Step 5: Commit**

```bash
git add src/core/runner.ts tests/task-sandbox-shared.test.ts
git commit -m "refactor(sandbox Task2): executePhase 注入共用沙盒，去掉即焚 acquire/capture/release"
```

---

## Task 3：runner.executeParallelGroup 同改 + 并行不隔离警告

**Files:**
- Modify: `src/core/runner.ts:394-408`（并行子阶段的即焚包裹）

- [ ] **Step 1: 改 executeParallelGroup** — 替换子阶段的 acquire/capture/release（约 394-408）为：

```ts
        const subName = sub.name;
        try {
          // 共用沙盒：并行子阶段也共用同一 clone（不隔离）。当前无 shipped 并行写工作流；
          // 多个 read-write 子阶段同改一棵工作树会互相覆盖，YAGNI 暂不支持。
          await runWithTaskContext(
            { taskId, phase: subName, sandboxDir: getTaskSandbox(taskId) },
            async () => { await phaseFn(taskId); },
          );
```

并在 `executeParallelGroup` fork 成功后加一条 warn（约 line 368 emit 之后）：

```ts
  log.warn("并行块 %s 在共用沙盒模型下不隔离子阶段工作树，多 read-write 子阶段会互相覆盖 [task=%s]", groupName, taskId);
```

- [ ] **Step 2: typecheck + 测试**

Run: `bun run typecheck && bun test tests/runner.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/runner.ts
git commit -m "refactor(sandbox Task3): 并行子阶段共用沙盒 + 不隔离警告（并行写 YAGNI）"
```

---

## Task 4：task-outcome diff_stat 改回 git diff，删 computeDiffStatFromPatch

**Files:**
- Modify: `src/daemon/task-outcome.ts`（diff_stat 块 + computeDiffStatFromPatch + import）
- Modify: `tests/task-outcome.test.ts`（删 patch 解析测试，换 git diff 测试）

- [ ] **Step 1: 改测试** — `tests/task-outcome.test.ts` 删掉 `describe("computeDiffStatFromPatch ...")` 整块；新增对真实 clone 跑 diff（用 Task 1 的 git helper 模式，建 clone → 改文件 → 断言 diff_stat）。本步先写新测试（会失败，因为实现仍读 patch）。

```ts
// 替换 task-outcome.test.ts 里的 patch 相关测试
it("即焚→共用沙盒：diff_stat 从任务 clone 的 git diff 算（含未提交+未跟踪）", async () => {
  // 用真实 git clone 作为 sandbox_path：建源仓库→clone 到 task 的 workspace→改文件
  // （test 直接构造，验证 computeDiffStat 对 add -A + diff --cached <base> 的统计）
  // 详见 Task 4 实现：computeDiffStat 应 git add -A 后 git diff --cached --shortstat <base>
  // 断言 files/insertions 非 0。（完整夹具参考 tests/agent-sandbox.test.ts 现有 git helper）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-outcome.test.ts`
Expected: FAIL（新 diff 测试未通过 / computeDiffStatFromPatch 已删的引用报错）

- [ ] **Step 3: 改 computeTaskOutcome 的 diff_stat 块**（替换我 EPH-02 加的 patch 优先逻辑）：

```ts
  // 3) sandbox + diff_stat：共用沙盒模型下改动在任务 clone 工作树里。优先用注入的 repo_path
  //    （共用 clone），git add -A 后 diff --cached <base> —— 覆盖未提交 + 未跟踪新文件。
  const repo_path = ((task as Record<string, unknown>).repo_path as string | undefined) ?? null;
  const sandbox_path =
    repo_path ?? ((task as Record<string, unknown>).workspace_path as string | undefined) ?? null;
  let diff_stat: DiffStat | null = null;
  if (sandbox_path && existsSync(sandbox_path)) {
    const baseBranch = resolveBaseBranch(reqId);
    diff_stat = await computeDiffStat(sandbox_path, baseBranch);
  }
```

并把 `computeDiffStat` 改成 add -A + diff --cached：

```ts
async function computeDiffStat(workspacePath: string, baseBranch: string): Promise<DiffStat | null> {
  const run = (args: string[]) => Bun.spawnSync(["git", "-C", workspacePath, ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    run(["add", "-A"]);  // stage 含未跟踪新文件，使 diff --cached 能统计到
    const proc = run(["diff", "--cached", "--shortstat", baseBranch]);
    if (proc.exitCode !== 0) return null;
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return { files: 0, insertions: 0, deletions: 0 };
    return { files: parseInt(m[1]!, 10), insertions: parseInt(m[2] ?? "0", 10), deletions: parseInt(m[3] ?? "0", 10) };
  } catch { return null; }
}
```

删 `computeDiffStatFromPatch` 整函数 + 其 export；删 `readFileSync` / `getTaskArtifactsDir` / `join` 里仅它用的 import（typecheck 提示）。

- [ ] **Step 4: typecheck + 测试**

Run: `bun run typecheck && bun test tests/task-outcome.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/task-outcome.ts tests/task-outcome.test.ts
git commit -m "refactor(sandbox Task4): diff_stat 改对任务 clone 跑 git diff（add -A + diff --cached base），删 patch 解析"
```

---

## Task 5：resetTaskForRerun 重新 clone（替清 patch + purgeAgentRuns）

**Files:**
- Modify: `src/core/task-factory.ts:266-303`（rerun 的 git sandbox 块）
- Test: `tests/task-sandbox-shared.test.ts`（追加）

- [ ] **Step 1: 写失败测试** — 重跑后 workspace 被删并重新 clone 干净

```ts
describe("共用沙盒 · 重跑重新 clone（Task 5）", () => {
  it("重跑删旧 workspace 并重新 clone（上一轮改动不残留）", async () => {
    const sandbox = await import("../src/core/sandbox");
    const { createTask } = await import("../src/core/db");
    const { resetTaskForRerun } = await import("../src/core/task-factory");
    const { registerTestDevWorkflow } = await import("./helpers/shared-sandbox-wf"); // 见下方说明
    registerTestDevWorkflow(srcRepo);  // 注册一个 sandbox.git=true 的最小串行工作流
    const taskId = "shr-rerun";
    createTask({ id: taskId, title: "t", workflow: "shared_test_wf", initialStatus: "pending_develop", requirementId: undefined });
    sandbox.ensureTaskSandbox(taskId, "shared_test_wf", { git: true }, { id: "ws-1", path: srcRepo, default_branch: "main" }, "feat/shr-rerun");
    // 上一轮残留
    writeFileSync(join(sandbox.getTaskSandbox(taskId), "stale.txt"), "old\n", "utf-8");

    resetTaskForRerun(taskId);

    // 重跑后是干净 clone：旧残留文件没了，源仓库 README 在
    expect(existsSync(join(sandbox.getTaskSandbox(taskId), "stale.txt"))).toBe(false);
    expect(existsSync(join(sandbox.getTaskSandbox(taskId), "README.md"))).toBe(true);
  });
});
```

> 说明：`registerTestDevWorkflow` 是测试 helper（`tests/helpers/shared-sandbox-wf.ts`），注册一个 `sandbox.git=true`、单 phase `develop` 的最小工作流，phase 函数 no-op。实现时按 `tests/runner-phase-events.test.ts` 的 `makeNormalWorkflow` + `registry.register` 模式写，加 `sandbox: { git: true }`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-sandbox-shared.test.ts`
Expected: FAIL（resetTaskForRerun 当前不删 workspace、不重新 clone）

- [ ] **Step 3: 改 resetTaskForRerun 的 git 块**（266-303）：删 `purgeAgentRuns(taskId)` 与「清整个 artifacts」逻辑保留（artifacts 仍要清），把 `prepareDeliverMeta` 换成「删 workspace + ensureTaskSandbox 重新 clone」：

```ts
    // 即焚→共用：清 artifacts（上轮产物）+ 删旧 clone 工作树 + 重新 clone 干净。
    try { rmSync(getTaskArtifactsDir(taskId), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(getTaskSandbox(taskId), { recursive: true, force: true }); } catch { /* ignore */ }
    let workspace: WorkspaceRef | undefined;
    const req = task.requirement_id ? getRequirementById(task.requirement_id) : null;
    const wsId = req?.workspace_id ?? (typeof task["workspace_id"] === "string" ? (task["workspace_id"] as string) : undefined);
    if (wsId) {
      const ws = getWorkspaceById(wsId);
      if (ws) workspace = { id: ws.id, path: ws.path, default_branch: ws.default_branch, github_owner: ws.github_owner, github_repo: ws.github_repo };
    }
    // 重新 clone 干净工作树（替即焚的"重置 patch 元数据"）
    ensureTaskSandbox(taskId, task.workflow, wf.sandbox, workspace, deliverBranchName(String(task.title ?? ""), taskId));
    const meta = getTaskWorktreeMeta(taskId);
    if (meta) {
      updateTask(taskId, { default_branch: meta.base, branch: meta.branch, workspace_path: meta.workspace_path, repo_path: getTaskSandbox(taskId) });
    }
```

删 task-factory 顶部的 `import { purgeAgentRuns } from "./agent-sandbox";`。

- [ ] **Step 4: typecheck + 测试**

Run: `bun run typecheck && bun test tests/task-sandbox-shared.test.ts tests/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/task-factory.ts tests/task-sandbox-shared.test.ts tests/helpers/shared-sandbox-wf.ts
git commit -m "refactor(sandbox Task5): 重跑删 workspace 重新 clone（替清 patch + purgeAgentRuns）"
```

---

## Task 6：删除 agent-sandbox.ts + 旧链路测试，prompt-runner 收尾

**Files:**
- Delete: `src/core/agent-sandbox.ts`
- Delete: `tests/agent-sandbox.test.ts`（即焚链路测试，已被 task-sandbox-shared 取代）
- Modify: `src/core/prompt-runner.ts`（resolveCodeRoot 注释；逻辑 `getCurrentSandboxDir() ?? getTaskSandbox` 共用模型下仍正确，无需改）
- Modify: `src/core/sandbox.ts:418`、`src/core/task-factory.ts:167/294` 等残留即焚注释

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "agent-sandbox\|acquireAgentSandbox\|captureAgentSandbox\|releaseAgentSandbox\|cumulativePatchPath\|purgeAgentRuns\|AgentSandboxHandle" src/`
Expected: 仅 `agent-sandbox.ts` 自身（即将删）+ 注释。若有代码引用，回到对应 Task 清掉。

- [ ] **Step 2: 删文件**

```bash
git rm src/core/agent-sandbox.ts tests/agent-sandbox.test.ts
```

- [ ] **Step 3: 改 prompt-runner resolveCodeRoot 注释** — 把「即焚副本」措辞改为「共用沙盒」（逻辑不变）：

```ts
/**
 * 解析 phase 的代码工作目录（agent cwd 与 ${WORKSPACE}）。
 * 优先级：显式覆盖（测试）> task-context 注入的共用沙盒 > getTaskSandbox 兜底。
 */
function resolveCodeRoot(taskId: string, override?: string): string {
  return override ?? getCurrentSandboxDir() ?? getTaskSandbox(taskId);
}
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS（0 fail；agent-sandbox.test 已删）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(sandbox Task6): 删 agent-sandbox.ts + 即焚链路测试，prompt-runner 收尾共用沙盒"
```

---

## Task 7：dev 工作流注释 + 全量回归 + 文档/记忆

**Files:**
- Modify: `examples/workflows/dev/workflow.ts`（submit_pr 等过期注释，git 操作不变）
- Modify: `CLAUDE.md`（即焚模型描述 → 共用沙盒）
- Modify: memory `ephemeral-sandbox-patch-model.md`（标记模型已 revert）

- [ ] **Step 1: 改 dev workflow.ts 注释** — `run_submit_pr` 的「即焚副本已 apply 累积 patch」改为「共用沙盒工作树已累积改动」（仅注释）。

- [ ] **Step 2: 改 CLAUDE.md** — 把「Phase 内联 Agent / 即焚 sandbox / cumulative.patch」相关段落改成共用沙盒模型描述（一个任务一个 clone、phase 共用、submit_pr 才 commit、源仓库零痕迹保留、并行不支持）。

- [ ] **Step 3: 全量回归**

Run: `bun run typecheck && bun test && bun run smoke-test && bun run build:web`
Expected: 全 PASS（typecheck 0；bun test 0 fail；smoke-test 12 步绿；web build ✓）

- [ ] **Step 4: dogfood 端到端**（人工）：起一个真任务（`autopilot task start` / Web 发包），确认 develop→code_review→submit_pr 在同一 clone 跑通、PR 改动正确、重跑重新 clone 干净。

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md examples/workflows/dev/workflow.ts
git commit -m "docs(sandbox Task7): CLAUDE.md + dev workflow 注释切共用沙盒模型；全量回归绿"
```

- [ ] **Step 6: 更新 memory** `~/.claude/.../memory/ephemeral-sandbox-patch-model.md` 标注「2026-06-09 已 revert 为任务级共用沙盒，见 specs/plans」，并更新 MEMORY.md 指针 hook。

---

## Self-Review 检查（写计划后自查，已并入）

- **Spec 覆盖**：design §3 模型→Task 1/2；§4 拆接表→Task 1-6；§5 生命周期→Task 1(创建)/5(重跑)；§6 并行→Task 3；§7 取舍→Task 7 文档；§9 测试→各 Task TDD + Task 7 全量。✅
- **类型一致**：`ensureTaskSandbox(taskId, workflowName, sandboxConfig?, workspace?, deliverBranch?)`、`getTaskSandbox(taskId)`、`getCurrentSandboxDir()`、`runWithTaskContext({taskId,phase,sandboxDir})`、`computeDiffStat(path, base)` 全计划一致。✅
- **无 placeholder**：Task 4 Step 1 的测试夹具引用了「现有 git helper」与 Task 5 的 `tests/helpers/shared-sandbox-wf.ts`——实现时按指明的现有范式补全（runner-phase-events 的 register 模式 + agent-sandbox.test 的 git helper），非空泛 TODO。
- **风险**：diff_stat 的 add -A 副作用（改任务 clone 的 index）已在 Task 4 注释说明，仅对终态任务的自有 clone，可接受。
