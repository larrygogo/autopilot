# Runner A1：autopilot executor 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 autopilot 的 clone / agent-run / 出 PR 三块执行机制抽成**无状态、可注入 token、dev 产 diff / pr 才 push** 的 executor 核（`src/core/executor/`），供未来的 runner（A2）按 reqgenie 协议逐 round 调用，且不触发任何 autopilot 状态机/DB 副作用。

**Architecture:** 复用而非重写——三块（`ensureCodebase` / `Agent.run` / 出 PR 的 git+gh 机械）已大体解耦，本计划：① 给 `ensureCodebase` 加 token 注入；② 把 `builtin-deliver-pr.ts` 里 git+gh 机械层抽到 `executor/git-ops.ts`（原交付器改为调它 + 自己做 DB 副作用，DRY）；③ 加 dev 产 diff / pr 才 commit-push 的拆分；④ 加 `agent-runner.ts` 用「幽灵 task」（`bindTaskRunRoot` 种根，不建 DB 行、不发 `task:created`）包 `Agent.run`。**runner session 当合成需求、用 `session_id` 当 id**（零布局改动）。

**Tech Stack:** Bun + TypeScript，`bun:test`，git/gh CLI。

**Spec:** `docs/superpowers/specs/2026-06-23-reqgenie-runner-design.md`（§6.2、§4.5、§D6）。

**关键既有事实（实现前必读，已核对）：**
- `src/core/sandbox/codebase.ts`：`ensureCodebase(reqId, wsList, opts)`；`EnsureCodebaseOpts`（97-107）；`cloneRepo`（302-368）内 `resolveGitToken()`（314）解析 token、`buildAuthUrl`（315）注入、clone 后 `remote set-url origin` 抹 token（351-353）。
- `src/core/workflow/builtin-deliver-pr.ts`：`runGit`（17）、`ensurePr`（29）、`makePrDeliverRunner`（54）。后者含 DB 副作用：`updateTask`（139）/`updateRequirement`（143）/`appendSubPr`（123）/`transition`（147）。push 用裸 `git push`（106）、gh 无 token 透传。
- `src/core/sandbox/workspace-health.ts`：`resolveGitToken()`（23，config.git.token > `gh auth token`）、`buildAuthUrl(url, token)`（325，`https://oauth2:<token>@`，仅 https）、`GIT_NONINTERACTIVE_ENV`（8）。
- `src/core/task/context.ts`：`runWithTaskContext(ctx, fn)`（27）、`getCurrentSandboxDir()`（36）。`TaskContext = {taskId, phase, sandboxDir?, signal?}`。
- `src/agents/agent.ts`：`Agent.run(prompt, options?)`（79）取 `getTaskContext()`，用 `ctx.taskId` 调 `getTaskAgentHome`（87）+ `appendAgentCall`（111）。
- `src/core/sandbox/index.ts`：`bindTaskRunRoot(taskId, reqId)`（123，校验两者 `TASK_ID_RE`，种 `taskRootCache`，返回 run root；无 DB 行也可用）、`getTaskAgentHome(taskId)`（280）→ `getTaskRoot`。
- `src/core/task/logs.ts`：`appendAgentCall(taskId, record)`（176）。
- `src/core/db.ts`：`createTask` 强制 emit `task:created`（**executor 不得调它**）。

---

## File Structure

- Create `src/core/executor/git-ops.ts` — 纯 git+gh 机械（runGit / hasChanges / diffStat / pushToRemote(注入 token) / openOrUpdatePr(注入 GH_TOKEN) / buildGhPrArgs）。无 DB、无 emit。
- Create `src/core/executor/submit-pr.ts` — `produceDiff`（dev：产 diff 不提交）、`submitPrPure(repos, opts)`（pr：逐库 commit+push+PR，纯数据返回）。
- Create `src/core/executor/agent-runner.ts` — `runRoundAgent(...)`（幽灵 task 包 `Agent.run`）。
- Create `src/core/executor/index.ts` — barrel 导出公共面。
- Modify `src/core/sandbox/codebase.ts` — `EnsureCodebaseOpts.gitToken?` + `pickCloneToken` + 线程化到 `cloneRepo`。
- Modify `src/core/workflow/builtin-deliver-pr.ts` — 改调 `executor/git-ops.ts` 与 `submit-pr.ts` 的纯核（DRY），DB 副作用层保留在本文件。
- Tests: `tests/executor-token-injection.test.ts`、`tests/executor-git-ops.test.ts`、`tests/executor-submit-pr.test.ts`、`tests/executor-agent-runner.test.ts`。

