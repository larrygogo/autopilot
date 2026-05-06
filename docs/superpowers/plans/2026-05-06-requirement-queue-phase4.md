# 需求队列 Phase 4 实施计划：gh CLI 轮询监听器

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P4（4 phase 闭环最后一步）—— 加一个 gh CLI 轮询模块定期扫所有 `awaiting_review` 需求的 PR，发现 CHANGES_REQUESTED review 自动注入反馈触发 fix_revision；发现 PR merged 自动 transition req → done。从此**完整闭环跑通**：用户在 chat 提需求 → 自动澄清入队 → 自动跑 design/develop/review/PR → 自动监听 PR review/merge → 自动修复或终结。

**Architecture:** `src/daemon/pr-poller.ts` 用 `Bun.spawn(["gh", "pr", "view", ..., "--json", "reviews,state,mergeCommit", "-R", "<owner>/<repo>"])` 拉每个 awaiting_review 需求的 PR 状态；对比 `last_reviewed_event_id` 去重；发现新 CHANGES_REQUESTED review → 调内部 `injectFeedback()`（统一入口，跟 P3 手动注入路径相同 → 触发 fix_revision）；发现 merged → `setRequirementStatus(req, "done")`。挂在现有 daemon scheduler 周期（默认 5 min）。

**Tech Stack:** Bun + TypeScript（daemon），gh CLI（用户已 `gh auth login`），bun:test。

**Spec reference:** `docs/superpowers/specs/2026-05-06-requirement-queue-design.md` §7 / §10 / §12 P4

---

## File Structure

新建：

| 文件 | 职责 |
|------|------|
| `src/daemon/pr-poller.ts` | gh CLI 轮询：扫 awaiting_review PR、diff reviews、注入反馈 / 标 done |
| `tests/pr-poller.test.ts` | mock gh 输出，验证 reviews diff / state 检测 / inject 调用 |

修改：

| 文件 | 改动 |
|------|------|
| `src/core/config.ts` | 加 `loadGithubConfig()` 读 `config.yaml.github.cli` + `poll_interval_seconds` |
| `src/daemon/index.ts` | 启动时加第四个 setInterval 触发 pr-poller |
| `docs/requirement-queue.md` | 标 P4 落地，更新限制清单（P4 后只剩 0 项「未完成」） |
| `docs/req-dev-workflow.md` | 加一段「PR review/merge 自动监听」说明 |

---

## Tasks 一览

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 1 | config.ts 加 github 段读取 | `loadGithubConfig()` 返回 `{ cli, poll_interval_seconds }` | 15 min |
| 2 | pr-poller 模块（核心） | `pollAllPRs()` + `diffReviews()` 工具函数 | 90 min |
| 3 | 集成到 daemon scheduler | setInterval 周期触发 + shutdown clearInterval | 15 min |
| 4 | 单测 | mock gh 输出，验证 diff 算法 + merge 检测 | 60 min |
| 5 | 文档更新（4 phase 全闭环） | requirement-queue.md / req-dev-workflow.md | 25 min |

**总估时**：约 3.5 小时

---

## 共性约束

- TDD：先写测试 → 跑 FAIL → 实现 → 跑 PASS → typecheck → commit
- 每 task 一个 commit；message 中文
- `gh` 调用统一 `Bun.spawn` argv 数组形式（无 shell 注入）
- catch 用 `catch (e: unknown)`
- 失败 / rate limit 不阻塞 daemon —— log warn 后下个周期重试
- gh 未登录 / 不可执行：log warn 一次后跳过（不刷屏）

---

## Task 1：config.ts 加 github 段读取

**Files:**
- Modify: `src/core/config.ts`
- Modify: `tests/config.test.ts`（如已有；若无创建）

### 接口

```ts
export interface GithubConfig {
  cli: string;                  // gh 可执行路径，默认 "gh"
  poll_interval_seconds: number; // 默认 300（5 min）
}

export function loadGithubConfig(): GithubConfig;
```

读 `config.yaml` 的 `github` 段（非必需）：

