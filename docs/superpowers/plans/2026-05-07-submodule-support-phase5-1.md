# 需求队列 P5.1 实施计划：DB + 健康检查扩展（submodule 基础层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 submodule 支持基础层 — DB schema 扩展（repos 加 parent_repo_id + submodule_path，新增 requirement_sub_prs 表）+ 健康检查时自动解析 .gitmodules 注册子模块。完成后 /repos 注册带 submodule 的父 repo（如 reverse-bot-gui）能自动发现并入库子模块；workflow 改造留给 P5.2。

**Architecture:** migration 006 加字段 + 新表；纯函数 `parseGitmodulesFile()` 解析 .gitmodules；`discoverSubmodules(parentRepoId)` 同步逻辑（增量：新发现的注册，已存在的不动）；现有 `POST /api/repos/:id/healthcheck` 在原有逻辑后追加 discover；新增 `POST /api/repos/:id/rediscover-submodules` 端点；`listRepos()` 默认 filter 掉子模块（保持父 repo 列表不变），新增 `listSubmodules(parentId)` 给 UI 用。

**Tech Stack:** Bun + TypeScript，bun:sqlite migration，bun:test。所有 git 调用走 `Bun.spawn` argv 数组（无 shell 注入）。

**Spec reference:** `docs/superpowers/specs/2026-05-07-submodule-support-design.md` §3.1 / §3.2 / §4.1 / §4.6 / §8 (Phase 5.1)

---

## File Structure

新建：

| 文件 | 职责 |
|------|------|
| `src/migrations/006-submodules.ts` | repos 加 2 列 + 新建 requirement_sub_prs 表 |
| `src/core/gitmodules-parser.ts` | 纯函数：解析 .gitmodules 文件 → SubmoduleEntry[] |
| `src/core/submodules.ts` | discover / list / 删除级联 等 submodule 业务逻辑 |
| `tests/gitmodules-parser.test.ts` | 解析多种 .gitmodules 格式 |
| `tests/submodules.test.ts` | discoverSubmodules + listSubmodules + cascade delete |

修改：

| 文件 | 改动 |
|------|------|
| `src/core/repos.ts` | `Repo` 接口加 parent_repo_id / submodule_path；`listRepos` 默认 filter `parent_repo_id IS NULL`；createRepo / updateRepo 支持新字段；deleteRepo 级联删子模块 |
| `src/daemon/routes.ts` | 健康检查端点尾部追加 discoverSubmodules；新增 `POST /api/repos/:id/rediscover-submodules` |
| `tests/repos.crud.test.ts` | listRepos filter 默认值变化适配；createRepo 新字段测试 |
| `tests/single-writer-invariant.test.ts` | 白名单加 `src/core/submodules.ts` |

---

## Tasks 一览

| # | Task | 关键产出 | 估时 |
|---|------|---------|------|
| 1 | Migration 006 + schema 测试 | repos 加 2 字段 + requirement_sub_prs 表 | 15 min |
| 2 | gitmodules-parser 纯函数 | parseGitmodulesFile / parseGitmodulesContent | 20 min |
| 3 | repos.ts 扩展 | Repo 接口 + listRepos filter + 级联删 | 25 min |
| 4 | submodules 核心模块 | discoverSubmodules + listSubmodules | 35 min |
| 5 | 健康检查路由扩展 + rediscover 端点 | 自动 discover；REST API | 25 min |
| 6 | 实机 e2e（用 reverse-bot-gui） | 注册 → 健康检查 → DB 含子模块 | 15 min |

**总估时**：约 2.5 小时（spec 估 2 hr）

---

## 共性约束

- TDD：先写测试 → 跑 FAIL → 实现 → 跑 PASS → typecheck → commit
- 每 task 一个 commit；message 中文
- 所有外部命令走 `Bun.spawn` argv 数组形式
- catch 用 `catch (e: unknown)`
- 时间戳沿用 P1 repos 表惯例：INTEGER（epoch ms）
- 所有写 DB 走 core 层函数（不在 routes.ts 直写 SQL；single-writer-invariant 已强制）

---

## Task 1：Migration 006

**Files:** Create `src/migrations/006-submodules.ts` + `tests/submodules.test.ts`

参考 P1 `004-repos.ts` 风格写。

migration up() 函数内执行的 SQL（用 `db.exec` 跑一段多语句）：

```sql
ALTER TABLE repos ADD COLUMN parent_repo_id TEXT REFERENCES repos(id);
ALTER TABLE repos ADD COLUMN submodule_path TEXT;

CREATE TABLE IF NOT EXISTS requirement_sub_prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  child_repo_id TEXT NOT NULL REFERENCES repos(id),
  pr_url TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(requirement_id, child_repo_id)
);
CREATE INDEX IF NOT EXISTS idx_sub_prs_req ON requirement_sub_prs(requirement_id);
```

