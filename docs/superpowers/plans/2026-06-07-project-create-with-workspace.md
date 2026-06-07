# 新建项目同步关联工作区 Implementation Plan（v2，已修订驳回意见）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `autopilot project create <name>` 改为 `autopilot project create <name> <path> [--alias <alias>]`，一步完成「建项目 + 新建并关联顶层 Workspace」，同时 Web UI Library 页的新建项目对话框也补充路径字段。

**Architecture:** Core 层新增 `deriveAlias`/`resolveUniqueAlias`（workspaces.ts）和 `createProjectWithWorkspace`（projects.ts）原语，用 `db.transaction()` 保证原子性，alias 在 Core 层全局去重（跨所有 workspace）；Daemon RPC `projects.createWithWorkspace` 负责路径存在性校验和可选 git 自动探测；CLI 预校验路径（客户端快速失败）后调用新 RPC；Web UI 新建对话框使用项目中已有的 `FolderPicker` 组件（该组件通过 `api.browseFs()` 调用 daemon 提供的服务端目录树 API，不使用浏览器 File API，可正确获得服务器本地路径——与 `ProjectDetail.tsx` 中管理工作区的方式完全相同）。

**Tech Stack:** TypeScript (strict)、Bun runtime、SQLite（via `getDb()` / `_setDbForTest`）、Commander.js（CLI）、React + Vite（Web UI）、bun:test（测试）

---

## 重要设计决策说明（修订点）

### 1. Web UI FolderPicker 可行性澄清

`FolderPicker`（`src/web/src/components/FolderPicker.tsx`）在本项目中**不使用浏览器 File API**，而是通过 `api.browseFs()` 调用 daemon 的 `fs.list` RPC，由运行在本地的 daemon 进程列出服务器文件系统目录树，再把目录路径字符串返回给前端。因此：

- `onSelect(path: string)` 回调收到的是完整的本地绝对路径（如 `/code/myapp` 或 `C:\Users\larry\projects\myapp`）
- `ProjectDetail.tsx` 已经用同一组件管理 workspace 路径，实测可行
- 此设计的前提是 daemon 和浏览器在同一台机器上（autopilot 的设计假设）

### 2. `resolveUniqueAlias` 去重范围

**全局（所有 workspace，无论所属 project）**。查询语句：
```sql
SELECT id FROM workspaces WHERE alias = ? LIMIT 1
```
无 `project_id` 过滤，确保 alias 在整个 workspace 表内唯一。

理由：alias 是用户面的可读标识符，`workspace list` 全局列出，若多个 project 下有同名 alias，用户阅读输出时容易混淆。

### 3. 统一错误/成功文案

| 场景 | CLI 文案 | Web UI |
|------|----------|--------|
| 路径不存在 | `错误：路径不存在: <path>` (exit 2) | toast.error `路径不存在: <path>` |
| name 为空 | `错误：name 不能为空` (exit 2) | toast.error `项目名称不能为空` |
| 成功 | 见下方 | toast.success `已创建项目「MyApp」并绑定工作区 myapp` |

CLI 成功输出（**必须展示实际使用的 alias**，因为可能已被静默追加后缀）：
```
已创建 project：proj-001  MyApp
  描述：Some description      ← 仅当有描述时
已绑定工作区：ws-001  myapp  →  /code/myapp
                    ↑ 实际生效的 alias（可能已变为 myapp-2）

下一步：autopilot req new "你的需求描述" -p proj-001
```

---

## 受影响文件一览

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/workspaces.ts` | 修改 | 新增 `deriveAlias` + `resolveUniqueAlias` |
| `src/core/projects.ts` | 修改 | 新增 `CreateProjectWithWorkspaceOpts` + `createProjectWithWorkspace` |
| `src/daemon/rpc-methods.ts` | 修改 | 注册 `projects.createWithWorkspace` RPC 方法 |
| `src/client/http.ts` | 修改 | 新增 `createProjectWithWorkspace` HTTP 方法 |
| `src/client/index.ts` | 修改 | 暴露新方法 getter |
| `src/cli/project.ts` | 修改 | `project create` 签名改为 `<name> <path>` |
| `src/web/src/hooks/useApi.ts` | 修改 | api 对象新增 `createProjectWithWorkspace` |
| `src/web/src/pages/Library.tsx` | 修改 | 新建对话框添加路径 + alias 字段 |
| `tests/core-create-project-with-workspace.test.ts` | 新建 | Core 层单元测试（使用 `_setDbForTest` 内存 DB） |
| `tests/cli-project.test.ts` | 修改 | 更新两个受签名变化影响的测试 |
| `tests/cli-project-with-workspace.test.ts` | 新建 | 新命令行为的 CLI 集成测试 |

---

## Task 1：写 Core 层单元测试（先写失败的测试）

**Files:**
- Create: `tests/core-create-project-with-workspace.test.ts`

> **测试 setup 说明**：本项目的 Core 层测试使用 `_setDbForTest(sqlite)` 注入内存 DB，再手动执行迁移，与 `tests/projects.test.ts` 和 `tests/codebases.test.ts` 完全相同。

- [ ] **Step 1：创建测试文件（此时 `deriveAlias`、`resolveUniqueAlias`、`createProjectWithWorkspace` 均未定义，测试会在编译或运行时失败）**

```typescript
// tests/core-create-project-with-workspace.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m025 } from "../src/migrations/025-one-workspace-per-project";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
// @ts-expect-error — 函数此时未实现，先让类型检查在运行时报错
import { deriveAlias, resolveUniqueAlias, createWorkspace } from "../src/core/workspaces";
// @ts-expect-error
import { createProjectWithWorkspace } from "../src/core/projects";