---

## Task 1：ensureCodebase 注入 git token

**Files:**
- Modify: `src/core/sandbox/codebase.ts`（`EnsureCodebaseOpts` 97-107；`cloneRepo` 302-318）
- Test: `tests/executor-token-injection.test.ts`

- [ ] **Step 1：写失败测试**

```ts
// tests/executor-token-injection.test.ts
import { test, expect } from "bun:test";
import { pickCloneToken } from "../src/core/sandbox/codebase";

test("pickCloneToken: 注入 token 优先于环境解析", () => {
  expect(pickCloneToken("inject-abc")).toBe("inject-abc");
});

test("pickCloneToken: 无注入时回退环境（测试环境无 config/gh → null）", () => {
  // 测试环境无 config.git.token、无 gh 登录 → resolveGitToken() = null
  expect(pickCloneToken(undefined)).toBeNull();
});
```

- [ ] **Step 2：运行确认失败**

Run: `bun test tests/executor-token-injection.test.ts`
Expected: FAIL —— `pickCloneToken` 未导出。

- [ ] **Step 3：实现**

在 `src/core/sandbox/codebase.ts`：`EnsureCodebaseOpts` 加字段（107 行 `timeoutMs?` 后）：
```ts
  /** A 模式：注入 vend token，优先于环境解析（缺省回退 resolveGitToken） */
  gitToken?: string;
```
新增导出（`safeAliasDir` 附近）：
```ts
/** clone token 取值：注入优先，回退 config.git.token > gh auth token。 */
export function pickCloneToken(injected?: string): string | null {
  if (injected && injected.trim()) return injected;
  return resolveGitToken();
}
```
`cloneRepo` 签名加 `gitToken?: string`（在 opts 类型 306 行加 `gitToken?: string`），把 314 行
`const gitToken = resolveGitToken();` 改为 `const gitToken = pickCloneToken(opts.gitToken);`。
`ensureCodebaseInner` 两处调 `cloneRepo`（221-226、245-249）的 opts 各加 `gitToken: opts.gitToken`。

- [ ] **Step 4：运行确认通过**

Run: `bun test tests/executor-token-injection.test.ts` → PASS
Run: `bun run typecheck` → 无错

- [ ] **Step 5：提交**

```bash
git add src/core/sandbox/codebase.ts tests/executor-token-injection.test.ts
git commit -m "feat(executor): ensureCodebase 支持注入 git token（A 模式 vend token 前置）"
```

---

## Task 2：抽出纯 git+gh 机械层 `executor/git-ops.ts`

**Files:**
- Create: `src/core/executor/git-ops.ts`
- Test: `tests/executor-git-ops.test.ts`

- [ ] **Step 1：写失败测试（用本地 bare 远程，不需网络/token）**

```ts
// tests/executor-git-ops.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGit, hasChanges, diffStat, pushToRemote, buildGhPrArgs } from "../src/core/executor/git-ops";

let bare: string, work: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "exec-gitops-"));
  bare = join(base, "bare.git");
  work = join(base, "work");
  runGit(["init", "--bare", "-b", "main", bare], base);
  runGit(["clone", bare, work], base);
  runGit(["config", "user.email", "t@t"], work);
  runGit(["config", "user.name", "t"], work);
  writeFileSync(join(work, "a.txt"), "1\n");
  runGit(["add", "-A"], work);
  runGit(["commit", "-m", "base"], work);
  runGit(["push", "-u", "origin", "main"], work);
});
afterEach(() => { try { rmSync(join(work, ".."), { recursive: true, force: true }); } catch {} });

test("hasChanges：干净树 false，改动后 true", () => {
  expect(hasChanges(work, "main")).toBe(false);
  writeFileSync(join(work, "a.txt"), "2\n");
  expect(hasChanges(work, "main")).toBe(true);
});

test("diffStat：返回非空统计", () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  runGit(["add", "-A"], work);
  expect(diffStat(work, "main")).toContain("a.txt");
});

test("pushToRemote：把交付分支推到远程（file:// 远程, token 走 noop）", () => {
  runGit(["checkout", "-B", "feat/x"], work);
  writeFileSync(join(work, "a.txt"), "2\n");
  runGit(["add", "-A"], work); runGit(["commit", "-m", "c"], work);
  pushToRemote(work, bare, "feat/x", null);            // file:// 远程，token=null
  const branches = runGit(["branch", "-a"], bare).stdout;
  expect(branches).toContain("feat/x");
});

test("buildGhPrArgs：拼出正确的 gh pr create 参数", () => {
  const args = buildGhPrArgs({ title: "T", body: "B", base: "main", head: "feat/x" });
  expect(args).toEqual(["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--head", "feat/x"]);
});
```