测试 3 个：
1. repos 表加了 parent_repo_id + submodule_path 字段（PRAGMA table_info）
2. requirement_sub_prs 表 6 字段齐全
3. UNIQUE(requirement_id, child_repo_id) 约束生效（重复 INSERT 抛 UNIQUE 错）

测试 setup 跑 migrate004 + migrate005 + migrate006。

commit: `feat(db): 加 submodule 字段 + requirement_sub_prs 表（migration 006）`

---

## Task 2：gitmodules-parser 纯函数

**Files:** Create `src/core/gitmodules-parser.ts` + `tests/gitmodules-parser.test.ts`

### 接口

```ts
export interface SubmoduleEntry {
  name: string;            // [submodule "<name>"] 里的 name
  path: string;            // 父 repo 内相对路径
  url: string;             // git remote url
  branch: string | null;   // .gitmodules 的 branch 字段；不存在时 null
}

export function parseGitmodulesFile(repoPath: string): SubmoduleEntry[];
export function parseGitmodulesContent(content: string): SubmoduleEntry[];
```

### 实现要点

- INI 风格 `[submodule "name"]` 段；逐行扫描
- 拒绝 path 含 `..` 或 `/` 开头（路径穿越）
- 缺 path 或 url 的段被丢弃
- 支持 tab/多空格分隔；忽略注释行（`#` / `;`）
- 空文件 / 不存在文件返回空数组

### 测试 6 个

```ts
it("解析单个子模块 + branch", () => {
  // 输入：[submodule "reverse-bot-rs"] path = ... url = ... branch = master
  // 期待：[{ name, path, url, branch: "master" }]
});

it("解析多个子模块（无 branch）", () => {
  // 多段，不含 branch
  // 期待：branch 字段为 null
});

it("空文件返回空数组", () => {
  expect(parseGitmodulesContent("")).toEqual([]);
});

it("拒绝路径含 .. 的子模块", () => {
  // path = ../../../etc → 该段被丢弃
});

it("忽略缺 path 或 url 的不完整段", () => {
  // 一段只有 path 缺 url → 整段丢弃
});

it("空白容忍：tab / 多空格 / 末尾换行不影响", () => {
  // 不同 whitespace 都能正确解析
});
```

commit: `feat(core): 加 gitmodules-parser 纯函数（解析 .gitmodules）`

---

## Task 3：repos.ts 扩展

**Files:** Modify `src/core/repos.ts` + `tests/repos.crud.test.ts`

### Repo 接口加字段

```ts
export interface Repo {
  id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_repo_id: string | null;     // 新增：非空表示此 repo 是子模块
  submodule_path: string | null;     // 新增：父 repo 内相对路径
  created_at: number;
  updated_at: number;
}
```

`CreateRepoOpts` / `UpdateRepoOpts` 同样加这两个字段（可选）。

### createRepo

INSERT 时把新字段传入（默认 null）。

### updateRepo

可更新字段加入 parent_repo_id / submodule_path（用于自动注册时 set，未来 UI 也可手动改）。

### listRepos 改造

```ts
export function listRepos(opts: { includeSubmodules?: boolean } = {}): Repo[] {
  const db = getDb();
  const sql = opts.includeSubmodules
    ? "SELECT * FROM repos ORDER BY created_at ASC"
    : "SELECT * FROM repos WHERE parent_repo_id IS NULL ORDER BY created_at ASC";
  return db.query<Repo, []>(sql).all();
}
```

⚠️ Breaking：`listRepos()` 默认仅顶级父 repo。检查所有调用方（`grep -rn "listRepos\b" src/ tests/`）：旧 DB 没子模块行，行为兼容；P5.3 调度器组级才需要 `includeSubmodules: true`。

### deleteRepo 级联

```ts
export function deleteRepo(id: string): void {
  const db = getDb();
  // 先删所有子模块行（如果此 repo 是父）
  db.run("DELETE FROM repos WHERE parent_repo_id = ?", [id]);
  // 再删自身
  db.run("DELETE FROM repos WHERE id = ?", [id]);
}
```

### 测试追加（4 个）

```ts
describe("repos submodule 字段（P5.1）", () => {
  it("createRepo 接受 parent_repo_id + submodule_path", () => { ... });
  it("listRepos 默认不含子模块", () => { ... });
  it("listRepos({ includeSubmodules: true }) 含全部", () => { ... });
  it("deleteRepo 级联删子模块", () => { ... });
});
```

注意 `tests/repos.crud.test.ts` 现有 setup 跑 migrate004，加 migrate006。

commit: `feat(core): repos 扩展 parent_repo_id + submodule_path 字段；listRepos 默认过滤子模块`

---

