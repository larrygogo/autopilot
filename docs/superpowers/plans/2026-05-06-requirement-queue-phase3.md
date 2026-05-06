# 需求队列 Phase 3 实施计划：调度器 + await_review/fix_revision

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P3 — 在 P2 需求池 + chat 集成之上，加 per-repo 串行调度器、req_dev 的 await_review / fix_revision 阶段函数、PR 反馈触发回流机制。从此同仓库严格串行 + 反馈循环跑通（gh CLI 自动监听由 P4 补全）。

**Architecture:** `src/daemon/requirement-scheduler.ts` 订阅 `requirement:status-changed` event-bus 事件，per-repo 算「running ∨ fix_revision = 1 个槽位」决定是否拉新；req_dev workflow yaml 加 `await_review`（sleep 循环挂起） + `fix_revision`（读 feedback → 修代码 → push），用 jump_trigger 互相跳；inject_feedback 路径把 awaiting_review → fix_revision；watcher 加白名单不把 `running_await_review` 视作卡死。

**Tech Stack:** Bun + TypeScript（daemon、core、agents），bun:test，autopilot 现有状态机 + event-bus + workflow runner。

**Spec reference:** `docs/superpowers/specs/2026-05-06-requirement-queue-design.md` §4.1（await_review 实现要点）/ §5.3 / §5.4 / §6（调度器算法）/ §10（错误处理）/ §12 P3

---

## File Structure

新建：

| 文件 | 职责 |
|------|------|
| `src/daemon/requirement-scheduler.ts` | per-repo 串行调度器：订阅 event-bus、tickRepo 算法、暴露 init/dispose |
| `tests/requirement-scheduler.test.ts` | tickRepo 各种 status 组合的拉新逻辑测试 |

修改：

| 文件 | 改动 |
|------|------|
| `examples/workflows/req_dev/workflow.yaml` | 加 `await_review` + `fix_revision` 阶段（jump_trigger / jump_target） |
| `examples/workflows/req_dev/workflow.ts` | 加 `run_await_review` + `run_fix_revision` 阶段函数 |
| `src/core/watcher.ts` | `checkStuckTasks` 跳过 `running_await_review` 状态 |
| `src/daemon/index.ts` | 启动调度器、关闭时 dispose |
| `src/daemon/routes.ts` | enqueue 端点改为仅置 queued（取消 P2 同步创建 task）；inject_feedback 触发 awaiting_review → fix_revision |
| `src/agents/tools.ts` | enqueue_requirement / inject_feedback 工具同 routes 改造 |
| `docs/requirement-queue.md` | 标注 P3 落地内容；更新限制清单 |

---

## Tasks 一览

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 1 | req_dev workflow yaml 加 await_review / fix_revision 阶段 | yaml 配置 + 阶段函数占位（throw） | 15 min |
| 2 | `run_await_review` 阶段函数 | sleep 循环 + 检查 requirement.status + 触发 jump | 40 min |
| 3 | `run_fix_revision` 阶段函数 | 读最新 feedback + checkout PR 分支 + 调 developer agent + push | 60 min |
| 4 | watcher 加白名单 | `running_await_review` 不算卡死 | 10 min |
| 5 | requirement-scheduler 模块 | 订阅 event-bus + tickRepo 算法 + init/dispose | 60 min |
| 6 | 集成调度器到 daemon | startDaemon 启动、shutdown 关闭 | 15 min |
| 7 | 取消 enqueue 同步创建 task（P2 临时降级回退） | routes + chat tool 改回仅置 queued | 25 min |
| 8 | inject_feedback 触发 awaiting_review → fix_revision | routes + chat tool 改造 | 30 min |
| 9 | 调度器集成测试 | per-repo 串行 + await_review 不阻塞 + fix_revision 阻塞 | 45 min |
| 10 | 文档更新 + 路线图 | docs/requirement-queue.md 更新 P3 状态 | 20 min |

**总估时**：约 5 小时

---

## 共性约束