- [ ] **Step 2：运行确认失败**

Run: `bun test tests/executor-git-ops.test.ts`
Expected: FAIL —— `../src/core/executor/git-ops` 不存在。

- [ ] **Step 3：实现 `src/core/executor/git-ops.ts`**

```ts
import { buildAuthUrl, GIT_NONINTERACTIVE_ENV } from "../sandbox/workspace-health";

/** 同步跑 git；check=true 时非零退出抛错。返回 {stdout,stderr,exitCode}。 */
export function runGit(args: string[], cwd: string, check = true): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
  const exitCode = proc.exitCode ?? 0;
  if (check && exitCode !== 0) throw new Error(`git 命令失败：git ${args.join(" ")}\nstderr: ${stderr}`);
  return { stdout, stderr, exitCode };
}

/** 相对 origin/<base> 是否有未交付改动（暂存/工作树脏 或 已领先提交）。 */
export function hasChanges(cwd: string, base: string): boolean {
  runGit(["add", "-A"], cwd, false);
  const dirty = runGit(["diff", "--cached", "--quiet", `origin/${base}`], cwd, false).exitCode !== 0;
  const ahead = runGit(["rev-list", "--count", `origin/${base}..HEAD`], cwd, false).stdout.trim() !== "0";
  return dirty || ahead;
}

/** 相对 origin/<base> 的 diff 统计（截断 3000）。 */
export function diffStat(cwd: string, base: string): string {
  return runGit(["diff", `origin/${base}...HEAD`, "--stat"], cwd, false).stdout.slice(0, 3000);
}

/**
 * 推交付分支到远程：注入 token 走 buildAuthUrl 拼临时 auth URL 直接 push 到该 URL，
 * **不碰 origin**（零痕迹，无需用后抹除 origin）。token=null 时用 remoteUrl 原样（公开仓/file://）。
 */
export function pushToRemote(cwd: string, remoteUrl: string, branch: string, token: string | null): void {
  const target = token ? buildAuthUrl(remoteUrl, token) : remoteUrl;
  const r = Bun.spawnSync(["git", "push", target, `HEAD:refs/heads/${branch}`], {
    cwd, stderr: "pipe", env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
  });
  if ((r.exitCode ?? 0) !== 0) {
    const stderr = new TextDecoder().decode(r.stderr ?? new Uint8Array()).trim().replaceAll(target, remoteUrl);
    throw new Error(`git push 失败（分支 ${branch}）：${stderr}`);
  }
}

export interface GhPrInput { title: string; body: string; base: string; head: string; }
/** 纯函数：拼 gh pr create 的 argv（便于单测，不含 token）。 */
export function buildGhPrArgs(i: GhPrInput): string[] {
  return ["pr", "create", "--title", i.title, "--body", i.body, "--base", i.base, "--head", i.head];
}

/** gh pr view 判 OPEN 则更新 body 返回其 url，否则 create。token 经 GH_TOKEN env 注入。失败抛错。 */
export function openOrUpdatePr(cwd: string, i: GhPrInput, token: string | null): string {
  const env = token ? { ...process.env, GH_TOKEN: token } : { ...process.env };
  const view = Bun.spawnSync(["gh", "pr", "view", "--json", "url,state"], { cwd, stderr: "pipe", env });
  const out = new TextDecoder().decode(view.stdout ?? new Uint8Array()).trim();
  let parsed: { url?: string; state?: string } | null = null;
  if (view.exitCode === 0 && out) { try { parsed = JSON.parse(out); } catch { parsed = null; } }
  if (parsed?.state === "OPEN") {
    Bun.spawnSync(["gh", "pr", "edit", "--body", i.body], { cwd, env });
    return parsed.url ?? "";
  }
  const created = Bun.spawnSync(["gh", ...buildGhPrArgs(i)], { cwd, stderr: "pipe", env });
  if ((created.exitCode ?? 0) !== 0) {
    throw new Error(`创建 PR 失败：${new TextDecoder().decode(created.stderr ?? new Uint8Array()).trim()}`);
  }
  return new TextDecoder().decode(created.stdout ?? new Uint8Array()).trim();
}
```