## Task 4：submodules 核心模块

**Files:** Create `src/core/submodules.ts` + 测试追加 `tests/submodules.test.ts` + 白名单 `tests/single-writer-invariant.test.ts`

### 接口

```ts
import type { Repo } from "./repos";

export interface DiscoverResult {
  added: Repo[];          // 本次新增的子模块
  existing: Repo[];       // 已存在的子模块（不动）
  warnings: string[];     // .gitmodules 里有但跳过的
}

export function listSubmodules(parentRepoId: string): Repo[];
export function discoverSubmodules(parentRepoId: string): DiscoverResult;
```

### listSubmodules

```ts
export function listSubmodules(parentRepoId: string): Repo[] {
  const db = getDb();
  return db.query<Repo, [string]>(
    "SELECT * FROM repos WHERE parent_repo_id = ? ORDER BY submodule_path ASC"
  ).all(parentRepoId);
}
```

### discoverSubmodules 算法

1. 校验 parentRepoId 存在；自身 parent_repo_id 必须为 null（不支持嵌套，throw `不支持嵌套...`）
2. `parseGitmodulesFile(parent.path)` 拿 entries
3. `existing = listSubmodules(parent.id)` + `existingByPath = Map(submodule_path → Repo)`
4. 对每个 entry：
   - 已存在（按 submodule_path 比对）→ result.existing 加，从 map 删除
   - 物理路径 `<parent.path>/<entry.path>` 不存在或不是目录 → result.warnings 加
   - URL 非 GitHub（`parseGithubFromRemote(entry.url)` 返回 null）→ result.warnings 加
   - 否则：
     - alias = pickUniqueAlias(entry.name)（冲突时 -2 / -3 后缀）
     - default_branch = entry.branch ?? "main"
     - 用 `nextRepoId` from "./repos"
     - createRepo 含 parent_repo_id / submodule_path
     - result.added 加
5. existingByPath 还剩的 = DB 有但 .gitmodules 没 → result.warnings 加（不自动删，避免破坏关联 requirements）

### pickUniqueAlias 辅助

```ts
function pickUniqueAlias(base: string): string {
  const all = listRepos({ includeSubmodules: true });
  const used = new Set(all.map((r) => r.alias));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 分配唯一 alias`);
}
```

### 测试 8 个

```ts
describe("discoverSubmodules", () => {
  // setup: in-memory DB + migrate004 + migrate006 + _setDbForTest
  //         tmpdir 父 repo + 写 .gitmodules + 子模块物理目录

  it("无 .gitmodules → added=0 existing=0", ...);
  it("发现并注册一个 GitHub 子模块", ...);
  it("第二次调用 → existing=1 added=0（幂等）", ...);
  it("非 GitHub url 跳过 + warning", ...);
  it("子模块路径不存在 → 跳过 + warning", ...);
  it("alias 冲突自动加后缀", ...);
  it("listSubmodules 返回某父的所有子", ...);
  it("拒绝在子模块上调 discoverSubmodules（嵌套）", ...);
});
```

### single-writer 白名单

读 `tests/single-writer-invariant.test.ts` 看现有结构（参考 P2 给 `src/core/requirements.ts` 加白名单的方式），加 `src/core/submodules.ts`（理由：SQLite 是权威源）。

commit: `feat(core): 加 submodules 模块（discoverSubmodules + listSubmodules）`

---

## Task 5：路由扩展

**Files:** Modify `src/daemon/routes.ts`

### 5.1 healthcheck 端点尾部追加 discover

读 `src/daemon/routes.ts` 找 `repoHealthMatch` 那块（约 676 行），现有逻辑：路径检查 → git rev-parse → origin 解析 → 自动回填 github_owner/repo。

在 `updateRepo(...)` 自动回填之后追加：

```ts
// 健康检查通过 + 回填后，扫描 .gitmodules 自动注册子模块（仅顶级 repo）
if (result.healthy && !repo.parent_repo_id) {
  try {
    const dr = discoverSubmodules(repo.id);
    return Response.json({
      healthy: true,
      issues: result.issues,
      submodules: {
        added: dr.added.map(r => ({ id: r.id, alias: r.alias, path: r.submodule_path })),
        existing: dr.existing.length,
        warnings: dr.warnings,
      },
    });
  } catch (e: unknown) {
    return Response.json({
      healthy: true,
      issues: result.issues,
      submodules: { error: (e as Error).message },
    });
  }
}
// 否则维持原响应（仅 healthy + issues，无 submodules 字段）
```

⚠️ 子模块自身的健康检查（用户对子模块行点检查）通过 `!repo.parent_repo_id` 判断跳过 discover（避免递归）。

### 5.2 新 rediscover 端点

```ts
const repoRediscoverMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)\/rediscover-submodules$/);
if (method === "POST" && repoRediscoverMatch) {
  const repo = getRepoById(repoRediscoverMatch);
  if (!repo) return error("repo not found", 404);
  if (repo.parent_repo_id) return error("子模块自身不能再发现子模块（不支持嵌套）");
  try {
    const r = discoverSubmodules(repoRediscoverMatch);
    return json({
      added: r.added.map(x => ({ id: x.id, alias: x.alias, submodule_path: x.submodule_path })),
      existing_count: r.existing.length,
      warnings: r.warnings,
    });
  } catch (e: unknown) {
    return error((e as Error).message);
  }
}
```

### 5.3 import 段加

```ts
import { discoverSubmodules } from "../core/submodules";
```

### 实机 e2e

```bash
bun run src/cli/index.ts daemon stop 2>/dev/null
sleep 1
bun run src/cli/index.ts daemon start
sleep 2