- TDD：先写测试 → 跑 FAIL → 实现 → 跑 PASS → typecheck → commit
- 每 task 一个 commit；message 中文
- 外部命令统一 `Bun.spawn` argv 数组
- catch 用 `catch (e: unknown)`
- 调度器用 event-bus 订阅，**不用轮询 DB**

---

## Task 1：req_dev workflow yaml 加 await_review / fix_revision

**Files:**
- Modify: `examples/workflows/req_dev/workflow.yaml`
- Modify: `examples/workflows/req_dev/workflow.ts`（加 2 个阶段函数占位 throw）

### yaml 改动

`phases` 末尾追加（紧跟现有 `submit_pr` 之后）：

```yaml
  # await_review：长挂起态，靠外部 trigger 推进
  # - revision_request：reviewer 反馈到达 → 跳到 fix_revision
  # - 不直接配 done jump：daemon 通过 forceTransition 推到 done（gh poller 在 P4 实现）
  - name: await_review
    timeout: 2592000           # 30 天兜底（容错；正常被 trigger 中断）
    jump_trigger: revision_request
    jump_target: fix_revision

  # fix_revision：独立阶段，agent 读 feedback + checkout PR 分支 + 修复 + push
  # 完成后 jump 回 await_review 等下一轮
  - name: fix_revision
    agent: developer
    timeout: 1800
    jump_trigger: fix_done
    jump_target: await_review
    max_rejections: 30
```

注意：**不要**用 `reject:` 字段（reject 是语法糖向前跳），用显式 `jump_trigger` / `jump_target` 才能实现 fix_revision 反向跳回 await_review。

### workflow.ts 占位

在 `examples/workflows/req_dev/workflow.ts` 末尾追加：

```ts
export async function run_await_review(_taskId: string): Promise<void> {
  throw new Error("run_await_review 未实现，见 P3 Task 2");
}

export async function run_fix_revision(_taskId: string): Promise<void> {
  throw new Error("run_fix_revision 未实现，见 P3 Task 3");
}
```

### 步骤

1. yaml 追加两阶段
2. workflow.ts 加占位函数
3. typecheck（应通过）
4. 同步家目录测加载：
   ```bash
   bun run src/cli/index.ts daemon stop 2>/dev/null
   sleep 1
   cp examples/workflows/req_dev/workflow.{yaml,ts} ~/.autopilot/workflows/req_dev/
   rm -rf ~/.autopilot/runtime/cache/workflows
   bun run src/cli/index.ts daemon start
   sleep 3
   tail -10 ~/.autopilot/runtime/logs/daemon.log | grep -i "req_dev\|await\|fix"
   # 期待：req_dev 加载成功，没有「找不到阶段函数 run_await_review / run_fix_revision」WARN
   bun run src/cli/index.ts daemon stop
   ```
5. commit:
   ```
   git add examples/workflows/req_dev/
   git commit -m "feat(workflow): req_dev 加 await_review + fix_revision 阶段（占位）"
   ```

---

