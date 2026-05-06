# 需求队列 Phase 1 实施计划：仓库管理 + req_dev workflow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地需求队列功能 Phase 1 —— 在 autopilot 上加「仓库」一级实体（DB + REST + Web UI + 健康检查），新建 `req_dev` workflow（接收 per-task `repo_id`，前 5 阶段：design → review → develop → code_review → submit_pr），替代旧 dev workflow。

**Architecture:** `repos` 表作为仓库目录中心；`req_dev` 的 `setup_req_dev_task` 通过 `repo_id` 从 `repos` 表查 `path / default_branch / github_owner / github_repo`，注入到 task extra；阶段函数直接读 task 字段而不依赖 workflow.config。Web UI 增加 `/repos` 页用于 CRUD + 健康检查。所有外部命令统一走 `Bun.spawn` argv 数组形式。

**Tech Stack:** Bun + TypeScript（daemon、CLI、core），React + Vite + react-router-dom（Web UI），bun:sqlite migration，bun:test。

**Spec reference:** `docs/superpowers/specs/2026-05-06-requirement-queue-design.md`

完整 plan 草稿见对话历史；最终落地版本将以 commit 增量补完每个 task 的代码细节。

## File Structure

新建：
- `src/migrations/003-repos.ts` — repos 表 migration
- `src/core/repos.ts` — repos CRUD
- `src/core/repo-health.ts` — 健康检查（path / git / origin）+ GitHub URL 解析
- `src/web/src/pages/Repos.tsx` — 仓库管理页
- `examples/workflows/req_dev/workflow.yaml`
- `examples/workflows/req_dev/workflow.ts`
- `examples/workflows/req_dev/config.example.yaml`
- `tests/repos.test.ts`
- `tests/req_dev_setup.test.ts`
- `tests/req_dev_e2e.test.ts`
- `docs/req-dev-workflow.md`

修改：
- `src/daemon/routes.ts` — 加 `/api/repos*` 路由
- `src/core/migrate.ts` — 注册 migration 003
- `src/client/http.ts` — 加 6 个 repos client 方法
- `src/web/src/App.tsx` — 加 `/repos` 路由 + 导航
- `docs/quickstart.md` — 加需求队列章节

## Tasks

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 1 | Migration 003 + 注册 | `repos` 表 schema | 10 min |
| 2 | Repos CRUD | `getRepoById / getRepoByAlias / list / create / update / delete / nextRepoId` | 30 min |
| 3 | 健康检查 | `checkRepoHealth(path)` + `parseGithubFromRemote(url)` | 30 min |
| 4 | REST `/api/repos*` | 5 端点 + 健康检查自动回填 | 30 min |
| 5 | Client HTTP | 6 方法 | 15 min |
| 6 | Web UI `/repos` | 列表 + Dialog 表单 + 健康检查 | 60 min |
| 7 | req_dev yaml + setup_func | 5 阶段 yaml + `setup_req_dev_task` | 30 min |
| 8a | `run_design` | architect agent 生成 plan.md，跳到 review | 20 min |
| 8b | `run_review` | reviewer 评审，PASS/REJECT 驱动状态机 | 15 min |
| 8c | `run_develop` | 建分支 + developer agent 写代码 + commit | 25 min |
| 8d | `run_code_review` | reviewer 看 diff，PASS/REJECT | 15 min |
| 8e | `run_submit_pr` | push + gh pr create/edit + 写回 pr_url/pr_number | 25 min |
| 9 | E2E smoke | startTaskFromTemplate 单测 | 20 min |
| 10 | 文档 | `docs/req-dev-workflow.md` + quickstart | 30 min |
| 11 | 手工 E2E | 真实 agent + git + gh 跑通到 PR 创建 | 60 min |

**总估时：约 6-7 小时**

## 共性约束（每个 task 都要遵守）

- **TDD**：先写测试 → 跑确认失败 → 写实现 → 跑确认通过 → typecheck → commit
- **每 task 一个 commit**，message 中文
- **外部命令统一 `Bun.spawn(argv数组)`**，禁止字符串拼接
- **任何 path 处理用 `path.join`**，禁止字符串拼接
- **catch 用 `catch (e: unknown)`**

## 关键代码骨架

### Migration 003-repos
```sql
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_owner TEXT,
  github_repo TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repos_alias ON repos(alias);
```