# 1. 注册 reverse-bot-gui
RR=$(curl -s -X POST http://127.0.0.1:6180/api/repos -H "Content-Type: application/json" \
  -d '{"alias":"rev-gui","path":"C:/Users/larry/Desktop/workspace/reverse-bot-gui","default_branch":"main"}')
PARENT_ID=$(echo "$RR" | grep -oE 'repo-[0-9]+' | head -1)

# 2. 健康检查触发 discover
curl -s -X POST "http://127.0.0.1:6180/api/repos/$PARENT_ID/healthcheck"
# 期待：{ healthy: true, submodules: { added: [{alias:"reverse-bot-rs",...}], existing: 0, warnings: [] } }

# 3. 列表（默认仅父）
curl -s http://127.0.0.1:6180/api/repos | grep -oE '"alias":"[^"]+"'
# 应只看到 rev-gui

# 4. rediscover（已存在 → existing_count=1, added=[]）
curl -s -X POST "http://127.0.0.1:6180/api/repos/$PARENT_ID/rediscover-submodules"

# 5. DELETE 父 → 子模块级联删
curl -s -X DELETE "http://127.0.0.1:6180/api/repos/$PARENT_ID"

bun run src/cli/index.ts daemon stop
```

commit: `feat(api): 健康检查自动发现子模块 + 新 /api/repos/:id/rediscover-submodules`

---

## Task 6：实机 e2e 验证（reverse-bot-gui）

**Files:** 无新文件（仅手动验证）

### 验收 4 项

1. ✅ 健康检查响应里 `submodules.added` 含 reverse-bot-rs
2. ✅ DB repos 表子模块行字段全对（`github_owner=ReverseGame`、`github_repo=reverse-bot-rs`、`default_branch=master`、`parent_repo_id` 指向父）
3. ✅ `GET /api/repos` 默认仅返回父
4. ✅ 删父后 DB 中子模块也消失（级联）

### 步骤详见 Task 5 e2e curl 流。

如果全过、无需改代码：跳过 commit；否则补 doc / fix commit。

---

## Self-Review 检查表

### Spec 覆盖率

| Spec 章节 | 覆盖 task |
|-----------|-----------|
| §3.1 repos 加 parent_repo_id / submodule_path | T1 + T3 |
| §3.2 requirement_sub_prs 表 | T1 |
| §4.1 健康检查扩展（自动注册子模块） | T2 + T4 + T5 |
| §4.1 子模块 default_branch 解析顺序 | T4（实现 .gitmodules branch → main，gh CLI 探测留给 follow-up） |
| §4.6 删除级联 | T3 |
| §8 Phase 5.1 sub-phase 范围 | 全部 task |

不在 P5.1 范围（按 §8 留给 P5.2-5.4）：req_dev workflow 改造 / 调度器组级 / Web UI 折叠展开 / chat tools 过滤 / 真实跑 reverse-bot-gui 需求。

### Placeholder 扫描

✅ 无 TBD / TODO（gh CLI 探测 default_branch 标注为「留给 follow-up」是有意识的设计取舍）

### 类型一致性

- `Repo` 接口 12 字段在 core/repos.ts 与未来 P5.2 useApi 一致
- `SubmoduleEntry` 接口 4 字段在 parser 与 discoverSubmodules 一致
- `DiscoverResult` 接口在 core 与 routes.ts 响应一致
- `parent_repo_id` / `submodule_path` 命名跨 migration / 接口 / 测试一致

---

## 后续 Sub-phase（P5.1 落地之后）

- **P5.2**：req_dev workflow 阶段函数改造（design / develop / code_review / submit_pr / fix_revision）
- **P5.3**：调度器组级锁 + Web UI 折叠展开 + chat tools 过滤子模块
- **P5.4**：测试 + 文档 + 用 reverse-bot-gui 真实跑闭环

每个 sub-phase 在前序落地后再写独立 plan。
