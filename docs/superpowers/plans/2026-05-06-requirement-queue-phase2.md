# 需求队列 Phase 2 实施计划：需求池 + chat 集成

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P2 — 在 P1 仓库管理 + req_dev workflow 之上，加 `requirements` 一级实体（DB + REST + chat tools + Web UI 需求池），让用户能跟 chat agent 提需求 → 多轮澄清 → 用户确认入队 → 触发一个 req_dev task。

**Architecture:** `requirements` 表 + `requirement_feedbacks` 表（schema 一次到位含 P3/P4 字段）；REST 5 端点驱动状态机；8 个 chat agent 工具构建对话流；Web UI 两个新页面（需求池列表 + 详情）；过渡降级：enqueue 直接调 `startTaskFromTemplate` 创建 req_dev task（P3 调度器接管前的 stop-gap）。

**Tech Stack:** Bun + TypeScript（daemon、CLI、core、agents），React + Vite（Web），bun:sqlite migration，bun:test，Anthropic SDK（chat tools `@anthropic-ai/claude-agent-sdk`）。

**Spec reference:** `docs/superpowers/specs/2026-05-06-requirement-queue-design.md` §3.2 / §3.3 / §5.1 / §8 / §9.2 / §9.3 / §12 P2

---

## File Structure

新建：

| 文件 | 职责 |
|------|------|
| `src/migrations/005-requirements.ts` | `requirements` + `requirement_feedbacks` 表 schema |
| `src/core/requirements.ts` | Requirements CRUD + 状态机辅助 |
| `src/core/requirement-feedbacks.ts` | 反馈历史 append-only 写入与读取 |
| `src/web/src/pages/Requirements.tsx` | 需求池列表（按状态分 tab） |
| `src/web/src/pages/RequirementDetail.tsx` | 详情页（spec 编辑 / 入队 / 注入反馈 / 反馈历史） |
| `tests/requirements.test.ts` | migration + CRUD + 状态流转测试 |
| `tests/requirements_chat.test.ts` | chat tools 集成测试 |

修改：

| 文件 | 改动 |
|------|------|
| `src/daemon/routes.ts` | 加 8 个 `/api/requirements*` 端点 |
| `src/agents/tools.ts` | 加 8 个 chat agent 工具 |
| `src/web/src/hooks/useApi.ts` | 加 requirement / feedback 方法 + `NEW_API_PATTERNS` 追加 |
| `src/web/src/App.tsx` | 加 2 个路由 + 导航菜单项（`Inbox` 图标，"需求"） |

---

## Tasks 一览

| # | Task | 关键产出 | 预计 |
|---|------|---------|------|
| 1 | Migration 005 + schema 测试 | requirements + requirement_feedbacks 表 | 20 min |
| 2 | Requirements CRUD + 状态机 | 7 函数 + 10 状态转换表 | 50 min |
| 3 | Requirement Feedbacks CRUD | append / list / latest | 15 min |
| 4 | REST `/api/requirements*` | 8 端点 | 45 min |
| 5 | useApi methods | 9 方法 + NEW_API_PATTERNS | 15 min |
| 6 | `/requirements` 列表页 | tab 分组 + 行操作 | 50 min |
| 7 | `/requirements/:id` 详情页 | spec 编辑 + 操作 + 反馈时间线 | 60 min |
| 8 | 8 个 chat agent 工具 | tools.ts 追加 | 75 min |
| 9 | enqueue 临时降级 → 创建 req_dev task | routes + tools 双改 | 30 min |
| 10 | 文档 + 端到端验证 | docs/requirement-queue.md | 30 min |

**总估时**：约 6.5 小时

---

## 共性约束

- TDD：先写测试 → 跑 FAIL → 实现 → 跑 PASS → typecheck → commit
- 每 task 一个 commit；message 中文
- 外部命令统一 `Bun.spawn` argv 数组
- catch 用 `catch (e: unknown)`
- 时间戳沿用 P1 repos 表惯例：`INTEGER`（epoch ms）
- ID 生成器：`req-001` / `req-002` 风格，靠 PK 兜底并发
- 状态变化时**用 event-bus emit `requirement:status-changed`** 事件（payload: `{ id, from, to }`）—— P3 调度器订阅此事件触发 tickRepo