### `setup_req_dev_task`
```ts
export interface ReqDevSetupArgs {
  repo_id: string;
  title?: string;
  requirement?: string;
}

export function setup_req_dev_task(args: ReqDevSetupArgs): Record<string, unknown> {
  if (!args.repo_id) throw new Error("setup_req_dev_task: repo_id 必填");
  const repo = getRepoById(args.repo_id);
  if (!repo) throw new Error(`setup_req_dev_task: repo not found: ${args.repo_id}`);
  const title = args.title ?? "untitled";
  return {
    title,
    requirement: args.requirement ?? "",
    repo_id: repo.id,
    repo_path: repo.path,
    default_branch: repo.default_branch,
    github_owner: repo.github_owner,
    github_repo: repo.github_repo,
    branch: `feat/${title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`,
  };
}
```

### req_dev workflow.yaml（前 5 阶段）
```yaml
name: req_dev
description: "需求驱动开发流程（P1：design → review → develop → code_review → submit_pr）"
setup_func: setup_req_dev_task
agents:
  - name: architect
    provider: anthropic
    model: claude-sonnet-4-6
    permission_mode: bypassPermissions
  - name: developer
    provider: anthropic
    model: claude-opus-4-6
    permission_mode: bypassPermissions
  - name: reviewer
    provider: anthropic
    model: claude-sonnet-4-6
    permission_mode: bypassPermissions
phases:
  - name: design
    agent: architect
    timeout: 900
  - name: review
    agent: reviewer
    timeout: 900
    reject: design
    max_rejections: 10
  - name: develop
    agent: developer
    timeout: 1800
  - name: code_review
    agent: reviewer
    timeout: 1200
    reject: develop
    max_rejections: 10
  - name: submit_pr
    timeout: 300
```

### 阶段函数模板（参考 examples/workflows/dev/workflow.ts 的实现）

req_dev 阶段函数与现有 dev workflow 阶段函数高度同构，差别仅在：
- 不再读 `workflow.config.repo_path`，而是从 task 字段读 `repo_path`
- 新增 `github_owner / github_repo` 字段透传供 PR 创建用

实施时直接参考 `examples/workflows/dev/workflow.ts:run_design / run_review / run_develop / run_code_review / run_submit_pr` 现有实现，按上述差异调整。

### REST 路由片段
```ts
if (url.pathname === "/api/repos" && req.method === "GET") {
  return Response.json({ repos: listRepos() });
}
if (url.pathname === "/api/repos" && req.method === "POST") {
  const body = await req.json();
  if (!body.alias || !body.path) return Response.json({ error: "alias 和 path 必填" }, { status: 400 });
  const id = nextRepoId();
  try { createRepo({ id, ...body }); }
  catch (e: unknown) { return Response.json({ error: (e as Error).message }, { status: 409 }); }
  return Response.json({ repo: getRepoById(id) }, { status: 201 });
}
const m = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
if (m) {
  const id = m[1];
  const repo = getRepoById(id);
  if (!repo) return Response.json({ error: "repo not found" }, { status: 404 });
  if (req.method === "GET") return Response.json({ repo });
  if (req.method === "PUT") {
    const body = await req.json();
    try { updateRepo(id, body); } catch (e: unknown) { return Response.json({ error: (e as Error).message }, { status: 409 }); }
    return Response.json({ repo: getRepoById(id) });
  }
  if (req.method === "DELETE") { deleteRepo(id); return Response.json({ ok: true }); }
}
const hm = url.pathname.match(/^\/api\/repos\/([^/]+)\/healthcheck$/);
if (hm && req.method === "POST") {
  const id = hm[1];
  const repo = getRepoById(id);
  if (!repo) return Response.json({ error: "repo not found" }, { status: 404 });
  const result = await checkRepoHealth(repo.path);
  if (result.github_owner && !repo.github_owner) {
    updateRepo(id, { github_owner: result.github_owner, github_repo: result.github_repo });
  }
  return Response.json({ healthy: result.healthy, issues: result.issues });
}
```

## Self-Review 检查表

### Spec 覆盖率
| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §3.1 repos 表 | T1, T2 |
| repo 健康检查（§3.1） | T3 |
| §4 req_dev workflow yaml | T7 |
| §4 setup_func | T7（含单测） |
| §4 阶段函数（5 阶段，P1 范围） | T8a-T8e |
| §9.1 `/repos` Web UI | T6 |
| §12 P1 验收标准 | T11 |
| §12 旧 dev 退场 | T10 |

P1 不覆盖（按 spec §12 留给后续 phase）：requirements 表、await_review/fix_revision、pr-poller、chat 工具、需求池 UI。

### Placeholder 扫描：✅ 无 TBD/TODO

### 类型一致性：
- `Repo` 接口字段在 core/repos.ts 与 client/http.ts 一致
- `setup_req_dev_task` 返回字段（repo_path / default_branch / branch / requirement / github_owner / github_repo）跟阶段函数读取字段名一致

## 后续

- P2 plan：在 P1 落地后另写
- P3 plan：在 P2 落地后另写
- P4 plan：在 P3 落地后另写