let sqlite: Database;
let tmpDir: string;

beforeAll(() => {
  sqlite = new Database(":memory:");
  _setDbForTest(sqlite);
  initDb();
  m001(sqlite); m002(sqlite); m004(sqlite); m005(sqlite);
  m006(sqlite); m007(sqlite); m008(sqlite); m009(sqlite);
  m010(sqlite); m011(sqlite); m019(sqlite); m021(sqlite);
  m024(sqlite); m025(sqlite);
  tmpDir = mkdtempSync(tmpdir() + "/autopilot-core-test-");
});

afterAll(() => {
  _setDbForTest(null);
  sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. deriveAlias（纯函数，无 DB）──────────────────────────────────

describe("deriveAlias", () => {
  it("从 POSIX 路径取末尾目录名", () => {
    expect(deriveAlias("/code/myapp")).toBe("myapp");
  });
  it("忽略 POSIX 结尾斜杠", () => {
    expect(deriveAlias("/code/myapp/")).toBe("myapp");
  });
  it("Windows 路径（反斜杠）正确解析", () => {
    expect(deriveAlias("C:\\Users\\larry\\projects\\myapp")).toBe("myapp");
  });
  it("路径为空字符串时返回 'workspace' 兜底", () => {
    expect(deriveAlias("")).toBe("workspace");
  });
  it("单层路径（无分隔符）原样返回", () => {
    expect(deriveAlias("myapp")).toBe("myapp");
  });
});

// ── 2. resolveUniqueAlias（需要 DB）──────────────────────────────────

describe("resolveUniqueAlias", () => {
  it("无冲突时直接返回原始 alias", () => {
    expect(resolveUniqueAlias("no-conflict-alias-xyz")).toBe("no-conflict-alias-xyz");
  });

  it("已存在同名 alias（任意项目）时自动追加 -2", () => {
    // 注意：project_id 随意填（测试内存 DB 无 FK 约束）
    createWorkspace({ id: "ws-alias-t1", project_id: "proj-x", alias: "conflict-base", path: "/tmp/t1" });
    expect(resolveUniqueAlias("conflict-base")).toBe("conflict-base-2");
  });

  it("已存在 foo 和 foo-2 时返回 foo-3", () => {
    createWorkspace({ id: "ws-alias-t2", project_id: "proj-x", alias: "conflict-base-2", path: "/tmp/t2" });
    expect(resolveUniqueAlias("conflict-base")).toBe("conflict-base-3");
  });

  it("去重跨项目（全局）：proj-a 下的 alias 阻止 proj-b 使用同名", () => {
    createWorkspace({ id: "ws-alias-t3", project_id: "proj-a", alias: "cross-proj-alias", path: "/tmp/t3" });
    // 即使在不同 project_id 下，全局也不允许重复
    const result = resolveUniqueAlias("cross-proj-alias");
    expect(result).toBe("cross-proj-alias-2");
  });
});

// ── 3. createProjectWithWorkspace（集成 Core 层）──────────────────────

describe("createProjectWithWorkspace", () => {
  it("非 git 目录也能成功建 project + workspace", () => {
    const dir = mkdtempSync(tmpDir + "/plain-dir-");
    const { project, workspace } = createProjectWithWorkspace({
      name: "PlainDirProject",
      path: dir,
    });
    expect(project.id).toMatch(/^proj-/);
    expect(project.name).toBe("PlainDirProject");
    expect(workspace.id).toMatch(/^ws-/);
    expect(workspace.project_id).toBe(project.id);
    expect(workspace.path).toBe(dir);
  });

  it("不提供 alias 时从 path 末尾目录名推导", () => {
    const dir = mkdtempSync(tmpDir + "/known-name-");
    const baseName = dir.split(/[\\/]/).pop()!;
    const { workspace } = createProjectWithWorkspace({
      name: "AliasFromPathProject",
      path: dir,
    });
    // alias 可能已追加后缀（-2 等），但必须以原始目录名开头
    expect(workspace.alias.startsWith(baseName)).toBe(true);
  });

  it("显式传入 alias 时使用用户指定值", () => {
    const dir = mkdtempSync(tmpDir + "/explicit-");
    const { workspace } = createProjectWithWorkspace({
      name: "ExplicitAliasProject",
      path: dir,
      alias: "my-explicit-alias",
    });
    expect(workspace.alias).toBe("my-explicit-alias");
  });

  it("alias 冲突时第二次调用自动追加后缀（对调用方透明）", () => {
    const dir1 = mkdtempSync(tmpDir + "/clash-");
    const dir2 = mkdtempSync(tmpDir + "/clash-");
    const { workspace: ws1 } = createProjectWithWorkspace({
      name: "ClashProject1",
      path: dir1,
      alias: "clash-alias",
    });
    const { workspace: ws2 } = createProjectWithWorkspace({
      name: "ClashProject2",
      path: dir2,
      alias: "clash-alias",
    });
    expect(ws1.alias).toBe("clash-alias");
    expect(ws2.alias).toBe("clash-alias-2");
    // 两者隶属不同 project
    expect(ws1.project_id).not.toBe(ws2.project_id);
  });

  it("project 和 workspace 在同一事务：两者必须同时存在", () => {
    const dir = mkdtempSync(tmpDir + "/tx-test-");
    const before = {
      projects: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM projects").get()!).n,
      workspaces: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM workspaces").get()!).n,
    };
    createProjectWithWorkspace({ name: "TxProject", path: dir });
    const after = {
      projects: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM projects").get()!).n,
      workspaces: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM workspaces").get()!).n,
    };
    // project 和 workspace 增量必须同步（各 +1）
    expect(after.projects - before.projects).toBe(1);
    expect(after.workspaces - before.workspaces).toBe(1);
  });

  it("workspace.default_branch 默认值为 'main'（非 git 目录）", () => {
    const dir = mkdtempSync(tmpDir + "/default-branch-");
    const { workspace } = createProjectWithWorkspace({
      name: "DefaultBranchProject",
      path: dir,
    });
    expect(workspace.default_branch).toBe("main");
  });

  it("显式传入 default_branch 时覆盖默认值", () => {
    const dir = mkdtempSync(tmpDir + "/custom-branch-");
    const { workspace } = createProjectWithWorkspace({
      name: "CustomBranchProject",
      path: dir,
      default_branch: "develop",
    });
    expect(workspace.default_branch).toBe("develop");
  });
});
```

- [ ] **Step 2：运行测试确认它们全部失败（函数未定义）**

```bash
bun test tests/core-create-project-with-workspace.test.ts
```

预期：编译错误或运行时 `TypeError: deriveAlias is not a function`

- [ ] **Step 3：提交测试文件（先提交失败的测试，TDD 红灯阶段）**

```bash
git add tests/core-create-project-with-workspace.test.ts
git commit -m "test: 新增 createProjectWithWorkspace 单元测试（TDD 红灯）"
```

---

## Task 2：Core 辅助函数（workspaces.ts）

**Files:**
- Modify: `src/core/workspaces.ts`（在文件末尾追加）

- [ ] **Step 1：在 `src/core/workspaces.ts` 末尾追加两个导出函数**

```typescript
/**
 * 从本地路径推导 workspace alias（取末尾目录名，兼容 Windows/POSIX，忽略结尾分隔符）。
 * 框架规范版本；与 ProjectDetail.tsx 的 folderName 逻辑对齐。
 */
export function deriveAlias(dirPath: string): string {
  const trimmed = dirPath.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || "workspace";
}

/**
 * 确保 alias 在全局 workspaces 表中唯一（跨所有 project_id）。
 * 若已存在同名 workspace，自动追加 -2/-3/… 后缀，对调用方完全透明。
 *
 * 去重范围：全局（不限 project），因为 alias 是用户面的全局标识符。
 */
export function resolveUniqueAlias(baseAlias: string): string {
  const db = getDb();
  let alias = baseAlias;
  let counter = 2;
  while (true) {
    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM workspaces WHERE alias = ? LIMIT 1")
      .get(alias);
    if (!row) return alias;
    alias = `${baseAlias}-${counter}`;
    counter++;
  }
}
```

- [ ] **Step 2：运行 Task 1 的测试，确认 deriveAlias 和 resolveUniqueAlias 相关用例通过**

```bash
bun test tests/core-create-project-with-workspace.test.ts --test-name-pattern "deriveAlias|resolveUniqueAlias"
```

预期：`deriveAlias`（5 个）+ `resolveUniqueAlias`（4 个）全部 PASS；`createProjectWithWorkspace` 测试仍 FAIL

- [ ] **Step 3：编译检查**

```bash
bun run typecheck
```

预期：0 错误

- [ ] **Step 4：提交**

```bash
git add src/core/workspaces.ts
git commit -m "feat: 新增 deriveAlias 和 resolveUniqueAlias 辅助函数"
```

---

## Task 3：Core 原子创建函数（projects.ts）

**Files:**
- Modify: `src/core/projects.ts`

- [ ] **Step 1：在 `src/core/projects.ts` 顶部（`import { getDb } from "./db";` 之后）添加 workspaces 导入**

```typescript
import {
  createWorkspace,
  nextWorkspaceId,
  deriveAlias,
  resolveUniqueAlias,
  type Workspace,
} from "./workspaces";
```

- [ ] **Step 2：在文件末尾追加接口和函数**

```typescript
export interface CreateProjectWithWorkspaceOpts {
  name: string;
  description?: string | null;
  /** 本地目录路径（调用方保证路径存在，本函数不做 FS 校验） */
  path: string;
  /**
   * 工作区别名。省略时从 path 末尾目录名自动推导；
   * 全局冲突时静默追加数字后缀（-2/-3/…），对调用方不可见。
   */
  alias?: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
}

/**
 * 在单个 DB 事务内原子地创建 Project + 顶层 Workspace。
 * - 路径存在性校验：由上层（RPC 层）负责，本函数不做 FS 操作。
 * - alias 推导和全局去重：在事务开始前完成（resolveUniqueAlias 是 SELECT，幂等）。
 */
export function createProjectWithWorkspace(opts: CreateProjectWithWorkspaceOpts): {
  project: Project;
  workspace: Workspace;
} {
  const db = getDb();
  const baseAlias = opts.alias?.trim() || deriveAlias(opts.path);
  const uniqueAlias = resolveUniqueAlias(baseAlias);

  return db.transaction(() => {
    const project = createProject({
      id: nextProjectId(),
      name: opts.name,
      description: opts.description ?? null,
    });
    const workspace = createWorkspace({
      id: nextWorkspaceId(),
      project_id: project.id,
      alias: uniqueAlias,
      path: opts.path,
      default_branch: opts.default_branch ?? "main",
      github_owner: opts.github_owner ?? null,
      github_repo: opts.github_repo ?? null,
    });
    return { project, workspace };
  })();
}
```

- [ ] **Step 3：运行 Task 1 的完整测试，确认全部通过**

```bash
bun test tests/core-create-project-with-workspace.test.ts
```

预期：所有测试（5 个 deriveAlias + 4 个 resolveUniqueAlias + 7 个 createProjectWithWorkspace）全部 PASS

- [ ] **Step 4：编译检查**

```bash
bun run typecheck
```

预期：0 错误

- [ ] **Step 5：提交**

```bash
git add src/core/projects.ts
git commit -m "feat: 新增 createProjectWithWorkspace 原子建项目+工作区函数"
```

---

## Task 4：Daemon 层注册 RPC 方法（rpc-methods.ts）

**Files:**
- Modify: `src/daemon/rpc-methods.ts`

- [ ] **Step 1：扩展 projects 导入行（约第 58-66 行）**

将：
```typescript
import {
  listProjects,
  getProjectById,
  createProject as coreCreateProject,
  updateProject as coreUpdateProject,
  deleteProject as coreDeleteProject,
  nextProjectId,
  DEFAULT_PROJECT_ID,
} from "../core/projects";
```
改为：
```typescript
import {
  listProjects,
  getProjectById,
  createProject as coreCreateProject,
  createProjectWithWorkspace as coreCreateProjectWithWorkspace,
  updateProject as coreUpdateProject,
  deleteProject as coreDeleteProject,
  nextProjectId,
  DEFAULT_PROJECT_ID,
} from "../core/projects";
```

- [ ] **Step 2：在 `projects.create` 方法注册块（约第 1600 行）之后，插入新 RPC 方法**

定位此处（`projects.create` 的结束 `});`）：
```typescript
        throw new RpcError("CREATE_FAILED", msg);
      }
    },
  });

  registerRpcMethod({
    method: "projects.update",
```

在 `projects.create` 的 `});` 和 `projects.update` 的 `registerRpcMethod` 之间插入：

```typescript
  registerRpcMethod({
    method: "projects.createWithWorkspace",
    description: "一步新建 Project + 顶层 Workspace（路径须存在；alias 省略时从目录名自动推导并全局去重）",
    handler: (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) throw new RpcError("INVALID_PARAM", "name 必填");
      const pathField = typeof p.path === "string" ? p.path.trim() : "";
      if (!pathField) throw new RpcError("INVALID_PARAM", "path 必填");

      // 路径先校验：不存在则立即报错，项目和工作区均不创建
      if (!existsSync(pathField)) {
        throw new RpcError("INVALID_PARAM", `路径不存在: ${pathField}`);
      }

      // 可选 git 探测（纯读；非 git 目录时 github_owner/github_repo 为 null，default_branch 为 null）
      const detected = detectWorkspaceGit(pathField);
      const rawAlias = typeof p.alias === "string" ? p.alias.trim() : "";
      const explicitBranch =
        typeof p.default_branch === "string" && p.default_branch.trim()
          ? p.default_branch.trim()
          : null;
      const gh_owner = typeof p.github_owner === "string" ? p.github_owner : null;
      const gh_repo = typeof p.github_repo === "string" ? p.github_repo : null;

      try {
        const { project, workspace } = coreCreateProjectWithWorkspace({
          name,
          description: (p.description as string | null | undefined) ?? null,
          path: pathField,
          alias: rawAlias || undefined,
          default_branch: explicitBranch ?? detected.default_branch ?? undefined,
          github_owner: gh_owner || detected.github_owner || null,
          github_repo: gh_repo || detected.github_repo || null,
        });
        emitBus({ type: "projects:changed", payload: { id: project.id, action: "create" } });
        return { project, workspace };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new RpcError("CREATE_FAILED", msg);
      }
    },
  });