```yaml
github:
  cli: gh                      # 默认 'gh'，自定义路径时改
  poll_interval_seconds: 300   # 默认 5 min
```

字段缺失走默认值；类型不对走默认值 + log warn 一次。

### 实现要点

参考 `src/core/config.ts` 现有 `loadDaemonConfig()` 等函数风格（前面 grep 过有 `loadConfig() / loadDaemonConfig`）：

```ts
export function loadGithubConfig(): GithubConfig {
  const raw = loadConfig();
  const section = (raw["github"] as Record<string, unknown> | undefined) ?? {};
  const cli = typeof section["cli"] === "string" && section["cli"].trim()
    ? (section["cli"] as string).trim()
    : "gh";
  const poll = typeof section["poll_interval_seconds"] === "number"
    && Number.isFinite(section["poll_interval_seconds"])
    && (section["poll_interval_seconds"] as number) >= 30
    ? (section["poll_interval_seconds"] as number)
    : 300;
  return { cli, poll_interval_seconds: poll };
}
```

最小间隔 30s 保护（gh API rate limit）。

### 测试

```ts
it("缺失 github 段返回默认值", () => {
  // mock loadConfig 返回 {}
  // assert loadGithubConfig() = { cli: "gh", poll_interval_seconds: 300 }
});
it("自定义 cli 路径", () => {
  // loadConfig 返回 { github: { cli: "/usr/local/bin/gh" } }
  // assert cli = "/usr/local/bin/gh"
});
it("poll_interval < 30 走默认", () => {
  // loadConfig 返回 { github: { poll_interval_seconds: 5 } }
  // assert poll_interval_seconds = 300
});
```

mock loadConfig 看现有测试模式（可能用 `process.env.AUTOPILOT_CONFIG` 或者 _setConfigForTest 等）。

### commit

```
git add src/core/config.ts tests/config.test.ts  # 视测试文件存在情况
git commit -m "feat(config): 加 github 段读取（cli / poll_interval_seconds）"
```

---

## Task 2：pr-poller 模块（核心）

**Files:**
- Create: `src/daemon/pr-poller.ts`

### 设计

```ts
// src/daemon/pr-poller.ts
import { listRequirements, getRequirementById, setRequirementStatus, updateRequirement } from "../core/requirements";
import { appendFeedback } from "../core/requirement-feedbacks";
import { getRepoById } from "../core/repos";
import { loadGithubConfig } from "../core/config";
import { createLogger } from "../core/logger";  // 按真实 logger 接口

const log = createLogger("pr-poller");

interface GhReview {
  id: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  author?: { login?: string };
  submittedAt?: string;
}

interface GhPrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  reviews: GhReview[];
  mergeCommit?: { oid: string } | null;
}

/**
 * 周期入口：扫所有 awaiting_review 需求的 PR，处理 review / merge 状态。
 * 由 daemon scheduler setInterval 触发。
 */
export async function pollAllPRs(): Promise<void> {
  const cfg = loadGithubConfig();
  const reqs = listRequirements({ status: "awaiting_review" });
  if (reqs.length === 0) return;

  for (const req of reqs) {
    try {
      await pollOne(req.id, cfg.cli);
    } catch (e: unknown) {
      log.warn("pollOne %s 失败：%s", req.id, (e as Error).message);
    }
  }
}

/**
 * 单需求轮询：拉 PR → 处理 merge / new reviews。
 */
async function pollOne(reqId: string, cli: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "awaiting_review") return;
  if (!req.pr_number) return;
  const repo = getRepoById(req.repo_id);
  if (!repo || !repo.github_owner || !repo.github_repo) {
    log.warn("requirement %s 关联 repo 缺 github_owner/repo，跳过", reqId);
    return;
  }

  const data = await ghPrView(cli, repo.github_owner, repo.github_repo, req.pr_number);
  if (!data) return;  // gh 调用失败，下周期重试

  // 1. 检查 merged
  if (data.state === "MERGED" || data.mergeCommit) {
    log.info("requirement %s PR %d merged，转 done", reqId, req.pr_number);
    try {
      setRequirementStatus(reqId, "done");
    } catch (e: unknown) {
      log.warn("requirement %s 转 done 失败：%s", reqId, (e as Error).message);
    }
    return;
  }

  // 2. 检查新 CHANGES_REQUESTED review
  const changes = data.reviews
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .filter((r) => !req.last_reviewed_event_id || r.id > req.last_reviewed_event_id);

  if (changes.length === 0) return;

  // 取最新一条作为反馈正文（合并多条可读性差，且通常 GitHub 上一次 review 一条）
  const latest = changes[changes.length - 1];
  const body = changes
    .map((r) => `## ${r.author?.login ?? "unknown"}\n\n${r.body || "(无评论正文)"}`)
    .join("\n\n---\n\n");

  log.info("requirement %s 收到 %d 条 CHANGES_REQUESTED review，注入反馈", reqId, changes.length);

  appendFeedback({
    requirement_id: reqId,
    source: "github_review",
    body,
    github_review_id: latest.id,
  });

  // 更新 last_reviewed_event_id 去重
  updateRequirement(reqId, { last_reviewed_event_id: latest.id });

  // 触发 fix_revision（跟 P3 手动注入路径一致：awaiting_review → fix_revision）
  try {
    setRequirementStatus(reqId, "fix_revision");
  } catch (e: unknown) {
    log.warn("requirement %s 转 fix_revision 失败：%s", reqId, (e as Error).message);
  }
}

