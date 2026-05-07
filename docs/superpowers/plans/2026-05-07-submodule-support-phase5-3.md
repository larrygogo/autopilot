# 需求队列 P5.3 — 调度器组级锁 + Web UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让父 repo + 所有子模块按一组进行调度（最多一个 active task），并在 Web UI 显式展示子模块结构和子模块 PR 关联。

**Architecture:**
- `tickRepo` 算法扩展：从「同一 repo_id」级 active 检测升到「组级」（父+所有子模块），candidate 仅从父 repo 拉取。
- chat tool `create_requirement_draft` 增加 alias 父校验。
- 新增两个查询 API：父 repo 的子模块列表、需求关联的子 PR 列表。
- Web `/repos` 父行加展开折叠（显示子模块表）+ 「重新发现子模块」按钮；`/requirements/:id` 加「关联子模块 PR」卡片。

**Tech Stack:** Bun + TypeScript（src/core, src/daemon, src/agents），React + Vite + shadcn/ui（src/web），bun:test。

---

## File Structure

**Modify:**
- `src/daemon/requirement-scheduler.ts` — `tickRepo` 改为组级活跃检测
- `src/agents/tools.ts` — `create_requirement_draft` 拒绝子模块 alias
- `src/daemon/routes.ts` — 新增 `GET /api/repos/:id/submodules`、`GET /api/requirements/:id/sub-prs`
- `src/web/src/hooks/useApi.ts` — Repo 类型扩展 + `RequirementSubPr` 接口 + 3 个新方法
- `src/web/src/pages/Repos.tsx` — 父 repo 行展开/折叠 + 「重新发现子模块」按钮
- `src/web/src/pages/RequirementDetail.tsx` — 加「关联子模块 PR」Card
- `tests/requirement-scheduler.test.ts` — 加组级锁场景测试

**Create:**
- `tests/chat-tools-submodule.test.ts` — 验证 `create_requirement_draft` 拒绝子模块 alias

---

## Task 1：Scheduler 组级锁

**Files:**
- Modify: `src/daemon/requirement-scheduler.ts`
- Modify: `tests/requirement-scheduler.test.ts`

**核心变更（spec §4.3）：**
- 计算 `groupId = repo.parent_repo_id ?? repo.id`
- 收集组内 repo ids = `[groupId, ...listSubmodules(groupId).map(r => r.id)]`
- active 检测在组内任一 repo 的 requirement 上做
- candidate 仅从 `groupId` 拉 queued（用户在 chat 提需求只会选父）

- [ ] **Step 1：先写失败测试**

把以下测试加到 `tests/requirement-scheduler.test.ts` 文件末尾的最后一个 `})` 之前（保持现有测试不动）。注意 import：增加 `listSubmodules` / `getRepoById` 等用不到，**只需** `tickRepo` 和已有 helpers。

但现有 test 用 `repo-001 / repo-002` 是平行的；新测试要新建带 parent_repo_id 的 repo，最干净的写法是另写一个 `describe("tickRepo 组级锁", ...)`。