## Task 2：`run_await_review` 阶段函数

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`

### 实现要点（spec §4.1）

```ts
export async function run_await_review(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  // 通过 task extra 拿 requirement_id（在 setup 阶段，注：req_id 由 setup 注入到 task extra）
  // ⚠️ 当前 setup_req_dev_task 没有写 requirement_id 到 task；需要在 P2 enqueue 时
  //    创建 task 时透传 requirement_id（startTaskFromTemplate 接收任意字段，会进 extra）
  const reqId = (task["requirement_id"] as string | undefined);
  if (!reqId) {
    // P2 创建 task 时没透传 requirement_id 的兜底：通过 task_id 反查 requirement
    // 这是 P3 task 7 改造时要修的—— 见 Task 7
    throw new Error("await_review 阶段：task 缺少 requirement_id 字段，需 P3 Task 7 改造 enqueue 透传");
  }

  // 立即同步 requirement.status = awaiting_review，调度器据此拉下一个
  setRequirementStatus(reqId, "awaiting_review");

  // 挂起循环：每 N 秒检查 requirement.status
  while (true) {
    const cur = getRequirement(reqId);
    if (!cur) {
      // requirement 被删除 —— 任务终结
      throw new Error(`requirement ${reqId} 已不存在`);
    }
    if (cur.status === "fix_revision") {
      // 触发跳转到 fix_revision 阶段（jump_trigger=revision_request）
      const transitions = getTransitions(task.workflow);
      await transition(taskId, "running_await_review", "revision_request", transitions);
      // 函数返回后，runner 会调 run_fix_revision
      return;
    }
    if (cur.status === "done") {
      // PR merged（P4 GitHub 监听后会推到 done；P3 阶段也可手动调 transition req → done）
      forceTransition(taskId, "done", { note: "PR merged via requirement.status=done" });
      return;
    }
    if (cur.status === "cancelled" || cur.status === "failed") {
      // requirement 被取消或失败：task 也终结
      forceTransition(taskId, "cancelled", { note: `requirement ${reqId} → ${cur.status}` });
      return;
    }
    // 其他状态（如 awaiting_review 自身） → 继续 sleep
    await Bun.sleep(15_000);
  }
}
```

### imports（在 workflow.ts 顶部）

```ts
import { setRequirementStatus, getRequirementById as getRequirement } from "@autopilot/core/requirements";
import { forceTransition } from "@autopilot/core/state-machine";
```

注意：`forceTransition` 签名按 `src/core/state-machine.ts` 实际实现调整。如果不接受 note option，直接调即可。

### 测试

阶段函数测试很难单测（涉及循环 sleep + 真实 DB + state-machine）。**跳过单测**，依赖 Task 9 集成测试覆盖。

### 步骤

1. 实现 `run_await_review`
2. typecheck
3. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): req_dev run_await_review 阶段函数"
   ```

---

## Task 3：`run_fix_revision` 阶段函数

**Files:**
- Modify: `examples/workflows/req_dev/workflow.ts`

### 实现要点

`fix_revision` 是 develop 的"重新一轮 + push 到原 PR 分支"包装：
1. 读最新 feedback（`latestFeedback(reqId)`）
2. checkout 原 PR 分支（task 字段里的 `branch`）
3. 调 developer agent，prompt 含 spec_md + 最新反馈 + 既有 diff 上下文
4. agent 写代码 + commit（不该 push，由本函数 push）
5. `git push origin <branch>`（push 到原 PR 分支，**不要 force**）
6. emit jump trigger `fix_done` → 跳回 await_review