---

## Task 1：Migration 005

**Files:**
- Create: `src/migrations/005-requirements.ts`
- Create: `tests/requirements.test.ts`

### Schema（一次到位含 P3/P4 字段）

```sql
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_md TEXT NOT NULL DEFAULT '',
  chat_session_id TEXT,
  task_id TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  last_reviewed_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_repo ON requirements(repo_id);
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_requirements_repo_status ON requirements(repo_id, status);

CREATE TABLE IF NOT EXISTS requirement_feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  github_review_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_req ON requirement_feedbacks(requirement_id);
```

### 测试

参考 `tests/repos.test.ts` 风格：3 个测试覆盖
1. requirements 表字段完整（PRAGMA table_info）
2. requirement_feedbacks 表字段完整
3. FK 约束（启用 `PRAGMA foreign_keys = ON` 后插入不存在的 repo_id 应抛错）

commit：`feat(db): 加 requirements + requirement_feedbacks 表（migration 005）`

---

## Task 2：Requirements CRUD + 状态机

**Files:**
- Create: `src/core/requirements.ts`
- Modify: `tests/requirements.test.ts`（追加）

### 关键设计：状态转换表

10 个状态：`drafting / clarifying / ready / queued / running / awaiting_review / fix_revision / done / cancelled / failed`

```ts
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  drafting: ["clarifying", "ready", "cancelled"],
  clarifying: ["drafting", "ready", "cancelled"],
  ready: ["queued", "drafting", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["awaiting_review", "failed", "cancelled"],
  awaiting_review: ["fix_revision", "done", "cancelled"],
  fix_revision: ["awaiting_review", "failed", "cancelled"],
  done: [],
  cancelled: [],
  failed: ["queued"],  // 允许重新入队
};
```

### 接口与函数

```ts
export interface Requirement {
  id: string;
  repo_id: string;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  created_at: number;  // epoch ms
  updated_at: number;
}

export function createRequirement(opts): Requirement;        // 总是从 drafting 开始
export function getRequirementById(id): Requirement | null;
export function listRequirements(filters?: { repo_id?, status? }): Requirement[];
export function updateRequirement(id, opts): Requirement | null;  // 不改 status，仅可变字段
export function setRequirementStatus(id, to): Requirement;   // 校验合法转换 + emit event-bus
export function canTransitionStatus(from, to): boolean;
export function nextRequirementId(): string;
```

`setRequirementStatus` 内部：
- 读当前 status，对比 to
- 调 `canTransitionStatus` 校验，非法直接 throw
- UPDATE status + updated_at
- `emit({ type: "requirement:status-changed", payload: { id, from, to } })`

### 测试覆盖（追加 5 个）

- create + getById + list（含状态默认 drafting + created_at 是 number）
- setStatus 合法转换链：drafting → clarifying → ready → queued
- setStatus 非法转换 throw
- canTransitionStatus 表对照
- updateRequirement 部分字段 + nextRequirementId 自增

commit：`feat(core): 加 requirements CRUD + 状态机`

---

## Task 3：Requirement Feedbacks CRUD

**Files:**
- Create: `src/core/requirement-feedbacks.ts`
- Modify: `tests/requirements.test.ts`（追加）

### 接口

```ts
export interface RequirementFeedback {
  id: number;
  requirement_id: string;
  source: "github_review" | "manual";
  body: string;
  github_review_id: string | null;
  created_at: number;
}

export function appendFeedback(opts): RequirementFeedback;
export function listFeedbacks(requirement_id): RequirementFeedback[];  // 升序
export function latestFeedback(requirement_id): RequirementFeedback | null;
```

### 测试覆盖

- append 后 list 返回升序
- latestFeedback 取最新
- github_review_id 默认 null

commit：`feat(core): 加 requirement_feedbacks CRUD`

---

## Task 4：REST `/api/requirements*` 端点

**Files:**
- Modify: `src/daemon/routes.ts`

### 8 个端点