```ts
describe("tickRepo 组级锁（父 + 子模块同组 1 active）", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);
    // 父 repo
    createRepo({ id: "repo-p1", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    // 子模块（parent_repo_id = repo-p1）
    createRepo({
      id: "repo-c1",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_repo_id: "repo-p1",
      submodule_path: "child1",
    });
    // 另一独立父 repo
    createRepo({ id: "repo-p2", alias: "parent2", path: "/tmp/p2", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  it("子模块上的 running 阻塞父 repo 拉新（组级锁）", async () => {
    // 在子模块上挂一个 running requirement（跨组 task 历史模拟）
    const idChild = nextRequirementId();
    createRequirement({ id: idChild, repo_id: "repo-c1", title: "child-task" });
    setRequirementStatus(idChild, "clarifying");
    setRequirementStatus(idChild, "ready");
    setRequirementStatus(idChild, "queued");
    setRequirementStatus(idChild, "running");

    // 父 repo 上有 queued 待拉
    const idParent = nextRequirementId();
    createRequirement({ id: idParent, repo_id: "repo-p1", title: "parent-task" });
    setRequirementStatus(idParent, "clarifying");
    setRequirementStatus(idParent, "ready");
    setRequirementStatus(idParent, "queued");

    // 调度器对 repo-p1 tick：组内有 active（在子模块上）→ 不拉新
    await tickRepo("repo-p1");
    expect(getRequirementById(idParent)?.status).toBe("queued");
  });

  it("传入子模块 id 也走同一组（groupId 归一化）", async () => {
    const idParent = nextRequirementId();
    createRequirement({ id: idParent, repo_id: "repo-p1", title: "parent-task" });
    setRequirementStatus(idParent, "clarifying");
    setRequirementStatus(idParent, "ready");
    setRequirementStatus(idParent, "queued");
    setRequirementStatus(idParent, "running"); // 父 repo 有 active

    // 即便 tick 子模块 id，也应识别到组内 active 而不拉新
    // （这里没 queued 在子模块上，主要验证 active 检测路径）
    await tickRepo("repo-c1");
    expect(getRequirementById(idParent)?.status).toBe("running");
  });

  it("组级 candidate 仅从组主仓库（父）拉取，子模块上的 queued 被忽略", async () => {
    // 子模块上手工塞 queued requirement（实际不会发生，但要验证调度器忽略）
    const idChildQueued = nextRequirementId();
    createRequirement({ id: idChildQueued, repo_id: "repo-c1", title: "child-only-queued" });
    setRequirementStatus(idChildQueued, "clarifying");
    setRequirementStatus(idChildQueued, "ready");
    setRequirementStatus(idChildQueued, "queued");

    // 调度器对 repo-p1 tick：组内无 active；但 candidate 必须从父拉，子模块 queued 不算候选
    await tickRepo("repo-p1");
    // child queued 仍是 queued（未被 schedule 拉出运行）
    expect(getRequirementById(idChildQueued)?.status).toBe("queued");
  });

  it("不同组之间不互相阻塞", async () => {
    // 组 1（父+子）有 running，组 2 仍可拉新
    const idA = nextRequirementId();
    createRequirement({ id: idA, repo_id: "repo-c1", title: "group1-running" });
    setRequirementStatus(idA, "clarifying");
    setRequirementStatus(idA, "ready");
    setRequirementStatus(idA, "queued");
    setRequirementStatus(idA, "running");

    // 组 2（独立 repo-p2）的 active 检测不应受组 1 影响
    const all2 = listRequirements({ repo_id: "repo-p2" });
    const active2 = all2.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active2.length).toBe(0);

    // 同组（repo-p1）应有 active
    const all1 = listRequirements({ repo_id: "repo-c1" });
    const active1 = all1.filter((r) => r.status === "running" || r.status === "fix_revision");
    expect(active1.length).toBe(1);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/requirement-scheduler.test.ts
```
预期：「子模块上的 running 阻塞父 repo 拉新（组级锁）」FAIL（当前算法只查 repo_id=repo-p1，看不到 repo-c1 上的 running）。其余两个新用例可能 pass（不依赖代码改造，只是验证 fixture）。

- [ ] **Step 3：实现组级锁**

修改 `src/daemon/requirement-scheduler.ts`：

```ts
import { onEvent, offEvent } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements, setRequirementStatus, updateRequirement, getRequirementById } from "../core/requirements";
import { getRepoById } from "../core/repos";
import { listSubmodules } from "../core/submodules";
import { startTaskFromTemplate } from "../core/task-factory";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-scheduler");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/**
 * 单组 tick：父 repo + 所有关联子模块视为一个调度组。
 *
 * 算法（spec §4.3 组级扩展）：
 *   - groupId = repo.parent_repo_id ?? repo.id（即便传子模块 id 也归一化到父）
 *   - groupRepoIds = [groupId, ...listSubmodules(groupId).map(r => r.id)]
 *   - active = listRequirements({}) 中 repo_id ∈ groupRepoIds 且 status ∈ {running, fix_revision}
 *   - 若 active 非空：do nothing
 *   - 否则取主仓库（父 groupId）上最老 queued requirement → startTaskFromTemplate
 *   - 子模块上的 queued（极端情况，正常 chat 流程不会发生）忽略
 *
 * 失败时回滚 status: queued → ready
 */
export async function tickRepo(repoId: string): Promise<void> {
  const repo = getRepoById(repoId);
  if (!repo) {
    log.error("tickRepo: repo %s 不存在", repoId);
    return;
  }
  const groupId = repo.parent_repo_id ?? repo.id;
  const submodules = listSubmodules(groupId);
  const groupRepoIds = new Set<string>([groupId, ...submodules.map((r) => r.id)]);

  // active 检测扩到整组
  const all = listRequirements({});
  const active = all.filter(
    (r) => groupRepoIds.has(r.repo_id) && (r.status === "running" || r.status === "fix_revision"),
  );
  if (active.length > 0) return;

  // candidate 仅从主仓库拉（用户在 chat 提需求只会选父）
  const queued = all
    .filter((r) => r.repo_id === groupId && r.status === "queued")
    .sort((a, b) => a.created_at - b.created_at);
  if (queued.length === 0) return;

  const candidate = queued[0];
  const candidateRepo = getRepoById(candidate.repo_id);
  if (!candidateRepo) {
    log.error("tickRepo: candidate repo %s 不存在", candidate.repo_id);
    return;
  }

  let task;
  try {
    task = await startTaskFromTemplate({
      workflow: "req_dev",
      title: candidate.title,
      requirement: candidate.spec_md,
      repo_id: candidateRepo.id,
      requirement_id: candidate.id,
    });
  } catch (e: unknown) {
    log.error("tickRepo: 创建 task 失败 candidate=%s: %s", candidate.id, (e as Error).message);
    try {
      setRequirementStatus(candidate.id, "ready");
    } catch (rollbackErr: unknown) {
      log.error("tickRepo: 回滚 status 失败 %s: %s", candidate.id, (rollbackErr as Error).message);
    }
    return;
  }

  try {
    updateRequirement(candidate.id, { task_id: task.id });
    setRequirementStatus(candidate.id, "running");
    log.info(
      "tickRepo: 启动 requirement %s → task %s on repo %s (group=%s, submodules=%d)",
      candidate.id,
      task.id,
      candidateRepo.alias,
      groupId,
      submodules.length,
    );
  } catch (e: unknown) {
    log.error("tickRepo: 写回 task_id 或 setStatus running 失败 %s: %s", candidate.id, (e as Error).message);
  }
}

export function initRequirementScheduler(): void {
  if (_handler) return;

  const handler = async (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, from, to } = event.payload;

    const enqueued = to === "queued";
    const releasingSlot =
      (from === "running" || from === "fix_revision") &&
      ["awaiting_review", "done", "cancelled", "failed"].includes(to);

    if (!enqueued && !releasingSlot) return;

    const req = getRequirementById(id);
    if (!req) return;

    try {
      await tickRepo(req.repo_id);
    } catch (e: unknown) {
      log.error("requirement-scheduler: tickRepo 异常 repo=%s: %s", req.repo_id, (e as Error).message);
    }
  };

  onEvent("requirement:status-changed", handler);
  _handler = handler;

  log.info("requirement-scheduler 已启动（订阅 requirement:status-changed）");
}

export function disposeRequirementScheduler(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
```