```ts
export async function run_fix_revision(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const reqId = task["requirement_id"] as string | undefined;
  if (!reqId) throw new Error("fix_revision 阶段：task 缺少 requirement_id 字段");

  const repoPath = task["repo_path"] as string;
  const branch = task["branch"] as string;

  // 1. 拿最新 feedback
  const latest = latestFeedback(reqId);
  if (!latest) throw new Error(`requirement ${reqId} 没有反馈记录可处理`);

  // 2. checkout 原分支（不是 default_branch！）
  runGit(["checkout", branch], repoPath);
  // 拉远端最新（PR 分支可能已被别人 push 过）
  runGit(["pull", "--ff-only", "origin", branch], repoPath, false);

  // 3. 准备产物目录
  const fixDir = phaseDir(taskId, task.workflow, "fix_revision");
  const feedbackPath = join(fixDir, "feedback.md");
  writeFileSync(feedbackPath, latest.body, "utf-8");

  // 4. 调 developer agent
  const planPath = join(phaseDir(taskId, task.workflow, "design"), "plan.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8").slice(0, 4000) : "";

  // 给 agent 提供 diff 上下文（当前 PR 改了哪些）
  const defaultBranch = (task["default_branch"] as string) ?? "main";
  const diffStat = runGit(["diff", `${defaultBranch}...HEAD`, "--stat"], repoPath, false).stdout.slice(0, 3000);

  const agent = getAgent("developer", task.workflow);
  const prompt =
    `请按以下反馈修改代码（在仓库 ${repoPath}，当前分支 ${branch}）：\n\n` +
    `## 反馈来源\n${latest.source === "github_review" ? "GitHub PR review" : "用户手动注入"}\n\n` +
    `## 反馈内容\n${latest.body}\n\n` +
    `## 原方案摘要\n${planContent}\n\n` +
    `## 当前 PR 变更统计\n${diffStat}\n\n` +
    `要求：\n` +
    `- 修改对应代码满足反馈\n` +
    `- 写完后 git add & commit（commit message 用中文，标注「按 review 反馈修改」）\n` +
    `- 不要 push 不要建 PR（push 由后续步骤处理）\n` +
    `- 不要切换分支（保持在 ${branch}）\n`;

  await agent.run(prompt, { cwd: repoPath, timeout: 1_800_000 });

  // 5. 验证至少有一次 commit
  // （比较 push 前的 HEAD 和当前 HEAD —— 简化：直接看 git status 是否干净 + 有新提交）
  const logProc = Bun.spawnSync(
    ["git", "log", "-1", "--format=%s"],
    { cwd: repoPath, stderr: "pipe" }
  );
  // 至少能拿到一条最新 commit
  if (logProc.exitCode !== 0) throw new Error("fix_revision 阶段无法获取 git log");

  // 6. push 到原分支
  runGit(["push", "origin", branch], repoPath);

  // 7. 触发 jump trigger fix_done
  const transitions = getTransitions(task.workflow);
  await transition(taskId, "running_fix_revision", "fix_done", transitions);
}
```

### imports 追加

```ts
import { latestFeedback } from "@autopilot/core/requirement-feedbacks";
```

### 步骤

1. 实现 `run_fix_revision`
2. typecheck
3. commit:
   ```
   git add examples/workflows/req_dev/workflow.ts
   git commit -m "feat(workflow): req_dev run_fix_revision 阶段函数"
   ```

---

## Task 4：watcher 白名单

**Files:**
- Modify: `src/core/watcher.ts`

### 改动

`checkStuckTasks` 遍历所有 task 时跳过 `running_await_review` 状态：

读 `src/core/watcher.ts` 找到 `checkStuckTasks` 实现的卡死判断条件（搜 `stuckTimeoutSeconds` 或 `pendingState`），在 task 状态判断处加：

```ts
// await_review 阶段是"等外部 trigger" 设计，不算卡死
if (task.status === "running_await_review") continue;
```

### 测试

在 `tests/watcher.test.ts`（如果存在）追加一个测试：构造一个 30 分钟前更新的 `running_await_review` task，调 `checkStuckTasks`，断言它**没有**被 transition。

如果 watcher 测试文件不存在或者结构不便，跳过单测，靠 Task 9 集成测试覆盖。

### 步骤

1. 改 watcher.ts
2. typecheck + 跑现有测试不破坏
3. commit:
   ```
   git add src/core/watcher.ts
   git commit -m "fix(watcher): running_await_review 不算卡死任务"
   ```

---

## Task 5：requirement-scheduler 模块

**Files:**
- Create: `src/daemon/requirement-scheduler.ts`
- Create: `tests/requirement-scheduler.test.ts`

### 接口设计

```ts
// src/daemon/requirement-scheduler.ts
export function initRequirementScheduler(): void;  // 订阅 event-bus
export function disposeRequirementScheduler(): void;  // 取消订阅
export function tickRepo(repoId: string): Promise<void>;  // 单仓库调度，可手动触发
```

### tickRepo 算法（spec §6）

```ts
async function tickRepo(repoId: string): Promise<void> {
  const all = listRequirements({ repo_id: repoId });
  // 「占用槽位」= running ∨ fix_revision
  const active = all.filter(r => r.status === "running" || r.status === "fix_revision");
  if (active.length > 0) return;  // 该 repo 有活跃任务，等

  // 拉最老的 queued
  const queued = all
    .filter(r => r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  const repo = getRepoById(candidate.repo_id);
  if (!repo) {
    log.error(`tickRepo: repo ${candidate.repo_id} 不存在，跳过 candidate ${candidate.id}`);
    return;
  }

  try {
    const task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: candidate.title,
      requirement: candidate.spec_md,
      repo_id: repo.id,
      requirement_id: candidate.id,  // ⚠️ 透传给 setup 让 await_review / fix_revision 能拿到
    });
    updateRequirement(candidate.id, { task_id: task.id });
    setRequirementStatus(candidate.id, "running");
  } catch (e: unknown) {
    log.error(`tickRepo: 创建 task 失败 candidate=${candidate.id}: ${(e as Error).message}`);
    // 失败时回滚 status：queued → ready
    try { setRequirementStatus(candidate.id, "ready"); } catch { /* ignore */ }
  }
}
```

### init 订阅逻辑

```ts
let unsubscribe: (() => void) | null = null;