- [ ] **Step 4：运行确认通过**

Run: `bun test tests/executor-git-ops.test.ts` → PASS（gh 相关只测 `buildGhPrArgs`，不跑 live gh）
Run: `bun run typecheck` → 无错

- [ ] **Step 5：提交**

```bash
git add src/core/executor/git-ops.ts tests/executor-git-ops.test.ts
git commit -m "feat(executor): 抽出纯 git+gh 机械层 git-ops（token 经 auth URL/GH_TOKEN 注入）"
```

---

## Task 3：dev 产 diff / pr 才 push 的拆分 `executor/submit-pr.ts`

**Files:**
- Create: `src/core/executor/submit-pr.ts`
- Test: `tests/executor-submit-pr.test.ts`

- [ ] **Step 1：写失败测试**

```ts
// tests/executor-submit-pr.test.ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGit } from "../src/core/executor/git-ops";
import { produceDiff, submitPrPure } from "../src/core/executor/submit-pr";

let bare: string, work: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "exec-pr-"));
  bare = join(base, "bare.git"); work = join(base, "work");
  runGit(["init", "--bare", "-b", "main", bare], base);
  runGit(["clone", bare, work], base);
  runGit(["config", "user.email", "t@t"], work); runGit(["config", "user.name", "t"], work);
  writeFileSync(join(work, "a.txt"), "1\n"); runGit(["add", "-A"], work);
  runGit(["commit", "-m", "base"], work); runGit(["push", "-u", "origin", "main"], work);
  runGit(["checkout", "-B", "feat/x"], work);
});

test("produceDiff：dev 阶段只产 diff，不提交、不推送", () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  const diff = produceDiff(work, "main");
  expect(diff).toContain("a.txt");
  // 未提交：HEAD 仍是 base，远程无 feat/x
  expect(runGit(["rev-list", "--count", "origin/main..HEAD"], work, false).stdout.trim()).toBe("0");
  expect(runGit(["branch", "-a"], bare).stdout).not.toContain("feat/x");
});

test("submitPrPure：commit+push（PR 步骤注入桩），返回纯数据无副作用", async () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  const res = await submitPrPure(
    [{ path: work, remoteUrl: bare, branch: "feat/x", base: "main", primary: true, label: "repo" }],
    { title: "T", bodyFor: () => "B", gitToken: null, openPr: (cwd) => `file://pr/${cwd}` },
  );
  expect(res.failures).toEqual([]);
  expect(res.results).toHaveLength(1);
  expect(res.results[0]!.prUrl).toContain("file://pr/");
  expect(runGit(["branch", "-a"], bare).stdout).toContain("feat/x"); // 已 push
});
```

- [ ] **Step 2：运行确认失败**

Run: `bun test tests/executor-submit-pr.test.ts` → FAIL（模块不存在）

- [ ] **Step 3：实现 `src/core/executor/submit-pr.ts`**

```ts
import { runGit, hasChanges, diffStat, pushToRemote, openOrUpdatePr } from "./git-ops";

/** dev 阶段：相对 origin/<base> 产 diff（不提交不推送）。空改动返回 ""。 */
export function produceDiff(cwd: string, base: string): string {
  runGit(["add", "-N", "."], cwd, false); // 让未跟踪文件进 diff
  return runGit(["diff", `origin/${base}`], cwd, false).stdout;
}

export interface ExecRepo {
  path: string; remoteUrl: string; branch: string; base: string; primary: boolean; label: string;
}
export interface SubmitPrOpts {
  title: string;
  /** 按库生成 PR body（diffStat 由调用方决定是否拼入）。 */
  bodyFor: (repo: ExecRepo, diffStatText: string) => string;
  gitToken: string | null;
  /** 注入点（测试可桩）：默认走 openOrUpdatePr。 */
  openPr?: (cwd: string, repo: ExecRepo, body: string) => string;
}
export interface SubmitPrResult {
  results: Array<{ repo: ExecRepo; prUrl: string; prNumber: number }>;
  failures: string[];
}