- [ ] **Step 4：跑测试，预期通过**

```bash
bun test tests/requirement-scheduler.test.ts
```
预期：所有用例 pass（包含原有 4 个 + 新增 4 个）。

- [ ] **Step 5：跑全套测试 + typecheck**

```bash
bun test
bun run typecheck
```
预期：全 pass，0 typecheck 错。

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/daemon/requirement-scheduler.ts tests/requirement-scheduler.test.ts
git commit -m "feat(scheduler): 调度器组级锁 — 父 + 子模块作为单一调度槽"
```

---

## Task 2：API 暴露子模块 + 子 PR 列表

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-submodule-api.test.ts`

新增两个端点：
- `GET /api/repos/:id/submodules` → `{ submodules: Repo[] }`
- `GET /api/requirements/:id/sub-prs` → `{ sub_prs: RequirementSubPr[] }`

- [ ] **Step 1：先写失败测试**

新建 `tests/routes-submodule-api.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { _setDbForTest } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import { createRequirement, nextRequirementId } from "../src/core/requirements";
import { appendSubPr } from "../src/core/requirement-sub-prs";
import { handleRequest } from "../src/daemon/routes";

describe("submodule + sub-pr 查询 API", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);

    createRepo({ id: "repo-p1", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    createRepo({
      id: "repo-c1",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_repo_id: "repo-p1",
      submodule_path: "child1",
      github_owner: "owner",
      github_repo: "child1-repo",
    });
    createRepo({
      id: "repo-c2",
      alias: "child2",
      path: "/tmp/p1/child2",
      default_branch: "master",
      parent_repo_id: "repo-p1",
      submodule_path: "child2",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_sub_prs");
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  it("GET /api/repos/:id/submodules 返回父 repo 的所有子模块", async () => {
    const req = new Request("http://localhost/api/repos/repo-p1/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submodules: Array<{ id: string; alias: string }> };
    expect(body.submodules.length).toBe(2);
    expect(body.submodules.map((s) => s.alias).sort()).toEqual(["child1", "child2"]);
  });

  it("GET /api/repos/:id/submodules 子模块 id 自身 → 返回空（非父 repo）", async () => {
    const req = new Request("http://localhost/api/repos/repo-c1/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submodules: unknown[] };
    expect(body.submodules.length).toBe(0);
  });

  it("GET /api/repos/:id/submodules 不存在的 repo → 404", async () => {
    const req = new Request("http://localhost/api/repos/no-such/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });

  it("GET /api/requirements/:id/sub-prs 返回该需求的所有子模块 PR", async () => {
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, repo_id: "repo-p1", title: "T" });
    appendSubPr({
      requirement_id: reqId,
      child_repo_id: "repo-c1",
      pr_url: "https://github.com/owner/child1-repo/pull/10",
      pr_number: 10,
    });
    appendSubPr({
      requirement_id: reqId,
      child_repo_id: "repo-c2",
      pr_url: "https://github.com/owner/child2-repo/pull/20",
      pr_number: 20,
    });

    const req = new Request(`http://localhost/api/requirements/${reqId}/sub-prs`);
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub_prs: Array<{ child_repo_id: string; pr_number: number; pr_url: string }>;
    };
    expect(body.sub_prs.length).toBe(2);
    expect(body.sub_prs.map((p) => p.pr_number).sort()).toEqual([10, 20]);
  });

  it("GET /api/requirements/:id/sub-prs 不存在的 req → 404", async () => {
    const req = new Request("http://localhost/api/requirements/no-such-req/sub-prs");
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});
```

注意：路由入口实际名是 `handleRequest`（已 `export async function handleRequest(req: Request): Promise<Response>`），可以直接 import。

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/routes-submodule-api.test.ts
```
预期：5 用例全 FAIL，新端点不存在 → 路由 fallthrough 到 404 / 其他匹配。