```

- [ ] **Step 3：编译检查**

```bash
bun run typecheck
```

预期：0 错误（`existsSync` 已在文件第 22 行从 `"node:fs"` 导入；`detectWorkspaceGit` 已在第 70 行从 `"../core/workspace-health"` 导入）

- [ ] **Step 4：提交**

```bash
git add src/daemon/rpc-methods.ts
git commit -m "feat: 注册 projects.createWithWorkspace RPC 方法"
```

---

## Task 5：Client 层包装（http.ts + index.ts）

**Files:**
- Modify: `src/client/http.ts`
- Modify: `src/client/index.ts`

- [ ] **Step 1：在 `src/client/http.ts` 的 `createProject` 方法之后（约第 248 行）添加新方法**

找到：
```typescript
  async createProject(body: { name: string; description?: string }): Promise<{ project: Project }> {
    return this.call("projects.create", body);
  }
```

在其之后插入：
```typescript
  async createProjectWithWorkspace(body: {
    name: string;
    description?: string | null;
    path: string;
    alias?: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
  }): Promise<{ project: Project; workspace: Workspace }> {
    return this.call("projects.createWithWorkspace", body);
  }
```

- [ ] **Step 2：在 `src/client/index.ts` 的 `createProject` getter 之后（约第 60 行）添加新 getter**

找到：
```typescript
  get createProject() { return this.http.createProject.bind(this.http); }