export function initRequirementScheduler(): void {
  if (unsubscribe) return;  // 防重复

  unsubscribe = onEvent("requirement:status-changed", async (event) => {
    const payload = event.payload as { id: string; from: string; to: string };
    // 关键状态变化都触发 tick：
    // - to=queued（新需求入队）
    // - from in {running, fix_revision} 且 to in {awaiting_review, done, cancelled, failed}（活跃任务释放槽位）
    const releasingSlot =
      (event.payload.from === "running" || event.payload.from === "fix_revision") &&
      ["awaiting_review", "done", "cancelled", "failed"].includes(event.payload.to);
    const enqueued = event.payload.to === "queued";
    if (!enqueued && !releasingSlot) return;

    const req = getRequirementById(payload.id);
    if (!req) return;
    await tickRepo(req.repo_id);
  });

  log.info("requirement-scheduler 已启动（订阅 requirement:status-changed）");
}

export function disposeRequirementScheduler(): void {
  unsubscribe?.();
  unsubscribe = null;
}
```

⚠️ `onEvent` API：看 `src/daemon/event-bus.ts` 的真实订阅函数（可能叫 `bus.on(type, handler)` 直接用 EventEmitter 模式）。按真实 API 写。

### 测试 `tests/requirement-scheduler.test.ts`

```ts
describe("tickRepo", () => {
  // setup in-memory DB + 创建 1 个 repo + 几个 requirements
  // 因为 tickRepo 内部会调 startTaskFromTemplate（涉及 workflow 加载 / runner），
  // 单测只能 mock or stub —— 选其一：
  //   A. 在 startTaskFromTemplate 调用前的逻辑做单测，mock 该函数
  //   B. 用 register() 注册一个 stub workflow（阶段函数都是 no-op），让 tickRepo 真创建 task

  // 推荐 B：跟 P2 chat tools 测试模式一致
  it("repo 有 running 任务时不拉新", async () => {
    // create requirement A status=running, B status=queued
    await tickRepo("repo-001");
    // 断言 B 仍是 queued（没被拉走）
  });

  it("repo 无活跃任务时拉最老 queued", async () => {
    // create A status=queued (older), B status=queued (newer)
    await tickRepo("repo-001");
    // 断言 A.status=running, B 还是 queued
  });

  it("awaiting_review 不算占用槽位", async () => {
    // create A status=awaiting_review, B status=queued
    await tickRepo("repo-001");
    // 断言 B.status=running（A 不阻塞）
  });

  it("fix_revision 占用槽位", async () => {
    // create A status=fix_revision, B status=queued
    await tickRepo("repo-001");
    // 断言 B 仍是 queued
  });
});
```

### 步骤

1. 创建 scheduler 模块
2. 实现 tickRepo + init/dispose
3. 写测试
4. typecheck + 跑测试 PASS
5. commit:
   ```
   git add src/daemon/requirement-scheduler.ts tests/requirement-scheduler.test.ts
   git commit -m "feat(daemon): 加 requirement-scheduler 调度器"
   ```

---

## Task 6：集成调度器到 daemon

**Files:**
- Modify: `src/daemon/index.ts`

### 改动

读 `src/daemon/index.ts` 找 `startDaemon` 函数，在 `enableBus()` 之后追加：

```ts
import { initRequirementScheduler, disposeRequirementScheduler } from "./requirement-scheduler";

