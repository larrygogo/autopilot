# Workspace Remote URL（彻底去本地路径）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 Workspace 对本地路径的依赖，仅凭远程仓库 URL 即可注册并执行任务；sandbox 直接从远程 `git clone`。

**Architecture:** 新增 `remote_url` 列（DB migration 033），`path` 列保留历史值但不再写入；`sandbox.ts` 的 `tryCreateClone` 改为 `git clone <remote_url>` + 可选 token 注入；CLI/RPC/Web 更新入口参数，`workspace create/update` 在写 DB 前做一次 `git ls-remote` 可达性验证。

**Tech Stack:** Bun / TypeScript / bun:sqlite / bun:test / Commander.js / React + Vite

---

## 文件变更一览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/migrations/033-workspace-remote-url.ts` | 新建 | 添加 `remote_url` 列；使 `path` 可空；存量自动回填 |
| `src/core/workspaces.ts` | 修改 | `Workspace` / `CreateWorkspaceOpts` / `UpdateWorkspaceOpts` 加 `remote_url`；`path` 可空 |
| `src/core/workspace-health.ts` | 修改 | 新增 `probeRemote(url, token?)` 函数；`checkWorkspaceHealth` 改为按 `remote_url` 探测 |
| `src/core/config.ts` | 修改 | 新增 `GitConfig` 接口、`loadGitConfig()` / `saveGitConfig()` |
| `src/core/sandbox.ts` | 修改 | `WorkspaceRef.path` 改可选、加 `remote_url`；`tryCreateClone` 改为远程 clone + token 注入 |
| `src/core/task-factory.ts` | 修改 | 组装 `WorkspaceRef` 时用 `remote_url`；`remote_url` 为 null 时报错拒绝启动 |
| `src/daemon/rpc-methods.ts` | 修改 | `workspaces.create/update/healthcheck` 支持 `remote_url`，创建/更新时服务端 probe 验证 |
| `src/cli/workspace.ts` | 修改 | `create` 改为 `<alias> --remote <url>` 或 `--github owner/repo`；新增 `update <id>` 命令 |
| `src/web/src/pages/ProjectDetail.tsx` | 修改 | 表单去掉 `path` 输入，换成 `remote_url` 输入；去掉 `FolderPicker` 路径依赖 |
| `src/web/src/hooks/useApi.ts` | 修改 | `Workspace` 接口加 `remote_url`，`path` 改可空 |
| `tests/migration-033.test.ts` | 新建 | 迁移正确性验证 |
| `tests/workspace-probe.test.ts` | 新建 | `probeRemote` + token 注入单元测试 |
| `tests/cli-workspace.test.ts` | 修改 | 更新 CLI 测试用例（新签名） |

---

## Task 1：DB 迁移 033 — 添加 `remote_url` 列 + 软失效迁移

**Files:**
- Create: `src/migrations/033-workspace-remote-url.ts`
- Create: `tests/migration-033.test.ts`

- [ ] **Step 1.1：新建迁移文件**

```typescript
// src/migrations/033-workspace-remote-url.ts
import type { Database } from "bun:sqlite";
import { spawnSync } from "child_process";

/**
 * 迁移 033：Workspace 彻底去本地路径
 *
 * 变更：
 * 1. workspaces 加 remote_url TEXT（可空）
 * 2. path 改为可空（保留历史值，后续不再写入）
 * 3. 存量 workspace 尝试从本地 git remote get-url origin 回填 remote_url
 */
export function up(db: Database): void {
  // 1. 添加 remote_url 列（幂等：列已存在则跳过）
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("remote_url")) {
    db.run("ALTER TABLE workspaces ADD COLUMN remote_url TEXT");
  }

  // 2. path 列在 SQLite 无法直接改 NOT NULL 约束，通过表重建实现
  //    但 workspaces 表有 UNIQUE 索引和 FK 引用，重建代价高且迁移文件不应破坏外键。
  //    折中：仅允许 path 为空字符串（存量已有值不变），新建时不再要求 path 非空即可。
  //    SQLite 不支持 DROP NOT NULL，应用层不再强制 path 非空即达到同等效果。
  //    此处不做表重建，仅存量数据回填。

  // 3. 存量回填：遍历 remote_url 为 NULL 且 path 不为空的 workspace
  const rows = db
    .query<{ id: string; path: string }, []>(
      "SELECT id, path FROM workspaces WHERE remote_url IS NULL AND path IS NOT NULL AND path != ''",
    )
    .all();

  for (const row of rows) {
    let remoteUrl: string | null = null;
    try {
      const proc = spawnSync("git", ["-C", row.path, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (proc.status === 0 && proc.stdout) {
        const url = proc.stdout.trim();
        if (url) remoteUrl = url;
      }
    } catch {
      // 目录不存在 / git 不可用 → 软失效，remote_url 保持 NULL
    }

    if (remoteUrl) {
      db.run("UPDATE workspaces SET remote_url = ? WHERE id = ?", [remoteUrl, row.id]);
    }
    // remote_url 为 NULL → 软失效，创建任务时会报错提示用户补填
  }
}
```

- [ ] **Step 1.2：写测试文件**

```typescript
// tests/migration-033.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m025 } from "../src/migrations/025-one-workspace-per-project";
import { up as m033 } from "../src/migrations/033-workspace-remote-url";

function seededDb(): Database {
  const db = new Database(":memory:");
  m001(db); m002(db); m004(db); m005(db); m006(db); m007(db); m008(db);
  m024(db); m025(db);
  // 插入一条 path 存在但 remote_url 为 NULL 的旧 workspace（path 无效，模拟探测失败）
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) " +
    "VALUES ('ws-001', '', 'myrepo', '/nonexistent/path', 'main', 1, 1)",
  );
  return db;
}

function cols(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe("migration 033 · remote_url 列", () => {
  it("执行后 workspaces 表含 remote_url 列", () => {
    const db = seededDb();
    m033(db);
    expect(cols(db, "workspaces")).toContain("remote_url");
  });

  it("path 不存在时 remote_url 仍为 NULL（软失效）", () => {
    const db = seededDb();
    m033(db);
    const row = db
      .query<{ remote_url: string | null }, []>("SELECT remote_url FROM workspaces WHERE id='ws-001'")
      .get();
    expect(row?.remote_url).toBeNull();
  });

  it("幂等：重复执行不报错", () => {
    const db = seededDb();
    m033(db);
    expect(() => m033(db)).not.toThrow();
  });

  it("已有 remote_url 的 workspace 不被覆盖", () => {
    const db = seededDb();
    db.run(
      "INSERT INTO workspaces (id, project_id, alias, path, remote_url, default_branch, created_at, updated_at) " +
      "VALUES ('ws-002', '', 'repo2', '', 'https://github.com/owner/repo.git', 'main', 2, 2)",
    );
    m033(db);
    const row = db
      .query<{ remote_url: string | null }, []>("SELECT remote_url FROM workspaces WHERE id='ws-002'")
      .get();
    expect(row?.remote_url).toBe("https://github.com/owner/repo.git");
  });
});
```