/**
 * pr 阶段纯核：逐库 commit+push+开 PR，返回纯数据。
 * **无任何 DB / transition / appendSubPr 副作用**——那些留给调用方（workflow 层 / runner 外壳）。
 */
export async function submitPrPure(repos: ExecRepo[], opts: SubmitPrOpts): Promise<SubmitPrResult> {
  const results: SubmitPrResult["results"] = [];
  const failures: string[] = [];
  for (const r of repos) {
    try {
      if (!hasChanges(r.path, r.base)) continue; // 无改动不开空 PR
      runGit(["add", "-A"], r.path);
      runGit(["commit", "-m", `feat: ${opts.title}`], r.path, false);
      pushToRemote(r.path, r.remoteUrl, r.branch, opts.gitToken);
      const body = opts.bodyFor(r, diffStat(r.path, r.base));
      const prUrl = opts.openPr
        ? opts.openPr(r.path, r, body)
        : openOrUpdatePr(r.path, { title: opts.title, body, base: r.base, head: r.branch }, opts.gitToken);
      const prNumber = Number(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      results.push({ repo: r, prUrl, prNumber });
    } catch (e: unknown) {
      failures.push(`[${r.label}] ${(e as Error).message}`);
    }
  }
  return { results, failures };
}
```

- [ ] **Step 4：运行确认通过**

Run: `bun test tests/executor-submit-pr.test.ts` → PASS
Run: `bun run typecheck` → 无错

- [ ] **Step 5：提交**

```bash
git add src/core/executor/submit-pr.ts tests/executor-submit-pr.test.ts
git commit -m "feat(executor): dev 产 diff / pr 才 commit-push 拆分（submitPrPure 纯数据无副作用）"
```

---

## Task 4：原交付器改调纯核（DRY，证明纯核覆盖既有 PR 路径）

**Files:**
- Modify: `src/core/workflow/builtin-deliver-pr.ts`（用 `git-ops`/`submit-pr` 纯核替换内部 `runGit`/`ensurePr`/逐库循环；保留 `updateTask`/`updateRequirement`/`appendSubPr`/`transition` 副作用层）
- Test: 复用既有 `tests/pr-poller*.test.ts` / 交付相关测试 + 全量回归

- [ ] **Step 1：跑既有相关测试建基线**

Run: `bun test tests/pr-poller.test.ts tests/pr-poller-multi.test.ts`
Expected: PASS（记录当前绿，作为重构不回归基线）

- [ ] **Step 2：重构 `makePrDeliverRunner`**

删本文件内 `runGit`（17-26）、`ensurePr`（29-48），改从 `../executor/git-ops` 导入。逐库循环（98-129）改为构造 `ExecRepo[]` 调 `submitPrPure`（`bodyFor` 内拼 planContext + diffStat + multiNote，逻辑搬自原 111-114；`gitToken` 这里传 `null` 保持既有行为=靠环境 gh，A2 接 runner 时再注入 vend token）。`submitPrPure` 返回后，**副作用层不变**：遍历 `results` 调 `appendSubPr`（120-125 逻辑），取 primary 调 `updateTask`/`updateRequirement`（138-145），最后 `transition`（147-150）。失败/空改动判定沿用 `results.length===0 && failures.length===0` 抛错、`failures.length>0` 抛错（131-136）。

- [ ] **Step 3：跑测试确认无回归**

Run: `bun test tests/pr-poller.test.ts tests/pr-poller-multi.test.ts`
Expected: PASS（与 Step 1 基线一致）
Run: `bun run typecheck` → 无错

- [ ] **Step 4：全量回归（重构触及交付主路径）**

Run: `bun test`
Expected: 与重构前同样的通过集（无新增失败）

- [ ] **Step 5：提交**

```bash
git add src/core/workflow/builtin-deliver-pr.ts
git commit -m "refactor(executor): builtin-deliver-pr 改调 executor 纯核（DRY，副作用层保留在 workflow 层）"
```

---

## Task 5：agent-runner 幽灵 task `executor/agent-runner.ts`

**Files:**
- Create: `src/core/executor/agent-runner.ts`
- Test: `tests/executor-agent-runner.test.ts`

- [ ] **Step 1：写失败测试（桩 Agent，断言 context 注入 + 不发 task:created）**

```ts
// tests/executor-agent-runner.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runRoundAgent } from "../src/core/executor/agent-runner";
import { getCurrentSandboxDir } from "../src/core/task/context";
import { onEvent, offEvent, enableBus, disableBus } from "../src/core/event-bus";

// 桩 Agent：实现 run(prompt) → 读 context 证明注入，返回固定文本
const stubAgent = {
  name: "stub",
  async run(_prompt: string) {
    return { text: `sandbox=${getCurrentSandboxDir() ?? "none"}`, usage: undefined };
  },
} as any;

test("runRoundAgent：注入 sandboxDir 到 context，且不发 task:created", async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "exec-ar-"));
  let sawTaskCreated = false;
  const handler = (ev: { type: string }) => { if (ev.type === "task:created") sawTaskCreated = true; };
  enableBus();                          // 必须激活总线：emit 仅 enableBus 后生效，否则永不触发=假绿
  onEvent("task:created", handler);
  try {
    const res = await runRoundAgent(
      { sessionId: "sess-abc-1", phase: "dev", sandboxDir },
      stubAgent,
      "hi",
    );
    expect(res.text).toBe(`sandbox=${sandboxDir}`);
    expect(sawTaskCreated).toBe(false); // 幽灵 task 不建 DB 行、不发 task:created
  } finally { offEvent("task:created", handler); disableBus(); }
});
```

> 注（已核实 `src/core/event-bus.ts`）：`onEvent(type, handler)` 返回 **void**、退订用 `offEvent(type, handler)`；`emit` 仅在 `enableBus()` 后生效——故本测试先 `enableBus()` 再断言「不发 task:created」，否则 emit 是 no-op 会假绿。

- [ ] **Step 2：运行确认失败**

Run: `bun test tests/executor-agent-runner.test.ts` → FAIL（模块不存在）

- [ ] **Step 3：实现 `src/core/executor/agent-runner.ts`**

```ts
import type { Agent } from "../../agents/agent";
import type { AgentResult, RunOptions } from "../../agents/types";
import { runWithTaskContext } from "../task/context";
import { bindTaskRunRoot } from "../sandbox";