/**
 * 调 gh CLI 拉 PR view。统一走 Bun.spawn argv，无 shell 注入。
 */
async function ghPrView(
  cli: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GhPrView | null> {
  const proc = Bun.spawn(
    [cli, "pr", "view", String(prNumber), "--json", "reviews,state,mergeCommit", "-R", `${owner}/${repo}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    log.warn("gh pr view %s/%s#%d 失败 (exit %d): %s", owner, repo, prNumber, exitCode, err.slice(0, 200));
    return null;
  }

  const stdout = await new Response(proc.stdout).text();
  try {
    return JSON.parse(stdout) as GhPrView;
  } catch (e: unknown) {
    log.warn("gh pr view 输出 JSON 解析失败：%s", (e as Error).message);
    return null;
  }
}

// 暴露内部函数给测试用
export const _internal = { pollOne, ghPrView };
```

⚠️ **关键安全约束**：所有 `cli / owner / repo` 字符串都来自数据库（不是 user input），但仍走 argv 数组形式不拼接 shell。

⚠️ **idempotency**：`last_reviewed_event_id` 字段用于去重（P2 schema 已建好）。GitHub review id 是字符串单调递增 lex 序，可以直接 `>` 比较；如果不是单调，也至少是 ≠ 比较。本实现用 `>` 假设递增 + GitHub PR review id 形如 `PRR_kwDO...` 是单调（实际验证）—— 如果实际不单调，改成 `!== last_reviewed_event_id`。

实现里第二种保险：用 `Set<string>` 记 last + 「不在 set 里的就是新」。但单需求 last 1 个就够。

### commit

```
git add src/daemon/pr-poller.ts
git commit -m "feat(daemon): 加 pr-poller 模块（gh CLI 轮询 PR review/merge）"
```

---

## Task 3：集成到 daemon scheduler

**Files:**
- Modify: `src/daemon/index.ts`

### 改动

读 `src/daemon/index.ts` 找到现有 watcher / retention / scheduler 的 setInterval 块（约第 97-119 行）。在 schedulerTimer 后追加：

```ts
import { pollAllPRs } from "./pr-poller";
import { loadGithubConfig } from "../core/config";

// 顶部常量区
const PR_POLL_INTERVAL_DEFAULT_MS = 300_000;  // 5 min 默认；从 config 读取实际值

// 在 schedulerTimer 之后：
const ghCfg = loadGithubConfig();
const prPollerInterval = ghCfg.poll_interval_seconds * 1000;
const prPollerTimer = setInterval(() => {
  pollAllPRs().catch((e: unknown) => {
    console.error("pr-poller 异常：", e instanceof Error ? e.message : String(e));
  });
}, prPollerInterval);

log.info("pr-poller 已启动，轮询间隔 %ds", ghCfg.poll_interval_seconds);
```

shutdown handler 加 `clearInterval(prPollerTimer)`。

### commit

```
git add src/daemon/index.ts
git commit -m "feat(daemon): 集成 pr-poller 到周期 scheduler"
```

---

## Task 4：单测（mock gh）

**Files:**
- Create: `tests/pr-poller.test.ts`

### 测试场景

测 `pollOne` 直接（暴露 `_internal.pollOne`）：

```ts
describe("pr-poller pollOne", () => {
  // setup in-memory DB + 创建 repo（含 github_owner/repo）+ 1 个 awaiting_review requirement
  // mock ghPrView 返回不同的数据，验证逻辑分支

  it("PR merged → setStatus(done) + 不注入反馈", async () => {
    // mock ghPrView 返回 { state: "MERGED", reviews: [], mergeCommit: { oid } }
    // 调 pollOne
    // 断言 requirement.status = "done"
    // 断言 requirement_feedbacks 没新增
  });

  it("无新 CHANGES_REQUESTED → 状态不变 + 不注入", async () => {
    // mock ghPrView 返回 { state: "OPEN", reviews: [{state: "APPROVED"}, {state: "COMMENTED"}] }
    // 调 pollOne
    // 断言 status 仍 awaiting_review
    // 断言 feedbacks 空
  });

  it("新 CHANGES_REQUESTED → 注入反馈 + setStatus(fix_revision) + 写 last_reviewed_event_id", async () => {
    // mock ghPrView 返回 { state: "OPEN", reviews: [{id: "PRR_1", state: "CHANGES_REQUESTED", body: "改这"}] }
    // 调 pollOne
    // 断言 status = "fix_revision"
    // 断言 feedback 1 条 source=github_review, github_review_id="PRR_1"
    // 断言 requirement.last_reviewed_event_id = "PRR_1"
  });

  it("已处理过的 review id 不重复注入（去重）", async () => {
    // 先设 requirement.last_reviewed_event_id = "PRR_1"
    // mock ghPrView 返回 { reviews: [{id: "PRR_1", ...}] }
    // 调 pollOne
    // 断言 feedbacks 空（因为 PRR_1 不大于 PRR_1）
    // 断言 status 仍 awaiting_review
  });

  it("PR 缺 github_owner/repo → 跳过 + log warn", async () => {
    // 创建一个 repo 不填 github_owner/repo
    // 创建 awaiting_review requirement 关联此 repo
    // 调 pollOne，应 return early，无副作用
    // 断言 status 仍 awaiting_review
  });
});
```

### mock 策略

`ghPrView` 在 `_internal` 暴露 —— 可以用 mock function 替换。或者更简单：把 ghPrView 改成可注入：

```ts
// 修改 pollAllPRs 接受可选 spawnFn 参数（注入 mock）
// 默认走真实 Bun.spawn；测试传 mock 函数
```

或者直接 stub `Bun.spawn`（不太优雅）。

最简单：**重构 pr-poller 让 ghPrView 通过依赖注入可替换**，例如：

```ts
type GhRunner = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultGhRunner: GhRunner = async (args) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

let _ghRunner: GhRunner = defaultGhRunner;

/** 测试用：注入 mock 实现 */
export function _setGhRunnerForTest(runner: GhRunner | null): void {
  _ghRunner = runner ?? defaultGhRunner;
}
```

`ghPrView` 改用 `_ghRunner(...)`。测试 setup 里 `_setGhRunnerForTest(mock)`，afterEach restore。

### commit

```
git add src/daemon/pr-poller.ts tests/pr-poller.test.ts
git commit -m "test(pr-poller): mock gh 输出验证 diff / merge / 去重逻辑"
```

注意：如果重构了 pr-poller 加注入接口，commit message 可改为：
```
feat(pr-poller): 引入 _setGhRunnerForTest 注入接口 + 单测
```

---

## Task 5：文档更新

**Files:**
- Modify: `docs/requirement-queue.md`
- Modify: `docs/req-dev-workflow.md`

### `docs/requirement-queue.md`

更新顶部状态：

```markdown
> **当前状态：4 phase 全闭环落地 🎉**
> - ✅ P1：仓库管理 + req_dev workflow（前 5 阶段）
> - ✅ P2：需求池 + chat 集成
> - ✅ P3：调度器（同仓库严格串行）+ await_review/fix_revision + 手动反馈触发回流
> - ✅ P4：gh CLI 轮询监听器（PR review change request 自动注入 + PR merge 自动检测）
```

「P3 当前限制」章节改名「当前限制」，全部限制都已落地，留一段简要说明：

```markdown
## 当前限制 / 已知边界

- ✅ 同仓库严格串行（调度器保证）
- ✅ PR review change request 自动注入反馈触发 fix_revision
- ✅ PR merge 自动 transition req → done
- ⚠️ **gh CLI 必须本地已 `gh auth login`**：未登录时 pr-poller log warn 跳过，不影响其他模块
- ⚠️ **轮询间隔默认 5 min**：可在 `config.yaml.github.poll_interval_seconds` 调；最小 30s 保护 GitHub API rate limit
- ⚠️ **GitHub Issues / Jira 等外部需求源**：非本工作模式范围，留给后续扩展（详见 spec §15）
```

### `docs/req-dev-workflow.md`

加一段「PR review/merge 自动监听」（紧跟阶段流程之后）：

```markdown
## P4：PR review/merge 自动监听

P4 落地后，daemon 会定期（默认 5 min，可配 `config.yaml.github.poll_interval_seconds`）扫所有 `awaiting_review` 需求的 PR：

- 发现 `CHANGES_REQUESTED` review → 自动 `inject_feedback`（source=github_review）→ 触发 `fix_revision` 阶段
- 发现 PR merged → 自动 `transition req → done`，task 终结

需要本地已 `gh auth login`（autopilot 不管理 token）。

配置示例（`config.yaml`）：

```yaml
github:
  cli: gh                      # 默认 'gh'
  poll_interval_seconds: 300   # 默认 5 min；最小 30s
```
```

### commit

```
git add docs/requirement-queue.md docs/req-dev-workflow.md
git commit -m "docs: 4 phase 全闭环落地 + PR review/merge 自动监听说明"
```

---

## Self-Review 检查表

### Spec 覆盖率

| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §7 PR 轮询监听器 | T2, T3 |
| §10 错误处理（gh 未登录跳过） | T2 |
| §12 P4 范围 | T1-T5 全部 |
| §3.2 last_reviewed_event_id 字段 | T2（实际使用） |

### Placeholder 扫描

✅ 无 TBD / TODO

### 类型一致性

- `GhPrView / GhReview` 接口跟 gh 实际输出 schema 对齐
- `last_reviewed_event_id: string | null` 跨 P2 schema / P4 写入一致
- `source: "github_review"` 跟 P3 / P4 一致

---

## 4 Phase 闭环验收（手工 e2e）

```bash
git checkout feat/requirement-queue-phase4-20260506
bun install && bun run build:web
autopilot daemon restart

# 1. 准备测试仓库（任意你的 GitHub repo）+ /repos 注册 + 健康检查 ✓
# 2. /chat 提需求 → agent 走 list_repos / create_requirement_draft / update_spec / mark_ready / enqueue
# 3. /tasks 看 req_dev task 跑到 submit_pr 阶段 → GitHub 上 PR 创建成功
# 4. task 进 await_review 阶段（卡在那）；/requirements 看到 status=awaiting_review
# 5. 在 GitHub PR 上 submit 一个 "Request changes" review（评论正文「请改 X」）
# 6. 等 ≤5 min（pr-poller 周期），看：
#    - /requirements/:id 反馈历史多了一条 source=github_review
#    - status → fix_revision
#    - task 跑 run_fix_revision 阶段：读 feedback 改代码 push 同 PR
# 7. 在 GitHub merge PR
# 8. 等 ≤5 min，看 requirement.status → done，task 也终结
```

跑通即代表完整闭环验收。