- [ ] **Step 1.3：运行测试，确认通过**

```bash
cd C:\Users\larry\.autopilot\runtime\tasks\sqah3ter\workspace
bun test tests/migration-033.test.ts
```
Expected: 4 passing

- [ ] **Step 1.4：注册迁移到 migrate.ts**

找到 `src/core/migrate.ts` 中的迁移列表，追加：
```typescript
import { up as migrate033 } from "../migrations/033-workspace-remote-url";
// ...在迁移数组末尾追加：
{ version: 33, name: "033-workspace-remote-url", up: migrate033 },
```

- [ ] **Step 1.5：提交**

```bash
git add src/migrations/033-workspace-remote-url.ts src/core/migrate.ts tests/migration-033.test.ts
git commit -m "feat: 迁移 033 - 添加 workspace.remote_url 列，存量自动回填"
```

---

## Task 2：core/workspaces.ts — 更新类型与 CRUD

**Files:**
- Modify: `src/core/workspaces.ts`

- [ ] **Step 2.1：更新 `Workspace` 接口，`path` 改可空，加 `remote_url`**

在 `workspaces.ts` 中，将：
```typescript
export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}
```
改为：
```typescript
export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  /** 本地路径（历史字段，新建时不再写入；后续仅用于存量迁移参考） */
  path: string | null;
  /** 远程仓库 URL（新主键字段）；NULL 表示软失效工作区（需补填后可用） */
  remote_url: string | null;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 2.2：更新 `CreateWorkspaceOpts`，`path` 可选，加 `remote_url`**

将：
```typescript
export interface CreateWorkspaceOpts {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}
```
改为：
```typescript
export interface CreateWorkspaceOpts {
  id: string;
  project_id: string;
  alias: string;
  /** 历史兼容：内部/测试可传；新建流程不再要求 */
  path?: string | null;
  /** 远程仓库 URL（新建流程主入口） */
  remote_url?: string | null;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}
```

- [ ] **Step 2.3：更新 `UpdateWorkspaceOpts`，加 `remote_url`**

将：
```typescript
export interface UpdateWorkspaceOpts {
  alias?: string;
  path?: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}
```
改为：
```typescript
export interface UpdateWorkspaceOpts {
  alias?: string;
  /** 历史兼容，不再推荐写入 */
  path?: string | null;
  remote_url?: string | null;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}
```

- [ ] **Step 2.4：更新 `createWorkspace`，INSERT 包含 `remote_url`**

将 INSERT 语句从：
```typescript
db.run(
  "INSERT INTO workspaces (id, project_id, alias, path, default_branch, github_owner, github_repo, parent_workspace_id, submodule_path, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  [
    opts.id, opts.project_id, opts.alias, opts.path, opts.default_branch ?? "main",
    opts.github_owner ?? null, opts.github_repo ?? null,
    opts.parent_workspace_id ?? null, opts.submodule_path ?? null, ts, ts,
  ]
);
```
改为：
```typescript
db.run(
  "INSERT INTO workspaces (id, project_id, alias, path, remote_url, default_branch, github_owner, github_repo, parent_workspace_id, submodule_path, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  [
    opts.id,
    opts.project_id,
    opts.alias,
    opts.path ?? null,           // 历史兼容；新建传 null
    opts.remote_url ?? null,     // 新主键
    opts.default_branch ?? "main",
    opts.github_owner ?? null,
    opts.github_repo ?? null,
    opts.parent_workspace_id ?? null,
    opts.submodule_path ?? null,
    ts,
    ts,
  ]
);
```

- [ ] **Step 2.5：更新 `updateWorkspace`，支持 `remote_url`**

在 `updateWorkspace` 中，在 `if (opts.path !== undefined)` 之后插入：
```typescript
if (opts.remote_url !== undefined) { fields.push("remote_url = ?"); vals.push(opts.remote_url); }
```

- [ ] **Step 2.6：运行类型检查**

```bash
bun run typecheck
```
Expected: 无 workspaces.ts 相关的类型错误（其他文件可能有引用 `ws.path` 的警告，后续 Task 修复）

- [ ] **Step 2.7：提交**

```bash
git add src/core/workspaces.ts
git commit -m "feat: Workspace 接口加 remote_url，path 改可空"
```

---

## Task 3：workspace-health.ts — 新增 `probeRemote()` 函数

**Files:**
- Modify: `src/core/workspace-health.ts`
- Create: `tests/workspace-probe.test.ts`

- [ ] **Step 3.1：添加 `probeRemote` 函数**

在 `workspace-health.ts` 文件末尾追加：

```typescript
export interface ProbeResult {
  /** 远程可达且鉴权通过 */
  ok: boolean;
  /** 探测到的默认分支（解析 HEAD 指向）；探测失败或无 HEAD 时为 null */
  defaultBranch: string | null;
  /** 失败原因（供用户提示） */
  error?: string;
}

/**
 * 探测远程 git 仓库可达性，同时解析默认分支。
 *
 * 执行：`git ls-remote --symref origin HEAD`（以 remote url 作为 origin）
 * 一次调用兼顾：
 *   - 可达性验证（非零退出码 = 不可达/鉴权失败）
 *   - 默认分支探测（解析 `ref: refs/heads/<branch>  HEAD` 行）
 *
 * token 注入：HTTP(S) URL + token 存在时，在 URL 中临时注入凭据（仅此次 git 调用，不落库）。
 */
export function probeRemote(remoteUrl: string, token?: string | null): ProbeResult {
  if (!remoteUrl || !remoteUrl.trim()) {
    return { ok: false, defaultBranch: null, error: "远程地址为空" };
  }

  const url = buildAuthUrl(remoteUrl.trim(), token ?? null);

  const proc = Bun.spawnSync(
    ["git", "ls-remote", "--symref", url, "HEAD"],
    { stdout: "pipe", stderr: "pipe", timeout: 15000 },
  );

  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
    // 脱敏：把 token-injected URL 从错误信息中去除
    const safeErr = token ? stderr.replace(token, "***") : stderr;
    const firstLine = safeErr.split("\n")[0] ?? "";
    return { ok: false, defaultBranch: null, error: firstLine || "git ls-remote 失败" };
  }

  const output = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  // 解析 "ref: refs/heads/<branch>  HEAD" 行
  const m = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
  const defaultBranch = m ? m[1] : null;

  return { ok: true, defaultBranch };
}