export interface RoundAgentCtx {
  /** reqgenie dev_session id —— 当合成需求 id 用（runtime/requirements/<sessionId>/...） */
  sessionId: string;
  phase: string;
  sandboxDir: string;
  signal?: AbortSignal;
  /** 幽灵 taskId，缺省由 sessionId 派生（同一 session 复用稳定 id，便于 agent-calls.jsonl 累积） */
  ghostTaskId?: string;
}

/** 由 sessionId 派生稳定幽灵 taskId（满足 TASK_ID_RE = [\w-]+）。 */
export function ghostTaskIdFor(sessionId: string): string {
  return `rs-${sessionId}`.replace(/[^\w-]/g, "-");
}

/**
 * 在「幽灵 task」上下文里跑一轮 agent：bindTaskRunRoot 种根（无 DB 行、不调 createTask →
 * 不发 task:created），runWithTaskContext 注入 taskId/phase/sandboxDir/signal，
 * Agent.run 据此解析 agent-home + 落 agent-calls.jsonl。返回 AgentResult，不碰状态机。
 */
export async function runRoundAgent(ctx: RoundAgentCtx, agent: Agent, prompt: string, opts?: RunOptions): Promise<AgentResult> {
  const taskId = ctx.ghostTaskId ?? ghostTaskIdFor(ctx.sessionId);
  bindTaskRunRoot(taskId, ctx.sessionId); // 种 taskRootCache：runtime/requirements/<sessionId>/runs/<taskId>/
  return runWithTaskContext(
    { taskId, phase: ctx.phase, sandboxDir: ctx.sandboxDir, signal: ctx.signal },
    () => agent.run(prompt, opts),
  ) as Promise<AgentResult>;
}
```

- [ ] **Step 4：运行确认通过**

Run: `bun test tests/executor-agent-runner.test.ts` → PASS
Run: `bun run typecheck` → 无错

- [ ] **Step 5：提交**

```bash
git add src/core/executor/agent-runner.ts tests/executor-agent-runner.test.ts
git commit -m "feat(executor): agent-runner 幽灵 task 包 Agent.run（bindTaskRunRoot 种根，不发 task:created）"
```

---

## Task 6：executor barrel + 自包含说明

**Files:**
- Create: `src/core/executor/index.ts`

- [ ] **Step 1：实现 barrel**

```ts
// src/core/executor/ —— A 模式无状态执行核（被 src/daemon/runner/ 的 session-loop 逐 round 调用）。
// 三块：sandbox(经 ensureCodebase gitToken 注入) / agent-runner(幽灵 task) / submit-pr(dev diff·pr push)。
// 红线：本目录不得 import 状态机(state-machine)/调度器(requirement-scheduler)/run-outcome/
// requirement-task-bridge，不调 createTask，不发 phase:*/task:* 事件——副作用归调用方。
export { runRoundAgent, ghostTaskIdFor, type RoundAgentCtx } from "./agent-runner";
export { produceDiff, submitPrPure, type ExecRepo, type SubmitPrOpts, type SubmitPrResult } from "./submit-pr";
export { runGit, hasChanges, diffStat, pushToRemote, openOrUpdatePr, buildGhPrArgs, type GhPrInput } from "./git-ops";
export { pickCloneToken, ensureCodebase, type EnsureCodebaseOpts, type CodebaseRepoState } from "../sandbox/codebase";
```

- [ ] **Step 2：typecheck + 全量测试**

Run: `bun run typecheck` → 无错
Run: `bun test` → 既有通过集不回归 + 新增 4 个 executor 测试全绿

- [ ] **Step 3：提交**

```bash
git add src/core/executor/index.ts
git commit -m "feat(executor): barrel 导出 + 红线注释（无状态、不碰状态机/事件）"
```

---

## 守卫红线测试（防 executor 反向耦合状态机）

- [ ] **Step 1：写静态断言测试**

```ts
// tests/executor-no-statemachine-import.test.ts
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