| Method | Path | 行为 |
|--------|------|------|
| GET | `/api/requirements?repo_id=&status=` | 列表 → `{ requirements }` |
| GET | `/api/requirements/:id` | 详情含 feedbacks → `{ requirement, feedbacks }` |
| POST | `/api/requirements` | 创建草稿 → `{ requirement }` 201 |
| PUT | `/api/requirements/:id` | 更新可变字段 → `{ requirement }` |
| DELETE | `/api/requirements/:id` | 仅终态可删 |
| POST | `/api/requirements/:id/transition` | body `{ to }` 状态转换 |
| POST | `/api/requirements/:id/enqueue` | ready → queued（Task 9 起会同步创建 task） |
| POST | `/api/requirements/:id/inject_feedback` | 追加 manual / github_review 反馈 |
| POST | `/api/requirements/:id/cancel` | → cancelled |

### 实现要点

- import 统一从 `src/core/requirements.ts` 和 `src/core/requirement-feedbacks.ts`
- POST `/api/requirements` 必填校验：`repo_id` 和 `title`，且 `getRepoById(repo_id)` 必须存在
- PUT 不允许改 status（只能走 transition / enqueue / cancel 端点）
- DELETE 仅 `cancelled / done / failed` 状态允许
- 错误风格沿用 P1 routes.ts 的 `error()` / `json()` helper

### 实机 e2e（在 commit 前必跑）

写一个 bash 脚本走完整链路：创建 repo → POST /api/requirements 创建 → PUT 改 spec_md → POST /transition 改状态 → enqueue → inject_feedback → 详情 → cancel；每步断言响应。

commit：`feat(api): 加 /api/requirements REST 路由`

---

## Task 5：useApi methods + NEW_API_PATTERNS

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

### 加类型

```ts
export interface Requirement { /* 跟 core/requirements.ts 一致 */ }
export interface RequirementFeedback { /* 跟 core/requirement-feedbacks.ts 一致 */ }
```

### 加 9 个方法

`listRequirements / getRequirement / createRequirement / updateRequirement / deleteRequirement / transitionRequirement / enqueueRequirement / injectFeedback / cancelRequirement`

⚠️ **务必解包 envelope**（吸取 P1 useApi 列表不显示的教训）：

```ts
listRequirements: (filters?) => {
  const params = new URLSearchParams(/*...*/);
  return request<{ requirements: Requirement[] }>(`/api/requirements${qs}`)
    .then(r => r.requirements);   // 必须解包
},
getRequirement: (id) =>
  request<{ requirement: Requirement; feedbacks: RequirementFeedback[] }>(`/api/requirements/${id}`),
  // ↑ 这个不解包：调用方需要 feedbacks 数组
createRequirement / updateRequirement / transitionRequirement / enqueueRequirement / cancelRequirement:
  全部 .then(r => r.requirement) 解包
deleteRequirement: 返回 { ok: true } 不解包
injectFeedback: 返回 { ok: true } 不解包
```

### NEW_API_PATTERNS 追加

```ts
/^\/api\/requirements/, // requirements CRUD（Phase 2）
```

commit：`feat(web): useApi 加 requirements 方法`

---

## Task 6：`/requirements` 列表页

**Files:**
- Create: `src/web/src/pages/Requirements.tsx`
- Modify: `src/web/src/App.tsx`

### 设计

参考 `src/web/src/pages/Repos.tsx` 风格。

**Tabs 分组**：

```ts
const STATUS_GROUPS = {
  drafts: ["drafting", "clarifying"],
  ready: ["ready"],
  running: ["queued", "running", "awaiting_review", "fix_revision"],
  done: ["done", "cancelled", "failed"],
};
```

**列表行**：title / repo alias（用 listRepos 组成 id→alias 映射）/ 状态徽标 / PR 链接 / 操作（查看 / 取消）

**「新建需求」**按钮 → Dialog（repo 下拉 + title 文本框）→ 提交后 navigate 到 `/requirements/:id`

### App.tsx 改动

- lazy import：
  ```tsx
  const Requirements = lazy(() => import("./pages/Requirements").then(m => ({ default: m.Requirements })));
  const RequirementDetail = lazy(() => import("./pages/RequirementDetail").then(m => ({ default: m.RequirementDetail })));
  ```