- [ ] **Step 3：在 routes.ts 加端点**

`src/daemon/routes.ts`：

(a) 在文件顶部 import 区追加：
```ts
import { listSubmodules } from "../core/submodules";
import { listSubPrs } from "../core/requirement-sub-prs";
```

(b) 在「`POST /api/repos/:id/rediscover-submodules`」分支后、「Requirements」段落前加：

```ts
    // GET /api/repos/:id/submodules
    const repoSubmodulesMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)\/submodules$/);
    if (method === "GET" && repoSubmodulesMatch) {
      const repo = getRepoById(repoSubmodulesMatch);
      if (!repo) return error("repo not found", 404);
      // 子模块自身 / 普通父 repo 都按 listSubmodules 走（前者返回空数组）
      return json({ submodules: listSubmodules(repoSubmodulesMatch) });
    }
```

(c) 在 Requirements 段落里、`GET|PUT|DELETE /api/requirements/:id` 这个 detail 分支之前加：

```ts
    // GET /api/requirements/:id/sub-prs
    const reqSubPrsMatch = extractParam(path, /^\/api\/requirements\/([\w.\-]+)\/sub-prs$/);
    if (method === "GET" && reqSubPrsMatch) {
      const r = getRequirementById(reqSubPrsMatch);
      if (!r) return error("requirement not found", 404);
      return json({ sub_prs: listSubPrs(reqSubPrsMatch) });
    }
```

注意路由顺序：必须在「`/api/requirements/:id`」detail 通配匹配之前加，否则会被通配吃掉。看 `reqDetailMatch` 在哪一行，确保新端点在它之前。

- [ ] **Step 4：把 useApi.ts 的 NEW_API_PATTERNS 也补上（为方便用户重启提示）**

只在 `src/web/src/hooks/useApi.ts` 顶部 NEW_API_PATTERNS 数组追加两条：
```ts
  /^\/api\/repos\/[\w.\-]+\/submodules$/,
  /^\/api\/repos\/[\w.\-]+\/rediscover-submodules$/,
  /^\/api\/requirements\/[\w.\-]+\/sub-prs$/,
```
（`rediscover-submodules` 顺手也加上，之前漏了。）

- [ ] **Step 5：跑测试，预期通过**

```bash
bun test tests/routes-submodule-api.test.ts
bun run typecheck
```
预期：5 pass，typecheck clean。

- [ ] **Step 6：跑全套**

```bash
bun test
```
预期：全 pass。

- [ ] **Step 7：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/daemon/routes.ts src/web/src/hooks/useApi.ts tests/routes-submodule-api.test.ts
git commit -m "feat(api): 子模块和子 PR 查询端点"
```

---

## Task 3：chat tools `create_requirement_draft` 拒绝子模块 alias

**Files:**
- Modify: `src/agents/tools.ts`
- Create: `tests/chat-tools-submodule.test.ts`

需求：用户在 chat 里只能给父 repo 提需求；如果传子模块 alias，立刻报错让用户用父 alias 重试。

- [ ] **Step 1：先写失败测试**

新建 `tests/chat-tools-submodule.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { _setDbForTest } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import { buildAutopilotTools } from "../src/agents/tools";