test("executor 目录不得 import 状态机/调度器/createTask", () => {
  const dir = "src/core/executor";
  const banned = ["state-machine", "requirement-scheduler", "run-outcome", "requirement-task-bridge", "createTask"];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const b of banned) expect(src.includes(b), `${f} 不应含 ${b}`).toBe(false);
  }
});
```

- [ ] **Step 2：运行 + 提交**

Run: `bun test tests/executor-no-statemachine-import.test.ts` → PASS
```bash
git add tests/executor-no-statemachine-import.test.ts
git commit -m "test(executor): 红线守卫——executor 不得耦合状态机/调度器/createTask"
```

---

## Self-Review（计划自检，已执行）

1. **Spec 覆盖**：A1 对应 spec §6.2 executor 三块（token 注入=Task1、submitPR 纯化+commit/push 拆分=Task3/4、agent-runner 幽灵 task=Task5）+ §D6 token 注入（Task1/2/3）+ §4.5 dev 产 diff/pr 才 push（Task3）。✅ 未覆盖项均属 A2/B（runner 协议、reqgenie 侧）——本计划范围外，已在文件头声明。
2. **占位扫描**：无 TBD/TODO；每个改代码步骤含完整代码。唯一「实现前核对」标注 = `onEvent` 签名（Task5 测试），已给出核对命令与微调指引（非占位，是对未读文件的诚实防御）。
3. **类型一致**：`ExecRepo`（submit-pr.ts 定义）在 Task3/4 一致使用；`pickCloneToken`/`gitToken` 贯穿 Task1；`runGit`/`pushToRemote`/`openOrUpdatePr` 在 git-ops 定义、submit-pr 与 builtin-deliver-pr 复用，签名一致。
4. **决策记录**：runner session 当合成需求、`session_id` 作 id（零布局改动）；vend token 在 A1 默认不接（builtin-deliver-pr 传 null 保持现状），A2 接 runner 时注入——A1 只把「能注入」的口子开好。

## 已知边界（交给后续计划）
- **retention**：runner session 的 `runtime/requirements/<sessionId>/` 清理归 A2（session 终态时 `deleteRequirementCodebase(sessionId)`）。
- **gh live 路径**：`openOrUpdatePr` 的真实 gh 调用 A1 不做 live 测（离线不可测），由 C（端到端）覆盖。
- **dev 中间态重启 reset 基线**（spec §4.5）：属 session-loop 重入逻辑，归 A2。