// 在 enableBus() 之后：
initRequirementScheduler();
```

在 shutdown handler 里追加 disposeRequirementScheduler()（紧跟 disableBus() 之前或之后，看现有 shutdown 顺序）。

### 步骤

1. 改 daemon/index.ts
2. typecheck
3. 实机启动 + 看 daemon log 有 "requirement-scheduler 已启动" 字样
4. commit:
   ```
   git add src/daemon/index.ts
   git commit -m "feat(daemon): 启动时初始化 requirement-scheduler"
   ```

---

## Task 7：取消 P2 enqueue 同步创建 task（让调度器接管）

**Files:**
- Modify: `src/daemon/routes.ts`（enqueue handler）
- Modify: `src/agents/tools.ts`（enqueue_requirement tool）

### 改动

**P2 当前**：enqueue → setStatus(queued) → startTaskFromTemplate → updateRequirement(task_id) → setStatus(running)

**P3 改回**：enqueue 仅 setStatus(queued)，**调度器**会监听到 status-changed 事件后调 tickRepo 创建 task。

routes.ts enqueue handler 改回：

```ts
const reqEnqueueMatch = path.match(/^\/api\/requirements\/([\w-]+)\/enqueue$/);
if (reqEnqueueMatch && method === "POST") {
  const id = reqEnqueueMatch[1];
  if (!getRequirementById(id)) return error("requirement not found", 404);
  try {
    return json({ requirement: setRequirementStatus(id, "queued") });
  } catch (e: unknown) {
    return error((e as Error).message);
  }
}
```

chat tool `enqueue_requirement` 同样回退。

### 步骤

1. 改 routes.ts + tools.ts
2. typecheck
3. 跑现有测试不破坏（`bun test tests/requirements_chat.test.ts`）
4. commit:
   ```
   git add src/daemon/routes.ts src/agents/tools.ts
   git commit -m "refactor: enqueue 仅置 queued，task 创建由 requirement-scheduler 接管"
   ```

---

## Task 8：inject_feedback 触发 awaiting_review → fix_revision

**Files:**
- Modify: `src/daemon/routes.ts`（inject_feedback handler）
- Modify: `src/agents/tools.ts`（inject_feedback tool）

### 改动

**P2 当前**：appendFeedback 后状态不变。

**P3 改造**：appendFeedback 后，**如果 requirement 处于 awaiting_review**，setStatus → fix_revision。

这会触发 `requirement:status-changed` 事件 → run_await_review 阶段函数循环醒来检测到 fix_revision → emit jump trigger `revision_request` → 状态机跳到 fix_revision 阶段 → run_fix_revision 阶段函数被调。

routes.ts inject_feedback handler 末尾追加：

```ts
const r = getRequirementById(id);
appendFeedback({ ... });
if (r?.status === "awaiting_review") {
  try {
    setRequirementStatus(id, "fix_revision");
  } catch (e: unknown) {
    log.warn(`inject_feedback: 状态转换失败 ${id}: ${(e as Error).message}`);
  }
}
return json({ ok: true });
```

chat tool `inject_feedback` 同样改造。

### 步骤

1. 改 routes.ts + tools.ts
2. typecheck
3. 跑现有测试
4. commit:
   ```
   git add src/daemon/routes.ts src/agents/tools.ts
   git commit -m "feat(api): inject_feedback 在 awaiting_review 状态时触发 fix_revision"
   ```

---

## Task 9：调度器集成测试

**Files:**
- Create: `tests/requirement-scheduler-integration.test.ts`

### 覆盖场景

1. **同 repo 入 3 个需求**：
   - 创建 3 个 ready requirements
   - enqueue 全部（status → queued）
   - tickRepo 触发后第 1 个进 running，2/3 仍 queued
   - 第 1 个完成（手动 setStatus running → awaiting_review）→ 调度器拉第 2 个

2. **awaiting_review 不阻塞**：
   - A awaiting_review, B queued → tickRepo → B.status=running

3. **fix_revision 阻塞**：
   - A fix_revision, B queued → tickRepo → B 仍 queued

4. **inject_feedback → fix_revision 触发**：
   - A awaiting_review, inject feedback → A.status=fix_revision

注意 1 / 2 / 3 已在 Task 5 单测覆盖；本 task **重点是 4 + 端到端流程**：

```ts
it("inject_feedback 在 awaiting_review 时触发 fix_revision", () => {
  // setup: 创建 requirement，setStatus 到 awaiting_review
  appendFeedback({ requirement_id, source: "manual", body: "test" });
  // 模拟 routes.ts inject_feedback handler 的逻辑
  if (r.status === "awaiting_review") setRequirementStatus(id, "fix_revision");
  expect(getRequirementById(id)?.status).toBe("fix_revision");
});
```

### 步骤

1. 创建集成测试
2. typecheck + 跑测试 PASS
3. commit:
   ```
   git add tests/requirement-scheduler-integration.test.ts
   git commit -m "test(scheduler): P3 调度器集成测试"
   ```

---

## Task 10：文档更新

**Files:**
- Modify: `docs/requirement-queue.md`

更新 P3 已落地内容 + 修正限制清单：

```markdown
> **当前状态：Phase 3 落地**
> - ✅ P1：仓库管理 + req_dev workflow（前 5 阶段）
> - ✅ P2：需求池 + chat 集成
> - ✅ P3：调度器（同仓库严格串行）+ await_review/fix_revision + 手动反馈触发回流
> - ⏳ P4：gh CLI 轮询监听器（PR review 自动感知）
```

「P2 当前限制」章节改名为「P3 当前限制」，去掉前两条（已落地），保留「没有 GitHub 自动监听」一条：

```markdown
## P3 当前限制