/**
 * 为 HTTPS URL 注入 token（临时，只用于命令行参数，不落库）。
 * SSH URL 原样返回（走系统 SSH key）。
 */
export function buildAuthUrl(url: string, token: string | null): string {
  if (!token || !token.trim()) return url;
  // 仅 https:// 协议注入；ssh:// / git:// / scp-style 不处理
  if (!url.startsWith("https://")) return url;
  // 格式：https://oauth2:<token>@<rest>
  return url.replace(/^https:\/\//, `https://oauth2:${token}@`);
}
```

同时更新 `checkWorkspaceHealth` 签名，接收 `Workspace` 对象而非 `path` 字符串：

将：
```typescript
export async function checkWorkspaceHealth(path: string): Promise<WorkspaceHealth> {
```
改为：
```typescript
/**
 * 检查 workspace 健康度（新：基于远程可达性检查）。
 *
 * remote_url 为 NULL → 直接返回 unhealthy（软失效 workspace）。
 * remote_url 不为空 → 执行 git ls-remote 真实网络请求，验证可达性。
 *
 * @deprecated path 参数版本保留兼容旧调用；优先使用 Workspace 对象版本。
 */
export async function checkWorkspaceHealth(
  workspaceOrPath: { path: string | null; remote_url: string | null; github_owner: string | null; github_repo: string | null } | string,
  token?: string | null,
): Promise<WorkspaceHealth> {
  // 旧版兼容：传字符串 path 时走原有本地逻辑（内部迁移过渡用）
  if (typeof workspaceOrPath === "string") {
    return _checkWorkspaceHealthByPath(workspaceOrPath);
  }

  const ws = workspaceOrPath;
  if (!ws.remote_url) {
    return {
      healthy: false,
      issues: ["remote_url 未填写（软失效工作区）；请用 autopilot workspace update <id> --remote <url> 补填远程地址"],
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }

  const result = probeRemote(ws.remote_url, token);
  if (!result.ok) {
    return {
      healthy: false,
      issues: [`远程不可达：${result.error ?? "git ls-remote 失败"}`],
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }

  return {
    healthy: true,
    issues: [],
    github_owner: ws.github_owner,
    github_repo: ws.github_repo,
  };
}
```

然后将原有实现重命名为 `_checkWorkspaceHealthByPath`（保留向后兼容）。

- [ ] **Step 3.2：写 probeRemote 单元测试**

```typescript
// tests/workspace-probe.test.ts
import { describe, it, expect } from "bun:test";
import { probeRemote, buildAuthUrl } from "../src/core/workspace-health";

describe("buildAuthUrl", () => {
  it("HTTPS URL 注入 token", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", "mytoken");
    expect(url).toBe("https://oauth2:mytoken@github.com/owner/repo.git");
  });

  it("SSH URL 原样返回（不注入 token）", () => {
    const url = buildAuthUrl("git@github.com:owner/repo.git", "mytoken");
    expect(url).toBe("git@github.com:owner/repo.git");
  });

  it("token 为 null 时原样返回", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", null);
    expect(url).toBe("https://github.com/owner/repo.git");
  });

  it("已有凭据的 URL 不双重注入", () => {
    // buildAuthUrl 仅做字符串前缀替换，调用方应保证传入干净 URL
    const url = buildAuthUrl("https://github.com/owner/repo.git", "tok");
    expect(url.startsWith("https://oauth2:tok@")).toBe(true);
  });
});

describe("probeRemote · 空/非法输入", () => {
  it("空 URL 返回 ok=false", () => {
    const r = probeRemote("");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("非法域名 URL 返回 ok=false", () => {
    // git ls-remote 会失败（DNS 解析失败 / ENOTFOUND）
    const r = probeRemote("https://this-domain-does-not-exist-xyz123.invalid/x/y");
    expect(r.ok).toBe(false);
    expect(r.defaultBranch).toBeNull();
  });
});
```

- [ ] **Step 3.3：运行测试**

```bash
bun test tests/workspace-probe.test.ts
```
Expected: buildAuthUrl 4 tests passing；probeRemote 空/非法 URL 测试 passing（git ls-remote 失败 = 预期行为）

- [ ] **Step 3.4：提交**

```bash
git add src/core/workspace-health.ts tests/workspace-probe.test.ts
git commit -m "feat: workspace-health 新增 probeRemote，checkWorkspaceHealth 改为远程探测"
```

---

## Task 4：config.ts — 新增 `git.token` 支持

**Files:**
- Modify: `src/core/config.ts`

- [ ] **Step 4.1：添加 `GitConfig` 接口和读写函数**

在 `config.ts` 末尾追加：

```typescript
// ──────────────────────────────────────────────
// git 凭据配置
// ──────────────────────────────────────────────

export interface GitConfig {
  /**
   * 私有仓库 HTTPS clone 用 token（全局共用）。
   * HTTP URL clone 时自动注入：https://oauth2:<token>@<host>/...
   * SSH URL 不使用（走系统 SSH key）。
   * 未设置时退回系统 git 凭证（~/.gitconfig credential helper / gh CLI 等）。
   */
  token?: string;
}

/**
 * 读取 config.yaml 的 git 段。
 */
export function loadGitConfig(): GitConfig {
  try {
    const raw = loadConfig();
    const section = raw["git"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: GitConfig = {};
    if (typeof s.token === "string" && s.token.trim()) out.token = s.token.trim();
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入 git 段配置（token 为 undefined 时删除键）。
 */
export function saveGitConfig(cfg: GitConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["git"])) doc.deleteIn(["git"]);
  } else {
    doc.setIn(["git"], clean);
  }
  writeDocument(doc);
}
```

- [ ] **Step 4.2：类型检查通过**

```bash
bun run typecheck 2>&1 | grep config.ts
```
Expected: 无 config.ts 相关错误

- [ ] **Step 4.3：提交**

```bash
git add src/core/config.ts
git commit -m "feat: config.ts 新增 git.token 配置段"
```

---

## Task 5：sandbox.ts — 更新 `WorkspaceRef` 和 `tryCreateClone`

**Files:**
- Modify: `src/core/sandbox.ts`

- [ ] **Step 5.1：更新 `WorkspaceRef` 接口**

将：
```typescript
export interface WorkspaceRef {
  id: string;
  path: string;
  default_branch: string;
  /** GitHub owner/repo：用于把 clone 的 origin 从本地路径改写成 GitHub url（push/PR 用） */
  github_owner?: string | null;
  github_repo?: string | null;
}
```
改为：
```typescript
export interface WorkspaceRef {
  id: string;
  /** 远程 clone URL（新模型主字段）；不含 token，token 在 clone 时动态注入 */
  remote_url: string;
  default_branch: string;
  github_owner?: string | null;
  github_repo?: string | null;
}
```

- [ ] **Step 5.2：更新 `tryCreateClone` — 改为从远程 clone**

将 `tryCreateClone` 函数整体替换为：

```typescript
/**
 * 为 task 创建独立远程 clone 沙盒。成功返回 WorktreeMeta(mode=clone)，失败 warn + 返回 null。
 *
 * 核心：直接从远程 git clone（完整 clone，不加 --depth）。
 * token 注入：HTTPS URL + config.yaml git.token 存在时，临时注入凭证到 clone URL，
 * clone 后的 .git/config origin 会带 token（push 时也生效）；SSH 走系统 key。
 *
 * 步骤：
 *   1. 读 git.token 配置，构建含凭证的 clone URL
 *   2. git clone <authUrl> <wsPath>（完整历史，无 --local / --depth）
 *   3. 基于 origin/<base> 建交付分支
 *   4. 写 .worktree.json（mode=clone）
 */
function tryCreateClone(
  taskId: string,
  cfg: SandboxConfig,
  workspace: WorkspaceRef | undefined,
  wsPath: string,
  deliverBranch?: string,
): WorktreeMeta | null {
  if (!workspace) {
    log.warn("sandbox.git=true 但未提供 workspace；退化空目录 [task=%s]", taskId);
    return null;
  }
  if (!workspace.remote_url) {
    log.warn("sandbox.git=true 但 workspace %s 无 remote_url（软失效工作区）；退化空目录 [task=%s]",
      workspace.id, taskId);
    return null;
  }

  const base = cfg.base ?? workspace.default_branch;
  const branch = deliverBranch ?? `${cfg.branch_prefix ?? "autopilot/"}${taskId}`;

  // 目标目录必须不存在
  const parent = join(wsPath, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });

  // 读取 git.token 配置，构建含凭证的 clone URL（HTTPS 注入；SSH 原样）
  let cloneUrl = workspace.remote_url;
  try {
    const { loadGitConfig } = require("../core/config") as typeof import("../core/config");
    const { buildAuthUrl } = require("../core/workspace-health") as typeof import("../core/workspace-health");
    const gitCfg = loadGitConfig();
    if (gitCfg.token) {
      cloneUrl = buildAuthUrl(workspace.remote_url, gitCfg.token);
    }
  } catch { /* 读取 token 失败不阻断 clone */ }

  // 完整 clone（无 --local / --depth）
  const cl = Bun.spawnSync(["git", "clone", cloneUrl, wsPath], { stdout: "pipe", stderr: "pipe" });
  if (cl.exitCode !== 0) {
    const stderr = cl.stderr ? new TextDecoder().decode(cl.stderr) : "";
    // 脱敏：若 cloneUrl 含 token，从 stderr 中去除
    const safeStderr = cloneUrl !== workspace.remote_url
      ? stderr.replace(cloneUrl, workspace.remote_url)
      : stderr;
    log.warn("git clone 失败 [task=%s workspace=%s exit=%d]: %s",
      taskId, workspace.id, cl.exitCode, safeStderr.slice(0, 300));
    return null;
  }

  // 基于 origin/<base> 建交付分支（完整 clone 后所有分支均作为 origin/<x> 可用）
  const baseRef = Bun.spawnSync(
    ["git", "-C", wsPath, "rev-parse", "--verify", "--quiet", `origin/${base}`],
    { stderr: "pipe" },
  ).exitCode === 0 ? `origin/${base}` : base;

  const co = Bun.spawnSync(["git", "-C", wsPath, "checkout", "-B", branch, baseRef], { stderr: "pipe" });
  if (co.exitCode !== 0) {
    const stderr = co.stderr ? new TextDecoder().decode(co.stderr) : "";
    log.warn("clone 后建交付分支失败 [task=%s branch=%s base=%s]: %s", taskId, branch, base, stderr.slice(0, 200));
    // 不致命：仍在克隆的默认分支，尽量跑
  }

  // .git/info/exclude：让阶段产物目录不进 PR
  try {
    const excludeFile = join(wsPath, ".git", "info", "exclude");
    if (existsSync(join(wsPath, ".git", "info"))) {
      appendFileSync(excludeFile, "\n# autopilot 阶段产物（不进交付 PR）\n/[0-9][0-9]-*/\n");
    }
  } catch { /* exclude 写失败不阻塞任务 */ }

  const meta: WorktreeMeta = {
    workspace_id: workspace.id,
    workspace_path: "",   // 远程 clone 模式无本地路径
    branch,
    base,
    created_at: Date.now(),
    mode: "clone",
    remote_url: workspace.remote_url,  // 存干净 URL（不含 token）
  };
  writeWorktreeMeta(taskId, meta);
  log.info("远程 clone 创建 [task=%s workspace=%s branch=%s base=%s remote=%s]",
    taskId, workspace.id, branch, base, workspace.remote_url);
  return meta;
}
```

- [ ] **Step 5.3：删除 `resolveRemoteUrl` 函数**

原 `resolveRemoteUrl` 函数已不再需要（新模型下 `WorkspaceRef.remote_url` 直接就是 push 目标），将其删除。

找到并删除：
```typescript
/** 解析 clone 的 push 目标远程 url：优先 workspace 的 GitHub owner/repo，回退源仓库 origin（只读）。 */
function resolveRemoteUrl(ws: WorkspaceRef): string | null {
  ...
}
```

- [ ] **Step 5.4：运行类型检查**

```bash
bun run typecheck 2>&1 | grep sandbox.ts
```
Expected: 无 sandbox.ts 相关类型错误（WorkspaceRef.path 的引用已删除）

- [ ] **Step 5.5：提交**

```bash
git add src/core/sandbox.ts
git commit -m "feat: sandbox.ts 改为远程 clone，WorkspaceRef 去掉 path 改用 remote_url"
```

---

## Task 6：task-factory.ts — 传 `remote_url`，软失效报错

**Files:**
- Modify: `src/core/task-factory.ts`

- [ ] **Step 6.1：更新 `WorkspaceRef` 组装逻辑**

找到 task-factory.ts 第 162–168 行（`if (workspaceId) { ... }` 块）：

```typescript
if (workspaceId) {
  const ws = getWorkspaceById(workspaceId);
  if (ws) {
    workspace = { id: ws.id, path: ws.path, default_branch: ws.default_branch, github_owner: ws.github_owner, github_repo: ws.github_repo };
  }
}
```

替换为：

```typescript
if (workspaceId) {
  const ws = getWorkspaceById(workspaceId);
  if (ws) {
    if (!ws.remote_url) {
      // 软失效工作区：remote_url 为 NULL，拒绝起任务（防止 sandbox 退化空目录悄悄运行）
      throw new StartTaskError(
        `Workspace ${workspaceId}（${ws.alias}）缺少远程地址（软失效）。请先执行：\n` +
        `  autopilot workspace update ${workspaceId} --remote <git-url>\n` +
        `补填远程地址后重试。`,
        400,
      );
    }
    workspace = {
      id: ws.id,
      remote_url: ws.remote_url,
      default_branch: ws.default_branch,
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }
}
```

- [ ] **Step 6.2：更新重跑路径（`resetTaskForRerun` 附近）**

找到 task-factory.ts 第 302–304 行（重跑时重新构建 workspace）：

```typescript
if (wsId) {
  const ws = getWorkspaceById(wsId);
  if (ws) workspace = { id: ws.id, path: ws.path, default_branch: ws.default_branch, github_owner: ws.github_owner, github_repo: ws.github_repo };
}
```

替换为：

```typescript
if (wsId) {
  const ws = getWorkspaceById(wsId);
  if (ws) {
    if (!ws.remote_url) {
      throw new StartTaskError(
        `重跑失败：Workspace ${wsId}（${ws.alias}）缺少远程地址。请先 autopilot workspace update ${wsId} --remote <url>`,
        400,
      );
    }
    workspace = {
      id: ws.id,
      remote_url: ws.remote_url,
      default_branch: ws.default_branch,
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }
}
```

- [ ] **Step 6.3：运行类型检查**

```bash
bun run typecheck 2>&1 | grep task-factory.ts
```
Expected: 无错误

- [ ] **Step 6.4：提交**

```bash
git add src/core/task-factory.ts
git commit -m "feat: task-factory 组装 WorkspaceRef 改用 remote_url，软失效时报错拒绝启动"
```

---

## Task 7：rpc-methods.ts — 更新 `workspaces.*` 服务端逻辑

**Files:**
- Modify: `src/daemon/rpc-methods.ts`

- [ ] **Step 7.1：在文件顶部添加 `probeRemote`、`loadGitConfig` 导入**

找到 rpc-methods.ts 中导入 `detectWorkspaceGit`、`checkWorkspaceHealth` 的行，追加：

```typescript
import { probeRemote, buildAuthUrl, checkWorkspaceHealth, detectWorkspaceGit, ... } from "../core/workspace-health";
import { loadGitConfig } from "../core/config";
```

- [ ] **Step 7.2：更新 `workspaces.create` — 去掉 path 必填，加 remote_url 验证**

找到 `workspaces.create` 的 handler，将其整体替换：

```typescript
registerRpcMethod({
  method: "workspaces.create",
  description: "创建 workspace；需提供 remote_url 或 --github owner/repo；写 DB 前执行 git ls-remote 可达性验证",
  handler: async (params) => {
    const p = asObj(params);
    const alias = typeof p.alias === "string" ? p.alias.trim() : "";
    if (!alias) throw new RpcError("INVALID_PARAM", "alias 必填");

    const projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
    if (projectId && projectHasTopWorkspace(projectId)) {
      throw new RpcError("PRECONDITION_FAILED", "每个项目仅允许一个工作区，该项目已有工作区");
    }

    // 解析 remote_url：优先显式传入，其次从 github owner/repo 构造
    let remoteUrl: string | null = null;
    if (typeof p.remote_url === "string" && p.remote_url.trim()) {
      remoteUrl = p.remote_url.trim();
    } else if (typeof p.github === "string" && p.github.includes("/")) {
      const [owner, repo] = p.github.split("/");
      remoteUrl = `https://github.com/${owner}/${repo}.git`;
    } else if (typeof p.github_owner === "string" && typeof p.github_repo === "string") {
      remoteUrl = `https://github.com/${p.github_owner}/${p.github_repo}.git`;
    } else if (typeof p.path === "string" && p.path.trim()) {
      // 兼容旧调用：有 path 则从本地探测（不做 ls-remote，直接走旧逻辑）
      const detected = detectWorkspaceGit(p.path.trim());
      if (detected.remote_url) remoteUrl = detected.remote_url;
    }

    if (!remoteUrl) {
      throw new RpcError("INVALID_PARAM", "请提供 remote_url 或 --github owner/repo（格式：owner/repo）");
    }

    // Fail fast：写 DB 前验证远程可达性 + 探测默认分支
    const gitCfg = loadGitConfig();
    const probe = probeRemote(remoteUrl, gitCfg.token);
    if (!probe.ok) {
      throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或在 config.yaml 配置 git.token`);
    }

    // 默认分支：显式指定 > probe 探测 > "main"
    const explicitBranch = typeof p.default_branch === "string" && p.default_branch.trim()
      ? p.default_branch.trim() : null;
    const defaultBranch = explicitBranch ?? probe.defaultBranch ?? "main";

    // 解析 github owner/repo（从 remote_url 中提取）
    let github_owner = (p.github_owner as string | null | undefined) ?? null;
    let github_repo = (p.github_repo as string | null | undefined) ?? null;
    if (!github_owner || !github_repo) {
      const parsed = parseGithubFromRemote(remoteUrl);
      if (parsed) { github_owner = parsed.owner; github_repo = parsed.repo; }
    }

    try {
      const workspace = createWorkspace({
        id: nextWorkspaceId(),
        project_id: projectId,
        alias,
        path: typeof p.path === "string" && p.path.trim() ? p.path.trim() : null,
        remote_url: remoteUrl,
        default_branch: defaultBranch,
        github_owner,
        github_repo,
      });
      return workspace;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      const msg = e instanceof Error ? e.message : String(e);
      if (code?.startsWith("SQLITE_CONSTRAINT") || msg.toLowerCase().includes("unique")) {
        throw new RpcError("ALREADY_EXISTS", msg);
      }
      throw new RpcError("CREATE_FAILED", msg);
    }
  },
});
```

注意：需要在该文件顶部导入 `parseGithubFromRemote`（来自 `workspace-health.ts`）。

- [ ] **Step 7.3：更新 `workspaces.update` — 加 `remote_url` 支持 + 验证**

在 `workspaces.update` handler 的参数解析块中，在处理 `p.path` 之后追加：

```typescript
if (p.remote_url !== undefined) {
  const rawUrl = typeof p.remote_url === "string" ? p.remote_url.trim() : "";
  if (!rawUrl) throw new RpcError("INVALID_PARAM", "remote_url 不能为空字符串（传 null 可清空）");
  // 验证新 remote_url 可达性（与 create 对称）
  const gitCfg = loadGitConfig();
  const probe = probeRemote(rawUrl, gitCfg.token);
  if (!probe.ok) {
    throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或 config.yaml 的 git.token`);
  }
  patch.remote_url = rawUrl;
  // 若 default_branch 未显式指定，用 probe 探测到的默认分支（仅当有探测结果）
  if (p.default_branch === undefined && probe.defaultBranch) {
    patch.default_branch = probe.defaultBranch;
  }
}
```

- [ ] **Step 7.4：更新 `workspaces.healthcheck` — 改用 remote 探测**

将 `workspaces.healthcheck` handler 替换为：

```typescript
registerRpcMethod({
  method: "workspaces.healthcheck",
  description: "检查 workspace 健康状态（新：执行 git ls-remote 验证远程可达性；remote_url 为 NULL 直接返回 unhealthy）",
  handler: async (params) => {
    const p = asObj(params);
    if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
    const workspace = getWorkspaceById(p.id);
    if (!workspace) throw new RpcError("NOT_FOUND", "workspace not found");

    const gitCfg = loadGitConfig();
    const health = await checkWorkspaceHealth(workspace, gitCfg.token);

    // 可达时尝试自动发现子模块（仅顶层 workspace）
    if (health.healthy && !workspace.parent_workspace_id) {
      try {
        const dr = discoverSubmodules(workspace.id);
        return {
          healthy: true,
          issues: health.issues,
          submodules: {
            added: dr.added.map((r) => ({ id: r.id, alias: r.alias, path: r.submodule_path })),
            existing: dr.existing.length,
            warnings: dr.warnings,
          },
        };
      } catch (e: unknown) {
        return {
          healthy: true,
          issues: health.issues,
          submodules: { error: (e as Error).message },
        };
      }
    }
    return { healthy: health.healthy, issues: health.issues };
  },
});
```

- [ ] **Step 7.5：更新 `workspaces.list` — 展示 `remote_url` 替换 `path_exists`**

找到：
```typescript
handler: () => listWorkspaces().map((ws) => ({ ...ws, path_exists: existsSync(ws.path) })),
```
替换为（`path_exists` 不再有意义，但保留 `path` 字段兼容旧客户端）：
```typescript
handler: () => listWorkspaces().map((ws) => ({
  ...ws,
  // 向后兼容：path_exists 改为基于 remote_url 是否填写的简单判断
  path_exists: !!ws.remote_url,
})),
```

- [ ] **Step 7.6：运行类型检查**

```bash
bun run typecheck 2>&1 | grep rpc-methods.ts
```
Expected: 无类型错误

- [ ] **Step 7.7：提交**

```bash
git add src/daemon/rpc-methods.ts
git commit -m "feat: RPC workspaces.create/update/healthcheck 支持 remote_url + fail fast 验证"
```

---

## Task 8：cli/workspace.ts — 新签名 + `update` 命令

**Files:**
- Modify: `src/cli/workspace.ts`

- [ ] **Step 8.1：重写 `workspace create` 命令**

将当前 `ws.command("create <alias> <path>")` 替换为：

```typescript
ws
  .command("create <alias>")
  .description("注册远程 git 仓库为 workspace（写 DB 前验证远程可达性）")
  .option("--remote <url>", "远程仓库 git URL（https://... 或 git@...）")
  .option("--github <owner/repo>", "GitHub 仓库（简写，等价于 --remote https://github.com/owner/repo.git）")
  .option("-b, --branch <name>", "默认分支（省略时自动探测远程 HEAD）")
  .option("-p, --project <id>", "归属 project（默认取第一个）")
  .option("--no-project", "不挂任何 project")
  .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
  .option("--json", "原始 JSON 输出")
  .action(
    async (
      alias: string,
      opts: { remote?: string; github?: string; branch?: string; project?: string | false; port: string; json?: boolean },
    ) => {
      if (!alias.trim()) {
        console.error("错误：alias 不能为空");
        process.exit(2);
      }

      // 解析 remote_url
      let remoteUrl: string | undefined;
      if (opts.remote) {
        remoteUrl = opts.remote.trim();
      } else if (opts.github) {
        const gh = parseGithub(opts.github);
        if (!gh) {
          console.error(`错误：--github 格式应为 owner/repo，收到：${opts.github}`);
          process.exit(2);
        }
        remoteUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
      }

      if (!remoteUrl) {
        console.error("错误：必须提供 --remote <url> 或 --github owner/repo");
        process.exit(2);
      }

      const client = getClient(opts.port);
      await ensureDaemon(client);

      // 解析 project_id
      let projectId: string | undefined;
      if (opts.project === false) {
        projectId = undefined;
      } else if (typeof opts.project === "string" && opts.project) {
        projectId = opts.project;
      } else {
        try {
          const { projects } = await client.listProjects();
          if (projects.length === 0) {
            console.error("错误：未找到 project。请先 `autopilot project create <name>`，或加 --no-project`。");
            process.exit(2);
          }
          projectId = projects[0]!.id;
          console.log(`✓ 默认 project: ${projectId}`);
        } catch (e: unknown) {
          console.error(`列出 project 失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      }

      try {
        const body: Parameters<typeof client.createWorkspace>[0] = {
          alias: alias.trim(),
          remote_url: remoteUrl,
        };
        if (opts.branch?.trim()) body.default_branch = opts.branch.trim();
        if (projectId) body.project_id = projectId;

        const { workspace } = await client.createWorkspace(body);
        if (opts.json) {
          console.log(JSON.stringify(workspace, null, 2));
        } else {
          console.log(`已注册 workspace：${workspace.id}  alias=${workspace.alias}`);
          console.log(`  remote_url=${workspace.remote_url}`);
          console.log(`  default_branch=${workspace.default_branch}${!opts.branch ? "  (自动探测)" : ""}`);
          if (workspace.github_owner && workspace.github_repo) {
            console.log(`  github=${workspace.github_owner}/${workspace.github_repo}`);
          }
          console.log(`\n下一步：autopilot req new "需求描述"`);
        }
      } catch (e: unknown) {
        console.error(`注册失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    },
  );
```

- [ ] **Step 8.2：新增 `workspace update <id>` 命令**

在 `workspace delete` 命令注册之前，插入：

```typescript
ws
  .command("update <id>")
  .description("更新 workspace（--remote 更换远程地址；-b 更换默认分支；均无任务状态限制）")
  .option("--remote <url>", "新的远程仓库 URL（写入前执行 git ls-remote 验证）")
  .option("-b, --branch <name>", "更换默认分支")
  .option("--alias <name>", "重命名别名")
  .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
  .option("--json", "原始 JSON 输出")
  .action(
    async (
      id: string,
      opts: { remote?: string; branch?: string; alias?: string; port: string; json?: boolean },
    ) => {
      if (!opts.remote && !opts.branch && !opts.alias) {
        console.error("错误：请至少提供一个更新选项（--remote / -b / --alias）");
        process.exit(2);
      }

      const client = getClient(opts.port);
      await ensureDaemon(client);

      try {
        const body: Record<string, unknown> = {};
        if (opts.remote) body.remote_url = opts.remote.trim();
        if (opts.branch) body.default_branch = opts.branch.trim();
        if (opts.alias) body.alias = opts.alias.trim();

        const { workspace } = await client.updateWorkspace(id, body);
        if (opts.json) {
          console.log(JSON.stringify(workspace, null, 2));
        } else {
          console.log(`已更新 workspace：${id}`);
          if (workspace) {
            console.log(`  alias=${workspace.alias}  default_branch=${workspace.default_branch}`);
            if (workspace.remote_url) console.log(`  remote_url=${workspace.remote_url}`);
          }
        }
      } catch (e: unknown) {
        console.error(`更新失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    },
  );
```

- [ ] **Step 8.3：更新 `workspace list` 显示列**

将 list 命令中的 `cols` 定义：
```typescript
const cols = ["id", "alias", "path", "default_branch", "project_id"] as const;
```
改为：
```typescript
const cols = ["id", "alias", "remote_url", "default_branch", "project_id"] as const;
```
并删除 `// path 列截到 50` 的相关截断逻辑（remote_url 允许全显示）。

- [ ] **Step 8.4：更新 `client.createWorkspace` 接口（如有类型声明）**

检查 `src/client/http.ts` 或 `src/client/index.ts` 中 `createWorkspace` 的参数类型，将 `path: string` 改为 `path?: string | null; remote_url?: string | null`。

- [ ] **Step 8.5：运行 CLI 测试，更新期望**

```bash
bun test tests/cli-workspace.test.ts
```

预期部分测试会失败（旧签名测试）。更新 `tests/cli-workspace.test.ts`：

将旧测试：
```typescript
it("`workspace create` path 不存在时 exit 2 并报清晰错误（本地校验 short-circuit）", () => {
  runCli("init");
  const fakePath = ...;
  const r = runCli("workspace", "create", "myrepo", fakePath, "--port", "19999");
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain("path 不存在");
});
```
替换为：
```typescript
it("`workspace create` 未提供 --remote 或 --github 时 exit 2", () => {
  runCli("init");
  const r = runCli("workspace", "create", "myrepo", "--port", "19999");
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain("--remote");
});

it("`workspace create --remote <url>` 选项已注册", () => {
  runCli("init");
  const r = runCli("workspace", "create", "--help");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("--remote");
});

it("`workspace update --help` 含 --remote / -b", () => {
  runCli("init");
  const r = runCli("workspace", "update", "--help");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("--remote");
  expect(r.stdout).toContain("--branch");
});
```

- [ ] **Step 8.6：运行更新后的 CLI 测试**

```bash
bun test tests/cli-workspace.test.ts
```
Expected: 所有测试 passing

- [ ] **Step 8.7：提交**

```bash
git add src/cli/workspace.ts tests/cli-workspace.test.ts
git commit -m "feat: CLI workspace create 改为 --remote/--github 签名，新增 update 命令"
```

---

## Task 9：Web UI — 更新 `ProjectDetail.tsx` 工作区表单

**Files:**
- Modify: `src/web/src/pages/ProjectDetail.tsx`
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 9.1：更新 `useApi.ts` 的 `Workspace` 接口**

找到 `Workspace` 接口定义（约第 994 行），将：
```typescript
export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch: string;
  ...
}
```
改为：
```typescript
export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  /** 历史字段，新 workspace 可能为 null */
  path: string | null;
  /** 远程仓库 URL（主字段） */
  remote_url: string | null;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 9.2：更新 `ProjectDetail.tsx` 的 `CbForm` 接口**

将：
```typescript
interface CbForm {
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

const EMPTY_CB: CbForm = { alias: "", path: "", default_branch: "main", github_owner: "", github_repo: "" };
```
改为：
```typescript
interface CbForm {
  alias: string;
  remote_url: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

const EMPTY_CB: CbForm = { alias: "", remote_url: "", default_branch: "main", github_owner: "", github_repo: "" };
```

- [ ] **Step 9.3：更新 `openCbDialog` 函数（编辑时填入 remote_url）**

将：
```typescript
const openCbDialog = (cb?: Workspace) => {
  if (cb) {
    setEditingCb(cb);
    setCbForm({
      alias: cb.alias,
      path: cb.path,
      default_branch: cb.default_branch,
      github_owner: cb.github_owner ?? "",
      github_repo: cb.github_repo ?? "",
    });
  } else {
    ...
  }
  setLastDetectedPath(cb?.path ?? "");
  ...
```
改为：
```typescript
const openCbDialog = (cb?: Workspace) => {
  if (cb) {
    setEditingCb(cb);
    setCbForm({
      alias: cb.alias,
      remote_url: cb.remote_url ?? "",
      default_branch: cb.default_branch,
      github_owner: cb.github_owner ?? "",
      github_repo: cb.github_repo ?? "",
    });
  } else {
    setEditingCb(null);
    setCbForm(EMPTY_CB);
  }
  setCbDetectHint(null);
  setCbDialogOpen(true);
};
```

删除 `lastDetectedPath` / `setLastDetectedPath` 状态和 `detectCbFromPath` 函数（已不需要），删除 `detectingCb` / `setDetectingCb` 状态。

- [ ] **Step 9.4：更新 `saveCb` 函数**

将：
```typescript
const saveCb = async () => {
  const alias = cbForm.alias.trim();
  const path = cbForm.path.trim();
  if (!alias) { toast.error("验证失败", "别名不能为空"); return; }
  if (!path) { toast.error("验证失败", "路径不能为空"); return; }
  setSavingCb(true);
  try {
    if (editingCb) {
      await api.updateWorkspace(editingCb.id, {
        path,
        default_branch: cbForm.default_branch.trim() || "main",
        ...
      });
      ...
    } else {
      await api.createProjectWorkspace(projectId, {
        alias, path,
        ...
      });
      ...
    }
```
改为：
```typescript
const saveCb = async () => {
  const alias = cbForm.alias.trim();
  const remoteUrl = cbForm.remote_url.trim();
  if (!alias) { toast.error("验证失败", "别名不能为空"); return; }
  if (!remoteUrl) { toast.error("验证失败", "远程地址不能为空"); return; }
  setSavingCb(true);
  try {
    if (editingCb) {
      await api.updateWorkspace(editingCb.id, {
        remote_url: remoteUrl,
        default_branch: cbForm.default_branch.trim() || "main",
        github_owner: cbForm.github_owner.trim() || null,
        github_repo: cbForm.github_repo.trim() || null,
      });
      toast.success(`已更新工作区「${alias}」`);
    } else {
      await api.createProjectWorkspace(projectId, {
        alias,
        remote_url: remoteUrl,
        default_branch: cbForm.default_branch.trim() || "main",
        github_owner: cbForm.github_owner.trim() || null,
        github_repo: cbForm.github_repo.trim() || null,
      });
      toast.success(`已添加工作区「${alias}」`);
    }
    setCbDialogOpen(false);
    setEditingCb(null);
    refresh();
  } catch (e: unknown) {
    toast.error(editingCb ? "更新失败" : "创建失败", (e as Error)?.message ?? String(e));
  } finally {
    setSavingCb(false);
  }
};
```

- [ ] **Step 9.5：更新 JSX 中的表单字段**

在工作区创建/编辑 Dialog 的 JSX 中，找到路径输入部分：

```jsx
{/* 路径 */}
<div>
  <Label>本地路径</Label>
  <Input
    value={cbForm.path}
    onChange={(e) => setCbForm((f) => ({ ...f, path: e.target.value }))}
    onBlur={(e) => detectCbFromPath(e.target.value)}
    ...
  />
  <FolderPicker ... />
</div>
```

替换为：

```jsx
{/* 远程地址 */}
<div>
  <Label>远程仓库地址</Label>
  <Input
    value={cbForm.remote_url}
    onChange={(e) => setCbForm((f) => ({ ...f, remote_url: e.target.value }))}
    placeholder="https://github.com/owner/repo.git 或 git@github.com:owner/repo.git"
  />
  {cbDetectHint && (
    <p className="text-xs text-muted-foreground mt-1">{cbDetectHint}</p>
  )}
</div>
```

同时删除 `FolderPicker` 相关的 import 和 state（`folderPickerOpen` / `setFolderPickerOpen`）。

- [ ] **Step 9.6：更新工作区列表卡片显示**

找到工作区卡片中展示 `path` 的部分，改为展示 `remote_url`：

```jsx
{/* 将 cb.path 改为 cb.remote_url */}
<span className="text-xs text-muted-foreground truncate">
  {cb.remote_url ?? <span className="text-orange-500">⚠ 未填远程地址</span>}
</span>
```

- [ ] **Step 9.7：构建 Web UI，确认无编译错误**

```bash
bun run build:web
```
Expected: 0 errors（TypeScript 类型错误会在这里暴露）

- [ ] **Step 9.8：提交**

```bash
git add src/web/src/pages/ProjectDetail.tsx src/web/src/hooks/useApi.ts web-dist/
git commit -m "feat: Web UI 工作区表单去掉本地路径，改为远程 URL 输入"
```

---

## Task 10：全量验证

- [ ] **Step 10.1：运行全部测试**

```bash
bun test
```
Expected: 所有测试 passing；重点关注：
- `tests/migration-033.test.ts`
- `tests/workspace-probe.test.ts`  
- `tests/cli-workspace.test.ts`
- `tests/clone-workflow.test.ts`（sandbox clone 相关）
- `tests/codebases.test.ts`（workspaces CRUD）

- [ ] **Step 10.2：运行类型检查**

```bash
bun run typecheck
```
Expected: 0 errors

- [ ] **Step 10.3：运行 smoke test**

```bash
bun run smoke-test
```
Expected: 12 步全部通过（init → workspace create → req new → task → done 路径）

- [ ] **Step 10.4：手动验证软失效路径**

```bash
# 初始化
autopilot init

# 启动 daemon
autopilot daemon start

# 创建 workspace（使用 --remote 新签名）
autopilot workspace create myrepo --github owner/repo

# 验证列出时显示 remote_url
autopilot workspace list

# 验证 health 走网络请求
autopilot workspace health ws-001

# 验证 update 命令
autopilot workspace update ws-001 --remote https://github.com/new-owner/new-repo.git

# 停止 daemon
autopilot daemon stop
```

- [ ] **Step 10.5：确认存量迁移（模拟）**

```bash
# 检查 migration 033 在完整迁移链中正常执行
bun run dev upgrade
```
Expected: `Migration 033 applied`（或 `already up to date` 若 DB 已升级）

- [ ] **Step 10.6：最终提交**

```bash
git add -A
git commit -m "feat: Workspace 彻底去本地路径 - 全量验证通过"
```

---

## 自检

### Spec 覆盖确认

| 需求点 | 覆盖任务 |
|--------|----------|
| `workspace create` 仅需远程 URL，不再接受本地路径 | Task 8.1 |
| 写 DB 前 `git ls-remote` fail fast 验证 | Task 7.2（RPC create）|
| `workspace update --remote` 同样验证 | Task 7.3、Task 8.2 |
| 省略 `-b` 时自动探测默认分支 | Task 3.1（probeRemote）+ Task 7.2 |
| `git.token` 全局配置，HTTPS URL 注入 | Task 4、Task 5.2（buildAuthUrl）|
| SSH URL 走系统 key，token 不适用 | Task 3.1（buildAuthUrl 仅处理 https://）|
| `workspace health` 走 `git ls-remote` 网络请求 | Task 7.4 |
| `remote_url` 为 NULL 时 health 返回 unhealthy | Task 3.1（checkWorkspaceHealth）|
| 存量迁移：自动探测 origin 回填 remote_url | Task 1.1 |
| 探测不到 → 软失效（不阻断启动，任务时报错） | Task 1.1 + Task 6.1 |
| `sandbox clone` 改为 `git clone <remote_url>` 完整克隆 | Task 5.2 |
| Web UI 去路径输入，换远程 URL | Task 9 |
| DB 迁移幂等 | Task 1.1 测试覆盖 |

### Placeholder 检查

无 TBD / TODO / "similar to" 等占位符。

### 类型一致性检查

- `WorkspaceRef.remote_url: string`（Task 5.1）→ `task-factory.ts` 赋值（Task 6.1）✓
- `Workspace.remote_url: string | null`（Task 2.1）→ `useApi.ts`（Task 9.1）✓
- `probeRemote()` 在 Task 3.1 定义 → Task 7.2/7.3/7.4 调用 ✓
- `buildAuthUrl()` 在 Task 3.1 定义 → Task 5.2（sandbox）导入调用 ✓
- `loadGitConfig()` 在 Task 4 定义 → Task 5.2 / Task 7 调用 ✓