```

在其之后插入：
```typescript
  get createProjectWithWorkspace() { return this.http.createProjectWithWorkspace.bind(this.http); }
```

- [ ] **Step 3：编译检查**

```bash
bun run typecheck
```

预期：0 错误（`Workspace` 类型已在 `http.ts` 中导入/使用，因为 `createProjectWorkspace` 已返回 `{ workspace: Workspace }`）

- [ ] **Step 4：提交**

```bash
git add src/client/http.ts src/client/index.ts
git commit -m "feat: 客户端新增 createProjectWithWorkspace 方法"
```

---

## Task 6：CLI 命令签名更新（project.ts）

**Files:**
- Modify: `src/cli/project.ts`

- [ ] **Step 1：在文件顶部已有 import 之后添加 `existsSync` 导入**

在：
```typescript
import type { Command } from "commander";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";
```
之后添加：
```typescript
import { existsSync } from "node:fs";
```

- [ ] **Step 2：整体替换 `project create` 命令声明（约第 65-94 行）**

将：
```typescript
  proj
    .command("create <name>")
    .description("创建 project（用于 req new 等需要挂载 project 的命令）")
    .option("-d, --description <text>", "简短描述")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (name: string, opts: { description?: string; port: string; json?: boolean }) => {
      if (!name.trim()) {
        console.error("错误：name 不能为空");
        process.exit(2);
      }
      const client = getClient(opts.port);
      await ensureDaemon(client);

      try {
        const body: { name: string; description?: string } = { name: name.trim() };
        if (opts.description) body.description = opts.description;
        const { project } = await client.createProject(body);
        if (opts.json) {
          console.log(JSON.stringify(project, null, 2));
        } else {
          console.log(`已创建 project：${project.id}  ${project.name}`);
          if (project.description) console.log(`  描述：${project.description}`);
          console.log(`\n下一步：autopilot req new "你的需求描述" -p ${project.id}`);
        }
      } catch (e: unknown) {
        console.error(`创建失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
```

替换为（注意成功输出必须包含实际生效的 alias）：
```typescript
  proj
    .command("create <name> <path>")
    .description("创建 project 并绑定本地工作区（一步到位）")
    .option("--alias <alias>", "工作区别名（省略时从目录名自动推导，冲突时静默追加后缀）")
    .option("-d, --description <text>", "简短描述")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .option("--json", "原始 JSON 输出")
    .action(async (
      name: string,
      wsPath: string,
      opts: { alias?: string; description?: string; port: string; json?: boolean },
    ) => {
      if (!name.trim()) {
        console.error("错误：name 不能为空");
        process.exit(2);
      }
      if (!wsPath.trim()) {
        console.error("错误：path 不能为空");
        process.exit(2);
      }

      // 客户端预校验路径（快速失败，减少一次 daemon 往返）
      if (!existsSync(wsPath)) {
        console.error(`错误：路径不存在: ${wsPath}`);
        process.exit(2);
      }

      const client = getClient(opts.port);
      await ensureDaemon(client);

      try {
        const body: {
          name: string;
          path: string;
          alias?: string;
          description?: string;
        } = { name: name.trim(), path: wsPath.trim() };
        if (opts.alias) body.alias = opts.alias;
        if (opts.description) body.description = opts.description;

        const { project, workspace } = await client.createProjectWithWorkspace(body);
        if (opts.json) {
          console.log(JSON.stringify({ project, workspace }, null, 2));
        } else {
          console.log(`已创建 project：${project.id}  ${project.name}`);
          if (project.description) console.log(`  描述：${project.description}`);
          // 展示实际生效的 alias（可能已被静默追加后缀变为 myapp-2 等）
          console.log(`已绑定工作区：${workspace.id}  ${workspace.alias}  →  ${workspace.path}`);
          console.log(`\n下一步：autopilot req new "你的需求描述" -p ${project.id}`);
        }
      } catch (e: unknown) {
        console.error(`创建失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
```

- [ ] **Step 3：编译检查**

```bash
bun run typecheck
```

预期：0 错误

- [ ] **Step 4：提交**

```bash
git add src/cli/project.ts
git commit -m "feat: project create 改为 <name> <path> 签名，一步建项目+工作区"
```

---

## Task 7：Web API 层（useApi.ts）

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1：在 `createProject` 行之后（约第 528 行）插入新方法**

找到：
```typescript
  // [WS-RPC] projects.create
  createProject: (body: { name: string; description?: string }) =>
    requestRpc<{ project: Project }>("projects.create", body).then((r) => r.project),
```

在其之后插入：
```typescript
  // [WS-RPC] projects.createWithWorkspace
  createProjectWithWorkspace: (body: {
    name: string;
    description?: string | null;
    path: string;
    alias?: string;
  }) =>
    requestRpc<{ project: Project; workspace: Workspace }>(
      "projects.createWithWorkspace",
      body,
    ),
```

- [ ] **Step 2：编译检查（Web 子包）**

```bash
bun run typecheck
```

预期：0 错误（`Workspace` 类型已在 `useApi.ts` 中定义并导出）

- [ ] **Step 3：提交**

```bash
git add src/web/src/hooks/useApi.ts
git commit -m "feat: useApi 新增 createProjectWithWorkspace RPC 包装"
```

---

## Task 8：Web UI 对话框更新（Library.tsx）

**Files:**
- Modify: `src/web/src/pages/Library.tsx`

> **FolderPicker 说明**：`FolderPicker`（`src/web/src/components/FolderPicker.tsx`）通过 `api.browseFs()` 调用 daemon 提供的 `fs.list` RPC，在服务器侧列出目录树，返回完整的本地绝对路径字符串。这不是浏览器 File API——因此可以正确获得服务器本地路径。`ProjectDetail.tsx` 已用同一组件管理 workspace 路径，本 Task 复用同样模式。

- [ ] **Step 1：扩展 lucide-react import，添加 `FolderOpen` 图标**

将：
```typescript
import { Layers, Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
```
改为：
```typescript
import { Layers, Plus, RefreshCw, Pencil, Trash2, FolderOpen } from "lucide-react";
```

- [ ] **Step 2：扩展 useApi import，添加 `Workspace` 类型；新增 `FolderPicker` import**

将：
```typescript
import { api, type Project } from "@/hooks/useApi";
```
改为：
```typescript
import { api, type Project, type Workspace } from "@/hooks/useApi";
import { FolderPicker } from "@/components/FolderPicker";
```

- [ ] **Step 3：扩展 `FormState` 接口，更新 `EMPTY_FORM`，添加 `folderName` 辅助函数**

将：
```typescript
interface FormState {
  name: string;
  description: string;
}

const EMPTY_FORM: FormState = { name: "", description: "" };
```
改为：
```typescript
interface FormState {
  name: string;
  description: string;
  /** 新建时必填，编辑时忽略 */
  path: string;
  /** 新建时可选；空时服务端从路径末尾推导（并全局去重后缀） */
  alias: string;
}

const EMPTY_FORM: FormState = { name: "", description: "", path: "", alias: "" };

/**
 * 从路径取末尾目录名用于自动填写 alias 预览，兼容 Windows/POSIX，忽略结尾分隔符。
 * 与 FolderPicker 返回的路径格式一致。
 */
function folderName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}
```

- [ ] **Step 4：在 `ProjectsTab` 组件内已有的 state 声明之后添加 `folderPickerOpen` 状态**

在 `const [saving, setSaving] = useState(false);` 之后添加：
```typescript
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
```

- [ ] **Step 5：在 `openCreateDialog` 函数之后添加 `handlePathSelect`**

```typescript
  /** FolderPicker 选定路径后回调：更新 path，并在 alias 为空时自动预填 */
  const handlePathSelect = (selectedPath: string) => {
    setFolderPickerOpen(false);
    const derived = folderName(selectedPath);
    setForm((f) => ({
      ...f,
      path: selectedPath,
      // 仅当 alias 为空时自动填入目录名；用户已手动填写的 alias 不覆盖
      alias: f.alias || derived,
    }));
  };
```

- [ ] **Step 6：替换整个 `save` 函数**

将原 `save` 函数完整替换为：
```typescript
  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("验证失败", "项目名称不能为空");
      return;
    }
    // 新建时校验路径（编辑时不要求）
    if (!editingProject && !form.path.trim()) {
      toast.error("验证失败", "工作区路径不能为空");
      return;
    }
    setSaving(true);
    try {
      if (editingProject) {
        await api.updateProject(editingProject.id, {
          name,
          description: form.description.trim() || null,
        });
        toast.success(`已更新项目「${name}」`);
      } else {
        const result = await api.createProjectWithWorkspace({
          name,
          description: form.description.trim() || undefined,
          path: form.path.trim(),
          alias: form.alias.trim() || undefined,
        });
        // 展示实际生效的 alias（服务端可能已全局去重追加后缀）
        toast.success(
          `已创建项目「${result.project.name}」并绑定工作区 ${result.workspace.alias}`,
        );
      }
      setDialogOpen(false);
      setEditingProject(null);
      refresh();
    } catch (e: unknown) {
      toast.error(editingProject ? "更新失败" : "创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 7：在对话框 JSX 的描述字段之后插入路径 + alias 字段（仅新建模式）**

找到描述字段 `<div className="space-y-1.5">` 的结束 `</div>`（包含 `project-description` input 的块），在其后插入：

```tsx
            {!editingProject && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="project-path">
                    工作区路径 <span className="text-destructive">*</span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="project-path"
                      placeholder="例如：/code/myapp"
                      value={form.path}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, path: e.target.value }))
                      }
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => setFolderPickerOpen(true)}
                      title="浏览文件夹"
                      aria-label="浏览文件夹"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    本地目录路径（无需是 git 仓库），daemon 会自动探测 git 信息
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="project-alias">工作区别名（可选）</Label>
                  <Input
                    id="project-alias"
                    placeholder="不填时自动取目录名"
                    value={form.alias}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, alias: e.target.value }))
                    }
                  />
                </div>
              </>
            )}
```

- [ ] **Step 8：更新对话框描述文字（新建时提示路径必填）**

找到：
```tsx
              {editingProject
                ? "修改项目名称或描述。"
                : "填写项目名称和描述，创建后可在项目工作台中关联工作区和需求。"}
```
改为：
```tsx
              {editingProject
                ? "修改项目名称或描述。"
                : "填写项目名称，并选择本地工作区路径，一步完成创建和关联。"}
```

- [ ] **Step 9：在删除确认 dialog 的 `{/* 删除确认 dialog */}` 注释之前插入 FolderPicker**

```tsx
      {/* 文件夹选择器（新建项目时弹出，通过 daemon 服务端目录树选路径） */}
      <FolderPicker
        open={folderPickerOpen}
        onSelect={handlePathSelect}
        onCancel={() => setFolderPickerOpen(false)}
      />
```

- [ ] **Step 10：构建 Web UI 确认无 TypeScript 错误**

```bash
bun run build:web
```

预期：构建成功，0 TS 错误

- [ ] **Step 11：提交**

```bash
git add src/web/src/pages/Library.tsx
git commit -m "feat: Library 新建项目对话框添加工作区路径和 alias 字段"
```

---

## Task 9：更新现有 CLI 测试（cli-project.test.ts）

**Files:**
- Modify: `tests/cli-project.test.ts`

`project create <name>` 签名变为 `project create <name> <path>`，以下两个测试需补充 `<path>` 参数。

- [ ] **Step 1：更新 "daemon 未启时 `project create` 提示并退出码 ≠ 0" 测试**

将：
```typescript
  it("daemon 未启时 `project create` 提示并退出码 ≠ 0", () => {
    runCli("init");
    const r = runCli("project", "create", "MyProject", "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });
```
改为：
```typescript
  it("daemon 未启时 `project create` 提示并退出码 ≠ 0", () => {
    runCli("init");
    // 新签名需要 <path>；用 REPO 根目录（必然存在）让路径校验通过，再触发 daemon 检查
    const r = runCli("project", "create", "MyProject", REPO, "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });
```

- [ ] **Step 2：更新 "`project create` name 为空时报 exit 2" 测试**

将：
```typescript
  it("`project create` name 为空时报 exit 2", () => {
    runCli("init");
    const r = runCli("project", "create", "   ", "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("name 不能为空");
  });
```
改为：
```typescript
  it("`project create` name 为空时报 exit 2", () => {
    runCli("init");
    // name 校验先于 daemon 检查执行，path 给合法值即可（不影响 name 校验触发）
    const r = runCli("project", "create", "   ", REPO, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("name 不能为空");
  });
```

- [ ] **Step 3：运行更新后的测试**

```bash
bun test tests/cli-project.test.ts
```

预期：5/5 全部通过

- [ ] **Step 4：提交**

```bash
git add tests/cli-project.test.ts
git commit -m "test: 更新 cli-project 测试以适配新 <path> 参数"
```

---

## Task 10：新增 CLI 集成测试（cli-project-with-workspace.test.ts）

**Files:**
- Create: `tests/cli-project-with-workspace.test.ts`

- [ ] **Step 1：创建测试文件**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
let tmpPath: string;
const REPO = process.cwd();

beforeEach(() => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `autopilot-proj-ws-${suffix}`);
  tmpPath = join(tmpdir(), `test-ws-dir-${suffix}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  mkdirSync(tmpPath, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (existsSync(tmpPath)) rmSync(tmpPath, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("project create <name> <path> 新签名", () => {
  it("帮助文本含 <path>、--alias、--description、--json", () => {
    runCli("init");
    const r = runCli("project", "create", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("<path>");
    expect(r.stdout).toContain("--alias");
    expect(r.stdout).toContain("--description");
    expect(r.stdout).toContain("--json");
  });

  it("路径不存在时 exit 2，stderr 含「路径不存在」（不需要 daemon）", () => {
    runCli("init");
    const r = runCli(
      "project", "create", "MyProject",
      "/tmp/this-absolutely-does-not-exist-xyz-999",
      "--port", "19999",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("路径不存在");
    // 路径校验在 daemon 检查之前，因此不会出现 daemon 错误
    expect(r.stderr).not.toContain("daemon");
  });

  it("name 为空时 exit 2，stderr 含「name 不能为空」", () => {
    runCli("init");
    const r = runCli("project", "create", "   ", tmpPath, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("name 不能为空");
  });

  it("路径存在且 name 合法 → 路径校验通过 → 尝试连 daemon（daemon 未起则报 daemon 错）", () => {
    runCli("init");
    const r = runCli("project", "create", "MyProject", tmpPath, "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("路径不存在的 exit 2 优先于 daemon 连接检查", () => {
    runCli("init");
    const r = runCli(
      "project", "create", "MyProject",
      "/tmp/not-a-real-dir-xyz",
      "--port", "19999",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("路径不存在");
    expect(r.stderr).not.toContain("daemon");
  });
});
```

- [ ] **Step 2：运行新测试（全部应通过，因为均是离线 CLI 校验测试）**

```bash
bun test tests/cli-project-with-workspace.test.ts
```

预期：5/5 全部 PASS

- [ ] **Step 3：运行完整单元测试套件，确认无回归**

```bash
bun test
```

预期：所有测试通过，无新失败

- [ ] **Step 4：提交**

```bash
git add tests/cli-project-with-workspace.test.ts
git commit -m "test: 新增 project create <name> <path> CLI 集成测试"
```

---

## Self-Review

### 1. 规格覆盖

| 需求点 | 覆盖 Task |
|--------|-----------|
| CLI `project create <name> <path>` 新签名 | Task 6 |
| `--alias` 可选，自动推导 | Task 2（deriveAlias）+ Task 3（createProjectWithWorkspace）+ Task 6 |
| alias 冲突全局静默去重 | Task 2（resolveUniqueAlias，明确全局范围）|
| 路径先校验（路径不存在 → 不创建任何东西）| Task 4（RPC 服务端）+ Task 6（CLI 客户端预校验）|
| 不强制 git 仓库 | Task 4（detectWorkspaceGit 失败静默）+ Task 1 单元测试覆盖 |
| 原子性（project + workspace 同事务）| Task 3（db.transaction）|
| 成功输出含实际生效 alias | Task 6（CLI）+ Task 8（Web UI toast）|
| Web UI 支持（FolderPicker 可行） | Task 7 + Task 8，设计决策说明已澄清 |
| CLI 支持 | Task 6 |
| alias 去重范围明确定义 | 设计决策说明第 2 条 + Task 2 实现 |
| 统一错误文案 | 设计决策说明第 3 条 + Task 6 实现 |
| Core 层单元测试 | Task 1（deriveAlias 5个 + resolveUniqueAlias 4个 + createProjectWithWorkspace 7个）|
| 现有测试回归 | Task 9 |
| 新 CLI 测试 | Task 10 |

### 2. 占位符检查

所有步骤均包含完整可执行代码，无 TBD/TODO/类似占位符。✓

### 3. 类型一致性

- `CreateProjectWithWorkspaceOpts.alias?: string` → RPC `rawAlias || undefined` → CLI `opts.alias` → Web `form.alias.trim() || undefined`：全链路可选字符串 ✓
- `createProjectWithWorkspace` 返回 `{ project: Project; workspace: Workspace }` → RPC/Client/useApi 同结构 ✓
- `resolveUniqueAlias` Task 2 export → Task 3 import ✓
- `_setDbForTest` / `initDb` 在 Task 1 中使用，与 `tests/projects.test.ts` 同一模式 ✓

### 4. 驳回意见逐条核查

| 驳回点 | 修订内容 |
|--------|---------|
| Web UI FolderPicker 不可行 | 已在「设计决策说明」第 1 条及 Task 8 注释中明确：FolderPicker 使用服务端目录 RPC，不使用浏览器 File API，可正确获得本地路径 ✓ |
| 成功输出未定义 | 设计决策说明第 3 条定义精确文案；Task 6 CLI 代码展示 `workspace.alias`；Task 8 toast 展示实际 alias ✓ |
| resolveUniqueAlias 去重范围不明确 | 设计决策说明第 2 条明确「全局」；Task 2 实现用无 project_id 过滤的 SQL；Task 1 有专门跨项目去重测试 ✓ |
| Core 层缺少单元测试 | Task 1 新增 `tests/core-create-project-with-workspace.test.ts`：5 个 deriveAlias 纯函数测试 + 4 个 resolveUniqueAlias DB 测试（含跨项目去重）+ 7 个 createProjectWithWorkspace 测试（非git目录、alias推导、显式alias、alias冲突、事务性、默认branch、自定义branch）✓ |