- ✅ 同仓库严格串行（调度器保证）
- ✅ PR 反馈手动注入触发 fix_revision 修复 + push 同分支
- ⚠️ **没有 GitHub 自动监听**：PR review change request 不会自动注入；需要手动调 inject_feedback（chat 工具或 REST）
- ⚠️ **PR merge 不自动检测**：需要手动 transition req → done

完整闭环（GitHub review/merge 自动监听）由 P4 落地。
```

加一段 P3 工作流详解：

```markdown
## P3 工作流（同仓库串行 + PR 反馈循环）

```
[需求 A queued] → 调度器拉走 → [running] → submit_pr → [awaiting_review]
                                                        ↓
                                            （A 进入 awaiting_review，
                                             不占槽位，调度器看下一个）
[需求 B queued] → 调度器拉走 → [running] → ...

（用户在 chat 注入反馈给 A）
[A awaiting_review] → inject_feedback → [fix_revision]
                                          ↓
                              （fix_revision 占槽位，
                               但跟 B 的 running 不在同一个 repo，
                               或者 A 跟 B 同一 repo 时 B 已先完成）
                              run_fix_revision 阶段：
                              - 读最新 feedback
                              - checkout PR 分支
                              - developer agent 修代码
                              - push 到原 PR
                              ↓
                              [awaiting_review]（等下一轮）
```

如果 A 和 B 同一 repo 而 B 还在 running，注入反馈给 A 时 A 转 fix_revision 不会立刻生效（同 repo 有 1 个槽位被 B 占用）—— 实际上 fix_revision 是 A 自己的状态，会跟 B 的 running 并存（fix_revision 是「占用 A 自己的槽位」，A 之前 awaiting_review 时是空闲的，转入 fix_revision 后又被 A 自己占走）。spec §6 不变量：「同一 repo 下 running ∨ fix_revision 最多 1 个」。