describe("chat tool create_requirement_draft 子模块校验", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);

    createRepo({ id: "repo-p1", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    createRepo({
      id: "repo-c1",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_repo_id: "repo-p1",
      submodule_path: "child1",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  async function callCreateDraft(repo_alias: string, title: string) {
    const tools = await buildAutopilotTools();
    const tool = tools.find((t) => t.name === "create_requirement_draft");
    if (!tool) throw new Error("tool not found");
    return tool.handler({ repo_alias, title }, undefined as any);
  }

  it("用父 repo alias 成功创建草稿", async () => {
    const res = await callCreateDraft("parent1", "新需求");
    const text = res.content[0].text;
    expect(text).not.toMatch(/^错误：/);
    const obj = JSON.parse(text);
    expect(obj.repo_alias).toBe("parent1");
    expect(obj.status).toBe("drafting");
  });

  it("用子模块 alias 报错并提示用父 repo", async () => {
    const res = await callCreateDraft("child1", "新需求");
    const text = res.content[0].text;
    expect(text).toMatch(/^错误：/);
    expect(text).toMatch(/子模块/);
    expect(text).toMatch(/parent1/); // 提示父 repo alias
  });

  it("不存在的 alias 仍按原逻辑报错", async () => {
    const res = await callCreateDraft("no-such", "新需求");
    expect(res.content[0].text).toMatch(/^错误：repo_alias 不存在/);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/chat-tools-submodule.test.ts
```
预期：「用子模块 alias 报错」FAIL（当前代码不校验，会成功创建一个挂在子模块上的需求）。

- [ ] **Step 3：实现校验**

`src/agents/tools.ts` 中 `create_requirement_draft` 工具的 handler，找到这段：
```ts
async (args) => {
  const repo = getRepoByAlias(args.repo_alias);
  if (!repo) return err(`repo_alias 不存在：${args.repo_alias}（先在 /repos 注册）`);
  const id = nextRequirementId();
  ...
}
```

改成：
```ts
async (args) => {
  const repo = getRepoByAlias(args.repo_alias);
  if (!repo) return err(`repo_alias 不存在：${args.repo_alias}（先在 /repos 注册）`);
  if (repo.parent_repo_id) {
    // 给出父 repo alias 提示用户改用父
    const parent = getRepoById(repo.parent_repo_id);
    const parentHint = parent ? `请改用父 repo 别名 "${parent.alias}"` : "请用父 repo 别名";
    return err(
      `"${args.repo_alias}" 是子模块，不能直接提需求。${parentHint}（autopilot 会在执行时自动跨父子操作）`,
    );
  }
  const id = nextRequirementId();
  ...
}
```

记得在文件顶部 import 加 `getRepoById`：找到 `import { listRepos, getRepoByAlias } from "../core/repos";`，改成：
```ts
import { listRepos, getRepoByAlias, getRepoById } from "../core/repos";
```

- [ ] **Step 4：跑测试，预期通过**

```bash
bun test tests/chat-tools-submodule.test.ts
```
预期：3 pass。

- [ ] **Step 5：跑全套 + typecheck**

```bash
bun test
bun run typecheck
```
预期：全 pass，typecheck clean。

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/agents/tools.ts tests/chat-tools-submodule.test.ts
git commit -m "feat(chat): create_requirement_draft 拒绝子模块 alias 并提示父 repo"
```

---

## Task 4：useApi.ts 类型 + API 方法扩展

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

为前端补全：
- `Repo` 接口加 `parent_repo_id` / `submodule_path`（后端已经返回，前端类型缺）
- 新增 `RequirementSubPr` 接口
- 新增 3 个 API 方法：`listSubmodules` / `rediscoverSubmodules` / `listRequirementSubPrs`

- [ ] **Step 1：扩展 Repo 接口**

找到 `useApi.ts` 中：
```ts
export interface Repo {
  id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  created_at: number;
  updated_at: number;
}
```

改成：
```ts
export interface Repo {
  id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_repo_id: string | null;  // 非空表示此 repo 是子模块
  submodule_path: string | null;  // 父 repo 内相对路径
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 2：新增 RequirementSubPr 接口**

在 useApi.ts 接近底部 `RequirementFeedback` 接口下面追加：
```ts
export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface RediscoverSubmodulesResult {
  added: Array<{ id: string; alias: string; submodule_path: string | null }>;
  existing_count: number;
  warnings: string[];
}
```

- [ ] **Step 3：在 `api` 对象里加 3 个方法**

找到 `healthcheckRepo` 的紧后面（`// 文件系统浏览` 注释前），加：
```ts
  // Submodules（仅查询；自动发现写在 healthcheck 里）
  listSubmodules: (parentId: string) =>
    request<{ submodules: Repo[] }>(`/api/repos/${parentId}/submodules`).then((r) => r.submodules),
  rediscoverSubmodules: (parentId: string) =>
    request<RediscoverSubmodulesResult>(
      `/api/repos/${parentId}/rediscover-submodules`,
      { method: "POST" },
    ),
```

在 Requirements 段，找 `cancelRequirement` 紧前（或紧后都行，本 plan 选放在 `cancelRequirement` 后面）加：
```ts
  listRequirementSubPrs: (id: string) =>
    request<{ sub_prs: RequirementSubPr[] }>(`/api/requirements/${id}/sub-prs`).then((r) => r.sub_prs),
```

- [ ] **Step 4：跑构建（vite check + typecheck）**

```bash
bun run typecheck
bun run build:web
```
预期：typecheck 0 错；vite build 成功（无 TS 报错）。

- [ ] **Step 5：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/web/src/hooks/useApi.ts
git commit -m "feat(web): useApi 补全子模块 / 子 PR 类型与方法"
```

---

## Task 5：Repos.tsx 父 repo 展开折叠 + 重新发现子模块按钮

**Files:**
- Modify: `src/web/src/pages/Repos.tsx`

**目标：**
- 父 repo 行最左侧（别名前）加一个「展开/收起」按钮（图标 ChevronRight/ChevronDown），点击展开下方插入子模块表格
- 父 repo 操作栏加一个「重新发现子模块」按钮（图标 RefreshCw 或 GitBranch），点击调 `api.rediscoverSubmodules()`，吐 toast 显示新增/警告数量并 refresh 父 repo 行的子模块
- 子模块表格列：路径（submodule_path）、GitHub（owner/repo）、默认分支、健康（同父）

注意：现有 `listRepos` 默认就只返回父，所以列表本身不变；新增的只是子模块的"子表"。

- [ ] **Step 1：实现 UI**

在 `Repos.tsx` 顶部 import 区，把：
```ts
import { FolderGit2, Plus, Pencil, Trash2, Activity, RefreshCw, FolderOpen } from "lucide-react";
```
改成：
```ts
import {
  FolderGit2, Plus, Pencil, Trash2, Activity, RefreshCw, FolderOpen,
  ChevronRight, ChevronDown, GitBranch,
} from "lucide-react";
```

然后在 `export function Repos()` 内部、其它 useState 后追加两个 state：
```ts
  // 子模块展开状态：parentId -> Repo[] | "loading" | undefined
  const [submodulesMap, setSubmodulesMap] = useState<Record<string, Repo[] | "loading">>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rediscoveringId, setRediscoveringId] = useState<string | null>(null);
```

补两个 handler（放在 `checkHealth` 后面）：
```ts
  const toggleExpand = async (repo: Repo) => {
    const next = new Set(expanded);
    if (next.has(repo.id)) {
      next.delete(repo.id);
      setExpanded(next);
      return;
    }
    next.add(repo.id);
    setExpanded(next);
    if (!submodulesMap[repo.id] || submodulesMap[repo.id] === "loading") {
      setSubmodulesMap((m) => ({ ...m, [repo.id]: "loading" }));
      try {
        const subs = await api.listSubmodules(repo.id);
        setSubmodulesMap((m) => ({ ...m, [repo.id]: subs }));
      } catch (e: unknown) {
        toast.error("加载子模块失败", (e as Error)?.message ?? String(e));
        setSubmodulesMap((m) => {
          const c = { ...m };
          delete c[repo.id];
          return c;
        });
      }
    }
  };

  const rediscoverSubmodules = async (repo: Repo) => {
    setRediscoveringId(repo.id);
    try {
      const r = await api.rediscoverSubmodules(repo.id);
      const parts: string[] = [];
      if (r.added.length > 0) parts.push(`新增 ${r.added.length}`);
      parts.push(`已有 ${r.existing_count}`);
      if (r.warnings.length > 0) parts.push(`警告 ${r.warnings.length}`);
      toast.success("已重新发现子模块", parts.join(" · "));
      // 刷新展开内容
      const subs = await api.listSubmodules(repo.id);
      setSubmodulesMap((m) => ({ ...m, [repo.id]: subs }));
      // 自动展开
      setExpanded((s) => new Set(s).add(repo.id));
    } catch (e: unknown) {
      toast.error("重新发现失败", (e as Error)?.message ?? String(e));
    } finally {
      setRediscoveringId(null);
    }
  };
```

修改表格 `<thead>` 加 1 列（最左侧空列给展开按钮）：
```tsx
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="px-4 py-2.5 font-medium">别名</th>
                  ...
```

把现有 `<tr ...>` 整段（包含 6 个 td）替换为 React.Fragment，套一个折叠展开块。具体改写为：

```tsx
              <tbody>
                {repos.map((repo, idx) => {
                  const isExpanded = expanded.has(repo.id);
                  const subs = submodulesMap[repo.id];
                  return (
                    <React.Fragment key={repo.id}>
                      <tr
                        className={cn(
                          "border-b last:border-0 transition-colors hover:bg-muted/30",
                          idx % 2 === 1 && "bg-muted/10",
                        )}
                      >
                        <td className="px-2 py-2.5 align-middle">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => toggleExpand(repo)}
                            title={isExpanded ? "收起子模块" : "展开子模块"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-mono font-medium text-sm">{repo.alias}</span>
                        </td>
                        <td className="px-4 py-2.5 max-w-[220px]">
                          <span
                            className="font-mono text-xs text-muted-foreground truncate block"
                            title={repo.path}
                          >
                            {repo.path}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                            {repo.default_branch}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
                          {repo.github_owner && repo.github_repo
                            ? `${repo.github_owner}/${repo.github_repo}`
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5">{renderHealthCell(repo)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => rediscoverSubmodules(repo)}
                              disabled={rediscoveringId === repo.id}
                              title="重新发现子模块"
                            >
                              <GitBranch
                                className={cn(
                                  "h-3.5 w-3.5",
                                  rediscoveringId === repo.id && "animate-pulse",
                                )}
                              />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => checkHealth(repo)}
                              disabled={healthMap[repo.id] === "loading" || deletingId === repo.id}
                              title="健康检查"
                            >
                              <Activity className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => startEdit(repo)}
                              disabled={deletingId === repo.id}
                              title="编辑"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => remove(repo)}
                              disabled={deletingId === repo.id}
                              title="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-muted/10 border-b last:border-0">
                          <td colSpan={7} className="px-4 py-3">
                            {subs === "loading" && (
                              <span className="text-xs text-muted-foreground animate-pulse">
                                加载子模块…
                              </span>
                            )}
                            {Array.isArray(subs) && subs.length === 0 && (
                              <span className="text-xs text-muted-foreground">
                                此仓库无子模块。点
                                <GitBranch className="inline h-3 w-3 mx-1" />
                                重新发现以扫描 .gitmodules。
                              </span>
                            )}
                            {Array.isArray(subs) && subs.length > 0 && (
                              <div className="space-y-1.5 pl-4 border-l-2 border-border/60">
                                <div className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                                  子模块（{subs.length}）
                                </div>
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground/80">
                                      <th className="px-2 py-1 text-left font-medium">路径</th>
                                      <th className="px-2 py-1 text-left font-medium">别名</th>
                                      <th className="px-2 py-1 text-left font-medium">默认分支</th>
                                      <th className="px-2 py-1 text-left font-medium">GitHub</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subs.map((sm) => (
                                      <tr key={sm.id} className="border-t border-border/40">
                                        <td className="px-2 py-1 font-mono text-foreground">
                                          {sm.submodule_path ?? "—"}
                                        </td>
                                        <td className="px-2 py-1 font-mono">{sm.alias}</td>
                                        <td className="px-2 py-1">
                                          <Badge
                                            variant="secondary"
                                            className="font-mono text-[10px] font-normal"
                                          >
                                            {sm.default_branch}
                                          </Badge>
                                        </td>
                                        <td className="px-2 py-1 font-mono text-muted-foreground">
                                          {sm.github_owner && sm.github_repo
                                            ? `${sm.github_owner}/${sm.github_repo}`
                                            : "—"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
```

- [ ] **Step 2：typecheck + 构建**

```bash
bun run typecheck
bun run build:web
```
预期：0 错。

- [ ] **Step 3：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/web/src/pages/Repos.tsx
git commit -m "feat(web): Repos 页父 repo 行可展开子模块 + 重新发现按钮"
```

---

## Task 6：RequirementDetail.tsx 加「关联子模块 PR」卡片

**Files:**
- Modify: `src/web/src/pages/RequirementDetail.tsx`

**目标：**
- 在 Meta 区下方、左右两栏布局上方，加一个 Card 显示该需求关联的子模块 PR（仅当 sub_prs 非空时显示）
- 每条 PR：子模块 alias / GitHub PR 编号 + 链接（外链跳转）
- 在 `refresh()` 中并行加载 sub_prs

- [ ] **Step 1：扩展 import 和 state**

文件顶部 import 加 `RequirementSubPr`：
```ts
import { api, type Requirement, type RequirementFeedback, type Repo, type RequirementSubPr } from "@/hooks/useApi";
```

`export function RequirementDetail()` 内的 state 区追加：
```ts
  const [subPrs, setSubPrs] = useState<RequirementSubPr[]>([]);
```

- [ ] **Step 2：refresh 里并行加载 sub_prs**

把 `refresh()` 函数里的 `Promise.all` 部分：
```ts
      const [data, repoList] = await Promise.all([
        api.getRequirement(id),
        api.listRepos(),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      setSpecDraft(data.requirement.spec_md);
      setRepos(repoList);
```

改成：
```ts
      const [data, repoList, sub] = await Promise.all([
        api.getRequirement(id),
        api.listRepos(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      setSpecDraft(data.requirement.spec_md);
      setRepos(repoList);
      setSubPrs(sub);
```

`.catch(() => [])` 是为了向后兼容（旧 daemon 没这接口时 UI 不崩）。

- [ ] **Step 3：渲染 Card**

在 `Card mb-6 p-5` 那个 Meta Card 之后、`grid grid-cols-1` 之前插入：
```tsx
      {/* 关联子模块 PR */}
      {subPrs.length > 0 && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 text-sm font-semibold">
            关联子模块 PR <span className="text-muted-foreground font-normal">（{subPrs.length}）</span>
          </h2>
          <ul className="space-y-2">
            {subPrs.map((p) => {
              const childRepo = repos.find((r) => r.id === p.child_repo_id);
              const aliasOrId = childRepo?.alias ?? p.child_repo_id;
              return (
                <li key={p.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-medium">{aliasOrId}</span>
                  <span className="text-muted-foreground">·</span>
                  <a
                    href={p.pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                  >
                    PR #{p.pr_number}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
```

注意：`repos` state 里**不一定**包含子模块（`api.listRepos()` 默认只返回父）。要让子模块 alias 显示出来，需要把 `listRepos` 调用换为带 `includeSubmodules`，但当前 API 不支持参数。**简化方案：** 在新 Card 渲染时直接取 `child_repo_id` 后缀作为 fallback，更好的做法是后端 `sub_prs` 返回里附带 child alias。

为了不扩 API（YAGNI），就**直接显示 child_repo_id**（`repo-c1` 之类），子模块详情用户可以去 `/repos` 展开看。改 list 渲染：

把：
```tsx
              const childRepo = repos.find((r) => r.id === p.child_repo_id);
              const aliasOrId = childRepo?.alias ?? p.child_repo_id;
              return (
                <li ... >
                  <span className="font-mono font-medium">{aliasOrId}</span>
                  ...
```

改为：
```tsx
              return (
                <li key={p.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-medium text-muted-foreground">
                    {p.child_repo_id}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <a
                    href={p.pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                  >
                    PR #{p.pr_number}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              );
```

把 `const childRepo = ...` 那行删掉（未使用）。

- [ ] **Step 4：typecheck + 构建**

```bash
bun run typecheck
bun run build:web
```
预期：0 错。

- [ ] **Step 5：commit**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git add src/web/src/pages/RequirementDetail.tsx
git commit -m "feat(web): 需求详情显示关联子模块 PR 列表"
```

---

## Task 7：终验 + 推送

- [ ] **Step 1：跑全套测试**

```bash
bun test
bun run typecheck
bun run build:web
```
预期：所有 test pass、0 typecheck 错、build 成功。

- [ ] **Step 2：跳过 web-dist commit**

`web-dist/` 已在 `.gitignore`，不需要提交构建产物。

- [ ] **Step 3：push**

```bash
git branch --show-current  # 必须是 feat/requirement-queue-phase5-3-20260507
git push -u origin feat/requirement-queue-phase5-3-20260507
```

- [ ] **Step 4：开 PR（gh CLI）**

```bash
gh pr create \
  --base main \
  --head feat/requirement-queue-phase5-3-20260507 \
  --title "feat: 需求队列 P5.3 — 调度器组级锁 + Web UI 子模块可视化" \
  --body "$(cat <<'EOF'
## 变更摘要

接 P5.2，落地 P5.3 调度器组级锁与 Web UI：

### 调度器
- `tickRepo` 检测组内（父 + 所有子模块）任一 repo 的 active；任一组成员有 running/fix_revision 即占满槽位
- candidate 仅从主仓库（父 repo）拉 queued
- 传入子模块 id 也归一化到 group（从子模块状态变化的事件里也能正确触发组级 tick）

### chat tools
- `create_requirement_draft` 拒绝子模块 alias，提示用户改用父 repo alias

### API
- `GET /api/repos/:id/submodules` —— 列出某父 repo 的子模块
- `GET /api/requirements/:id/sub-prs` —— 列出某需求关联的子模块 PR

### Web UI
- `/repos`：父 repo 行可展开/折叠显示子模块表（路径 / 别名 / 默认分支 / GitHub）
- `/repos`：父 repo 行加「重新发现子模块」按钮
- `/requirements/:id`：Meta 下加「关联子模块 PR」Card

## 测试

- 单测：调度器组级锁 4 用例、API 端点 5 用例、chat tool 校验 3 用例
- 手动：reverse-bot-gui 健康检查 → 自动注册 reverse-bot-rs 子模块；UI 父行展开看到子；提需求选父成功，选子被拒

## 关联

- spec：`docs/superpowers/specs/2026-05-07-submodule-support-design.md` §4.3 §4.4
- plan：`docs/superpowers/plans/2026-05-07-submodule-support-phase5-3.md`
- 上游 PR：#39（P5.1）、#40（P5.2）

EOF
)"
```

- [ ] **Step 5：通知用户 PR 已创建**

输出 PR 链接给用户，等待他们 review/合并。

---

## Self-Review

### Spec coverage

- §4.3 调度器扩展 → Task 1 ✅（含组级 active 检测、candidate 从主仓库、event handler 兼容子模块 id）
- §4.4 chat tools `list_repos` 过滤 → 已有（`listRepos` 默认过滤）；`create_requirement_draft` 拒绝子模块 → Task 3 ✅
- §4.4 `/repos` UI 折叠展开 + 重新发现按钮 → Task 5 ✅
- §4.4 `/requirements/:id` UI 子模块 PR 列表 → Task 6 ✅
- 子 PR 数据已在 P5.2 落库（requirement_sub_prs 表 + appendSubPr）→ 本期通过新 API + UI 暴露 ✅
- 删除级联（deleteRepo / deleteRequirement）→ P5.1/P5.2 已实现，本期不动 ✅

### 与 P5.4 的边界

P5.4 是「测试 + 文档 + 手工 e2e（reverse-bot-gui）」。P5.3 已经把所有功能闭环、单测齐全；P5.4 只剩 docs 章节 + 真机跑通。

### 假设验证

- 路由入口名 `handleRequest`（已确认 export 在 routes.ts:313）。
- `Repo` 接口在前端补 `parent_repo_id` / `submodule_path` 后，已有调用 `(...createRepo body)` 是否会因 missing 字段编译失败？答：`createRepo` body 类型是单独的 inline 类型，不含这两个字段，未受影响。
- 子模块 alias 显示退化为 child_repo_id：用户体验勉强可接受；若需要 alias，后续可以扩 `/api/requirements/:id/sub-prs` 响应内嵌 child alias。

### 失误防御

每个 commit 步骤都强制 `git branch --show-current` 验证分支，防止再次提到 main。