- Routes：加 `/requirements` 和 `/requirements/:id`
- 导航菜单：加 `{ path: "/requirements", label: "需求", icon: Inbox, end: true }`，`Inbox` from lucide-react
- titleForPath：`/requirements` → `"需求池"`

### 验证

`bun run build:web` 输出包含 `Requirements-*.js`；浏览器访问 `/requirements` 看到 4 个 tab + 空状态。

commit：`feat(web): 加 /requirements 需求池列表页`

---

## Task 7：`/requirements/:id` 详情页

**Files:**
- Create: `src/web/src/pages/RequirementDetail.tsx`

### 布局

**顶部**：title / repo / 状态徽标 / PR 链接（仅在有 pr_url 时）/ 关联 task 链接（仅在有 task_id 时，跳 `/tasks/:id`）

**主体（左右两栏）**：

**左：需求规约 spec_md**
- 默认渲染（用 `<pre>` 或简单 markdown 转换；无第三方依赖时直接 `<pre className="whitespace-pre-wrap">{spec_md}</pre>`）
- 「编辑」按钮 → 切到 `<textarea>` + 「保存」「取消」

**右：操作 + 反馈历史**
- 操作按钮（按 status 显示）：
  - drafting / clarifying → 「标记为已澄清」(transition to ready)
  - ready → 「入队执行」(enqueue)
  - awaiting_review → 注入反馈 textarea + 「提交反馈」按钮（injectFeedback）
  - 任何非终态（除 done/cancelled/failed）→ 「取消」按钮（cancel）
- 反馈历史时间线：按 created_at 升序，显示 source / body 摘要 / 时间

### 实现框架

参考 P1 plan task 7 的 RepoDetail 没做（P1 没单独详情页）；可参考 `src/web/src/pages/TaskDetail.tsx` 风格。

commit：`feat(web): 加 /requirements/:id 详情页`

---

## Task 8：8 个 chat agent 工具

**Files:**
- Modify: `src/agents/tools.ts`
- Create: `tests/requirements_chat.test.ts`

### 工具清单（在 `buildAutopilotTools()` 数组追加）

| 工具名 | 入参 schema | 行为 |
|--------|-------------|------|
| `list_repos` | — | 列所有 repos（alias / id / path / default_branch） |
| `create_requirement_draft` | `{ repo_alias, title, initial_text? }` | 解析 alias → 创建草稿（status=drafting）→ 返回 id |
| `update_requirement_spec` | `{ req_id, spec_md }` | 写入完整规约；若当前 drafting 自动转 clarifying |
| `mark_requirement_ready` | `{ req_id }` | clarifying → ready |
| `enqueue_requirement` | `{ req_id }` | ready → queued（Task 9 起同步创建 task） |
| `list_requirements` | `{ repo_alias?, status? }` | 列出，repo_alias 解析为 repo_id 后过滤 |
| `inject_feedback` | `{ req_id, body }` | 追加 manual 反馈 |
| `cancel_requirement` | `{ req_id }` | 任意非终态 → cancelled |

### 实现风格

每个工具按现有 `start_task` 等工具的 `tool(name, desc, schema, handler)` 模式。handler 内：
- 输入校验（repo 不存在 / req 不存在 → `err(...)`）
- 调用 core/requirements 的 setter
- 返回 `ok({ id, status, ... })`

### 测试

`tests/requirements_chat.test.ts` 用 mock 直接调 tool handler（不走 SDK chat 框架），覆盖：
- create_requirement_draft 创建后 status=drafting
- update_requirement_spec 后 status=clarifying（自动）
- mark_requirement_ready 后 status=ready
- enqueue_requirement 后 status=queued（Task 9 完成后会变 running）
- inject_feedback 追加一条记录
- cancel_requirement 任意状态 → cancelled

commit：`feat(agents): 加 8 个需求队列 chat 工具`

---

## Task 9：enqueue 临时降级 — 直接创建 req_dev task

**Files:**
- Modify: `src/daemon/routes.ts`（enqueue handler）
- Modify: `src/agents/tools.ts`（enqueue_requirement tool）

### 要做的事

在 enqueue 端点和 chat 工具中，`setRequirementStatus(id, "queued")` 之后追加：