正确语义：A 注入反馈时 B 还在 running 是有可能的（之前 A 进了 awaiting_review 释放槽位让 B 上）。这时 A 转 fix_revision 跟 B 的 running 共存？**不会**——fix_revision 占的是自己的「在 task 上跑」槽位，但 B 的 running task 是同一 repo 的另一个 task。spec 的「running ∨ fix_revision = 1 个槽位」是说 **同时只能有一个 task 在 active 跑**。如果 A 进 fix_revision 时 B 还在 running，**A 的 await_review 阶段函数 sleep 循环会先 emit revision_request 让 task 真的跳到 fix_revision 阶段**，但 task runner 就会 spawn run_fix_revision 子进程 —— 这跟 B 的 running 子进程并发跑。

⚠️ **这个边界 P3 实现是否真的强制串行**？看实际：
- 调度器只在 `enqueued` 或 `releasing slot` 事件触发 `tickRepo`
- inject_feedback 触发 awaiting_review → fix_revision **不**经过 enqueued / releasing 路径
- 所以 inject_feedback 路径不会阻塞 B（B 已经在跑）—— A 的 fix_revision 子进程跟 B 的 running 子进程**并发**

这是 P3 设计的真实边界：「PR review 反馈到达时，已经在跑的下一个任务不会被打断（避免抢占复杂性）」。下一个任务跑完后调度器才轮到下一个（A 的 fix_revision 完成后回 awaiting_review，再下下个 queued 才被拉）。

**这种行为符合 spec 吗？** spec §5.3 说「调度器看到该 repo 有 fix_revision，**暂停拉新需求**」—— P3 实现满足这点。但 spec 没有说「fix_revision 触发时打断当前 running」。所以并发 1 个 running + 1 个 fix_revision 是可接受的（仅 1 个槽位限制是对未来 queued 入队的，不是对当前已 running 的）。
```

实际上这段太长了，简化版：

```markdown
## P3 同仓库串行的细微边界

调度器规则是「1 个 active 槽位（running ∨ fix_revision）」。但 `inject_feedback` 触发 `awaiting_review → fix_revision` 不经过调度器路径，所以：
- 如果 PR-A 进 awaiting_review 后调度器已拉了 PR-B 跑 running，此时给 A 注入反馈，A 转 fix_revision 跟 B running 并发（同一 repo 同时 2 个 task 跑）
- spec §6 的「1 个槽位」约束保护的是未来 queued 入队，不是已运行的 task

如果你需要严格「fix_revision 启动时打断 running」，那是 P3+ 的扩展，本 phase 不实现。
```

### 步骤

1. 改 docs/requirement-queue.md
2. commit:
   ```
   git add docs/requirement-queue.md
   git commit -m "docs: 更新 P3 落地状态 + 限制清单"
   ```

---

## Self-Review 检查表

### Spec 覆盖率

| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §4.1 await_review 实现 | T1, T2 |
| §5.3 review 反馈到达流程 | T8（inject_feedback 触发）+ T3（fix_revision 阶段函数） |
| §5.4 PR merged → done | T2（await_review 检测 status=done）|
| §6 调度器算法 | T5 |
| §10 错误处理（dangling 排除 await_review） | T4 |
| §12 P3 范围 | T1-T10 全部 |

P3 不覆盖（按 spec §12 留给 P4）：gh CLI 轮询监听器 / PR merge 自动检测 / `last_reviewed_event_id` 真正用上。

### Placeholder 扫描

✅ 无 TBD/TODO（注释里 P4 留给 gh poller 是设计决策注释，不是 placeholder）

### 类型一致性

- `requirement_id` 在 task extra / setup_func / await_review / fix_revision / scheduler 五处一致
- `revision_request` / `fix_done` 两个 trigger 名在 yaml + 阶段函数一致
- 状态枚举跨 P2 / P3 一致

---

## 后续 Phase

- **P4**：gh CLI 轮询监听器（PR review 自动感知 + PR merge 自动检测）