1. `getRepoById(r.repo_id)` 取仓库
2. 调 `startTaskFromTemplate({ workflow: "req_dev", title: r.title, requirement: r.spec_md, repo_id: r.repo_id })`
3. 写回 `task_id` 到 requirement
4. `setRequirementStatus(id, "running")`

### 失败处理

如果 `startTaskFromTemplate` 抛错：
- 回滚 status：`setRequirementStatus(id, "ready")`（注意：queued → ready 不在合法转换表里！需要先放宽：在 `ALLOWED_TRANSITIONS.queued` 加 `"ready"`，或 catch 后用 force update —— 推荐在 Task 2 状态表里就允许 `queued → ready`）

> ⚠️ 这意味着**回到 Task 2 修一行表**：把 `queued: ["running", "cancelled"]` 改成 `queued: ["running", "cancelled", "ready"]`。Task 9 implementer 负责发现并修复。

### 验收

POST `/api/requirements/:id/enqueue` 后：
- `requirement.status` = `running`
- `requirement.task_id` 不为 null
- `bun run src/cli/index.ts task list` 能看到一个 req_dev workflow 的 task

commit：`feat(api): enqueue 端点 P2 临时降级 — 直接创建 req_dev task`

---

## Task 10：文档 + 端到端验证

**Files:**
- Create: `docs/requirement-queue.md`

### 文档内容

用户视角的需求队列使用指南：
1. 流程概述图（提需求 → 澄清 → 入队 → 执行 → 完成）
2. chat 用法（粘贴一段示例对话脚本）
3. Web UI `/requirements` 操作步骤截图占位
4. P2 当前限制：
   - 同仓库串行 / PR 反馈循环 P3 才有
   - GitHub 自动监听 P4 才有
   - enqueue 是临时直接创建 task；P3 起由调度器接管
5. 路线图：P3 / P4 概要

### 实机端到端验证（人工）

```
1. 启动 daemon：autopilot daemon stop && autopilot daemon start
2. /repos 注册仓库 + 健康检查（已在 P1 完成的步骤）
3. 在 /chat 跟 agent 提需求："我有个需求 — 在 README 加一段介绍"
4. agent 应：
   - 调 list_repos
   - 询问选哪个仓库
   - 调 create_requirement_draft
   - 多轮追问（验收标准、约束）
   - 调 update_requirement_spec
   - 等用户说 "OK 入队"
   - 调 mark_requirement_ready + enqueue_requirement
5. /tasks 出现一个 req_dev task
6. /requirements 看到该需求 status=running，task_id 链接到刚创建的 task
7. （可选）让 task 走完到 submit_pr，验证 PR 创建
```

commit：`docs: 加需求队列使用指南 + P2 端到端验证`

---

## Self-Review 检查表

### Spec 覆盖率

| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §3.2 requirements 表 | T1, T2 |
| §3.3 requirement_feedbacks 表 | T1, T3 |
| §5.1 需求创建到入队流程 | T8（chat tools）+ T9（enqueue） |
| §8 8 个 chat agent 工具 | T8 |
| §9.2 `/requirements` 列表 | T6 |
| §9.3 `/requirements/:id` 详情 | T7 |
| §12 P2 临时降级 enqueue 直接创建 task | T9 |

P2 不覆盖（按 spec §12 留给 P3/P4）：requirement-scheduler / await_review/fix_revision 阶段 / pr-poller。

### Placeholder 扫描

✅ 无 TBD/TODO（注释里 `TODO: > 999` padding 是性能 follow-up，是有意保留的）

### 类型一致性

- `Requirement` / `RequirementFeedback` 接口在 `src/core/*.ts` 与 `src/web/src/hooks/useApi.ts` 字段完全一致
- 状态枚举 10 种在 core / chat tools / Web UI tab 三处一致
- `feedback.source` 类型 `"manual" | "github_review"` 跨层一致

---

## 后续 Phase

- **P3**：调度器 + await_review/fix_revision 阶段函数 + 手动反馈触发回流
- **P4**：gh CLI 轮询监听器（PR review 自动感知）

各 phase 实施后再写下一份 plan。
