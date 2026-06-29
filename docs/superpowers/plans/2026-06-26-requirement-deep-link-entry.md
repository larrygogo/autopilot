# 深链预填新建需求入口 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 autopilot Web 加 `/requirements/new` 深链预填页，支持 reqgenie（或任何第三方）通过 URL query 参数预填 title/spec/workspace_url/source/external_ref/callback_url/callback_secret/project，用户点确认后建真需求并跳转详情页；同时在 DB 给 requirements 表加 4 个 source 相关 nullable 列。

**Architecture:** A. 迁移 050 给 requirements 表加 4 列（source/external_ref/callback_url/callback_secret）并在 TABLE_COLUMNS 登记；B. core/rpc 层透传新字段（不改 create 核心逻辑，只加可选字段）；C. Web 加 `/requirements/new` 路由 + `RequirementNew.tsx` 预填表单页（读 query → 预填 → 用户确认 → 建需求 + workspace → 跳转详情）；D. 两个单测验证迁移 + RPC 字段透传。

**Tech Stack:** Bun/TypeScript、bun:sqlite、bun:test、React/Vite、react-router-dom、shadcn/ui、tailwindcss、现有 rpc-methods/useApi/pro 组件体系

## Global Constraints

- TypeScript strict 模式（`catch (e: unknown)` 非 `catch (e: any)`）
- 新列只走 migration + TABLE_COLUMNS，不改 SCHEMA 常量
- 全部 additive：不删任何现有代码、不动任何现有调用方
- 路由 `/requirements/new` 必须在 `/requirements/:id` 之前注册（否则 "new" 被当 id）
- 迁移文件风格：用 `PRAGMA table_info` 检查列存在后再 `ALTER TABLE`（幂等，见 migration 045）
- up 函数签名：`export function up(db: Database): void`（本迁移无 afterCommit 副作用）
- 代码注释 + commit message 用中文；代码本身英文
- 验证步骤：`bun run typecheck` + `bun test` + `bun run build:web` 全绿

---

## 文件映射

| 动作 | 路径 | 职责 |
|------|------|------|
| **新建** | `src/migrations/050-requirement-source-fields.ts` | 加 4 列（source/external_ref/callback_url/callback_secret） |
| **修改** | `src/core/db.ts` | TABLE_COLUMNS 加 4 列 |
| **修改** | `src/core/requirements/index.ts` | CreateRequirementOpts 加可选字段；createRequirement INSERT 包含这 4 列 |
| **修改** | `src/daemon/rpc-methods.ts` | requirements.create handler 透传 4 个可选字段 |
| **修改** | `src/web/src/hooks/useApi.ts` | createRequirement 调用签名加 4 个可选字段 |
| **新建** | `src/web/src/pages/RequirementNew.tsx` | 深链预填新建需求页 |
| **修改** | `src/web/src/App.tsx` | 加 `/requirements/new` 路由（必须在 `:id` 之前）+ lazy import |
| **新建** | `tests/migration-050.test.ts` | 测试迁移后 create 写 source 等字段 |
| **新建** | `tests/rpc-requirement-source-fields.test.ts` | 测试 requirements.create RPC 接收新字段 |

---

### Task 1: 迁移 050 + TABLE_COLUMNS 登记

**Files:**
- Create: `src/migrations/050-requirement-source-fields.ts`
- Modify: `src/core/db.ts` (TABLE_COLUMNS Set，第 93-111 行)

**Interfaces:**
- Produces: `up(db: Database): void` — 幂等 ALTER TABLE，无返回值（无 afterCommit）

- [ ] **Step 1: 新建迁移文件**

```typescript
// src/migrations/050-requirement-source-fields.ts
import type { Database } from "bun:sqlite";

/**
 * requirements 表加 4 个 source 追踪列（B 模式深链触发，设计见 selfhosted-autopilot-brain-design.md §4）：
 *   - source: 需求来源标识（如 'reqgenie'），可用于回传路由
 *   - external_ref: 外部系统的需求 id（如 reqgenie requirement uuid），用于回链
 *   - callback_url: autopilot 回传状态变化的 webhook URL（属于来源系统）
 *   - callback_secret: 回传 webhook 校验 secret（HMAC 签名用）
 *
 * 全部 nullable TEXT，现有需求保持 NULL，零影响存量数据。
 * 幂等：用 PRAGMA table_info 检查列存在再 ALTER（多次执行安全）。
 */
export function up(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(requirements)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("source")) {
    db.run("ALTER TABLE requirements ADD COLUMN source TEXT");
  }
  if (!cols.includes("external_ref")) {
    db.run("ALTER TABLE requirements ADD COLUMN external_ref TEXT");
  }
  if (!cols.includes("callback_url")) {
    db.run("ALTER TABLE requirements ADD COLUMN callback_url TEXT");
  }
  if (!cols.includes("callback_secret")) {
    db.run("ALTER TABLE requirements ADD COLUMN callback_secret TEXT");
  }
}
```

- [ ] **Step 2: 在 TABLE_COLUMNS 登记 4 个新列**

在 `src/core/db.ts` 找到 `export const TABLE_COLUMNS = new Set([` 所在的块（目前止于 `"seq"` 这行），在 `"seq",` 下方加：

```typescript
  // requirements 表 source 追踪列（migration 050）
  "source",
  "external_ref",
  "callback_url",
  "callback_secret",
```

注意：TABLE_COLUMNS 目前只包含 tasks 表列（按注释「tasks 表中实际存在的列字段」）。这 4 列属于 requirements 表，但一并在这里登记是本项目惯例（见 migration 045 加 input_mode 没有单独列表——实际上 requirements 没有独立的 TABLE_COLUMNS，迁移只在 Requirement interface 和 createRequirement INSERT 里体现）。

**重新确认**：`grep TABLE_COLUMNS src/core/db.ts` 和查看 requirements CRUD 用的是 `SELECT *`，并无独立的列白名单——requirements 字段在接口定义和 INSERT 语句中管理，不在 TABLE_COLUMNS 里。TABLE_COLUMNS 是 tasks 专用的。**本 step 实际上不需要修改 TABLE_COLUMNS**，直接跳过（以 Requirement interface + INSERT 管理列即可）。

- [ ] **Step 3: 验证迁移文件可 import（typecheck）**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck 2>&1 | head -20
```

期望：0 错误（仅新增文件，无改动现有代码）

---

### Task 2: Requirement 接口 + createRequirement 写新字段

**Files:**
- Modify: `src/core/requirements/index.ts`

**Interfaces:**
- 消费：migration 050 已加的 4 列
- 生产：`CreateRequirementOpts` 新增 `source?: string | null; external_ref?: string | null; callback_url?: string | null; callback_secret?: string | null;`；`createRequirement` 写入这 4 列

- [ ] **Step 1: 给 Requirement 接口加 4 个字段**

在 `src/core/requirements/index.ts` 的 `Requirement` 接口（第 20-58 行），找到 `input_mode: string | null;` 后面加：

```typescript
  /** 需求来源标识（如 'reqgenie'），B 模式深链触发时写入；原生建需求为 NULL。 */
  source: string | null;
  /** 外部系统需求 id（如 reqgenie requirement uuid），用于回链与去重。 */
  external_ref: string | null;
  /** 状态变化回传 webhook URL（仅 source 有值时使用）；失败不阻塞主流程。 */
  callback_url: string | null;
  /** 回传 webhook HMAC secret；与 callback_url 配对校验。 */
  callback_secret: string | null;
```

- [ ] **Step 2: 给 CreateRequirementOpts 加可选字段**

在 `CreateRequirementOpts` 接口（第 62-70 行），在 `chat_session_id?` 之后加：

```typescript
  source?: string | null;
  external_ref?: string | null;
  callback_url?: string | null;
  callback_secret?: string | null;
```

- [ ] **Step 3: 修改 createRequirement INSERT 写入 4 列**

找到 `createRequirement` 函数里的 `insertReq` 内层函数（第 153-159 行）：

```typescript
  const insertReq = (id: string): string => {
    db.run(
      "INSERT INTO requirements (id, project_id, workspace_id, title, status, spec_md, chat_session_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?)",
      [id, opts.project_id, resolvedWorkspaceId, opts.title, opts.spec_md ?? "", opts.chat_session_id ?? null, ts, ts],
    );
    return id;
  };
```

改为：

```typescript
  const insertReq = (id: string): string => {
    db.run(
      "INSERT INTO requirements (id, project_id, workspace_id, title, status, spec_md, chat_session_id, source, external_ref, callback_url, callback_secret, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.project_id,
        resolvedWorkspaceId,
        opts.title,
        opts.spec_md ?? "",
        opts.chat_session_id ?? null,
        opts.source ?? null,
        opts.external_ref ?? null,
        opts.callback_url ?? null,
        opts.callback_secret ?? null,
        ts,
        ts,
      ],
    );
    return id;
  };
```

- [ ] **Step 4: typecheck 确认**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck 2>&1 | head -20
```

期望：0 错误

---

### Task 3: RPC handler 透传新字段

**Files:**
- Modify: `src/daemon/rpc-methods.ts`（requirements.create handler，约第 1162-1196 行）

**Interfaces:**
- 消费：`CreateRequirementOpts` 中新增的 4 个可选字段
- 生产：RPC params 中的 `source?/external_ref?/callback_url?/callback_secret?` 透传到 `coreCreateRequirement`

- [ ] **Step 1: 在 requirements.create handler 提取并透传新字段**

找到 `coreCreateRequirement` 调用处（第 1185-1191 行）：

```typescript
      const created = coreCreateRequirement({
        project_id: projectId,
        workspace_id: workspaceId,
        title,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : "",
        chat_session_id: (p.chat_session_id as string | null | undefined) ?? null,
      });
```

改为：

```typescript
      const created = coreCreateRequirement({
        project_id: projectId,
        workspace_id: workspaceId,
        title,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : "",
        chat_session_id: (p.chat_session_id as string | null | undefined) ?? null,
        source: typeof p.source === "string" ? p.source : null,
        external_ref: typeof p.external_ref === "string" ? p.external_ref : null,
        callback_url: typeof p.callback_url === "string" ? p.callback_url : null,
        callback_secret: typeof p.callback_secret === "string" ? p.callback_secret : null,
      });
```

- [ ] **Step 2: typecheck**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck 2>&1 | head -20
```

期望：0 错误

---

### Task 4: 写两个单测

**Files:**
- Create: `tests/migration-050.test.ts`
- Create: `tests/rpc-requirement-source-fields.test.ts`

**Interfaces:**
- 消费：migration 050 up 函数；createRequirement；rpc-methods（通过 invokeRpcMethod）
- 生产：两个 test 文件，独立可运行

- [ ] **Step 1: 写 migration-050 测试**

参考 `tests/requirements-clarifier.test.ts` 的 initSchema 模式：

```typescript
// tests/migration-050.test.ts
/**
 * 迁移 050：requirements 表 source/external_ref/callback_url/callback_secret 列
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m045 } from "../src/migrations/045-requirement-input-mode";
import { up as m050 } from "../src/migrations/050-requirement-source-fields";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById } from "../src/core/requirements";

function setupDb(): void {
  const db = new Database(":memory:");
  // 按需加载所有依赖迁移（跳过与本测试无关的中间步骤）
  [m001, m004, m005, m008, m009, m024, m045, m050].forEach((fn) => fn(db));
  _setDbForTest(db);
  createProject({ id: "p-test", name: "TestProject" });
}

describe("migration-050: source 追踪列", () => {
  beforeEach(() => {
    setupDb();
  });

  it("迁移后列存在且 nullable", () => {
    const db = new Database(":memory:");
    [m001, m004, m005, m008, m009, m024, m045].forEach((fn) => fn(db));
    // 迁移前不存在
    const colsBefore = db
      .query<{ name: string }, []>("PRAGMA table_info(requirements)")
      .all()
      .map((c) => c.name);
    expect(colsBefore.includes("source")).toBe(false);
    expect(colsBefore.includes("external_ref")).toBe(false);

    // 跑迁移
    m050(db);

    const colsAfter = db
      .query<{ name: string }, []>("PRAGMA table_info(requirements)")
      .all()
      .map((c) => c.name);
    expect(colsAfter.includes("source")).toBe(true);
    expect(colsAfter.includes("external_ref")).toBe(true);
    expect(colsAfter.includes("callback_url")).toBe(true);
    expect(colsAfter.includes("callback_secret")).toBe(true);
  });

  it("迁移幂等：重跑不报错", () => {
    const db = new Database(":memory:");
    [m001, m004, m005, m008, m009, m024, m045, m050].forEach((fn) => fn(db));
    // 再跑一次
    expect(() => m050(db)).not.toThrow();
  });

  it("createRequirement 写入 source/external_ref/callback_url/callback_secret", () => {
    const req = createRequirement({
      id: "req-001",
      project_id: "p-test",
      title: "来自 reqgenie 的需求",
      spec_md: "spec",
      source: "reqgenie",
      external_ref: "rg-uuid-123",
      callback_url: "https://reqgenie.example.com/webhook",
      callback_secret: "s3cr3t",
    });
    expect(req.source).toBe("reqgenie");
    expect(req.external_ref).toBe("rg-uuid-123");
    expect(req.callback_url).toBe("https://reqgenie.example.com/webhook");
    expect(req.callback_secret).toBe("s3cr3t");
  });

  it("不传新字段时默认 NULL（现有调用方零影响）", () => {
    const req = createRequirement({
      id: "req-002",
      project_id: "p-test",
      title: "普通需求",
    });
    expect(req.source).toBeNull();
    expect(req.external_ref).toBeNull();
    expect(req.callback_url).toBeNull();
    expect(req.callback_secret).toBeNull();
  });

  it("getRequirementById 能读到新字段", () => {
    createRequirement({
      id: "req-003",
      project_id: "p-test",
      title: "T",
      source: "test-src",
    });
    const found = getRequirementById("req-003");
    expect(found?.source).toBe("test-src");
    expect(found?.external_ref).toBeNull();
  });
});
```

- [ ] **Step 2: 运行 migration-050 测试，期望全绿**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun test tests/migration-050.test.ts
```

期望：所有 5 个测试 PASS

- [ ] **Step 3: 写 RPC source 字段透传测试**

参考 `tests/rpc.test.ts` + `tests/requirements-clarifier.test.ts` 组合模式：rpc-methods 注册依赖数据库初始化，用 in-memory DB + _setDbForTest。

```typescript
// tests/rpc-requirement-source-fields.test.ts
/**
 * requirements.create RPC handler 透传 source/external_ref/callback_url/callback_secret
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m033 } from "../src/migrations/033-workspace-remote-url";
import { up as m034 } from "../src/migrations/034-requirement-sessions";
import { up as m035 } from "../src/migrations/035-notifications";
import { up as m036 } from "../src/migrations/036-drop-now-dismissed";
import { up as m037 } from "../src/migrations/037-multi-workspace-per-project";
import { up as m041 } from "../src/migrations/041-api-keys";
import { up as m043 } from "../src/migrations/043-workspace-id-demote-backfill";
import { up as m044 } from "../src/migrations/044-task-run-columns";
import { up as m045 } from "../src/migrations/045-requirement-input-mode";
import { up as m046 } from "../src/migrations/046-requirement-deliveries";
import { up as m047 } from "../src/migrations/047-providers-table";
import { up as m048 } from "../src/migrations/048-workflow-kind-spec-json";
import { up as m050 } from "../src/migrations/050-requirement-source-fields";
import { _setDbForTest } from "../src/core/db";
import { _resetRpcRegistryForTest, invokeRpcMethod } from "../src/daemon/rpc";
import { createProject } from "../src/core/projects";

// rpc-methods 的注册是副作用（import 时运行），需 import 触发注册
// 注意：rpc-methods 的顶层代码在 import 时会调用 registerRpcMethod —— 仅 import 即注册
// 但 _resetRpcRegistryForTest 之后注册会丢失，所以每次 reset 后要重新 import（动态 import）
// 实际测试策略：不 reset，只需 before 时初始化 DB（rpc-methods 注册只做一次）
import "../src/daemon/rpc-methods";

function setupDb(): void {
  const db = new Database(":memory:");
  [
    m001, m004, m005, m008, m009, m024, m033, m034, m035, m036,
    m037, m041, m043, m044, m045, m046, m047, m048, m050,
  ].forEach((fn) => fn(db));
  _setDbForTest(db);
  createProject({ id: "proj-rpc-test", name: "RPC Test Project" });
}

describe("requirements.create RPC — source 字段透传", () => {
  beforeEach(() => {
    setupDb();
  });

  it("传入 source/external_ref/callback_url/callback_secret 能落库", async () => {
    const res = await invokeRpcMethod("requirements.create", {
      project_id: "proj-rpc-test",
      title: "来自 reqgenie 的需求",
      spec_md: "规约",
      source: "reqgenie",
      external_ref: "rg-abc-def",
      callback_url: "https://example.com/cb",
      callback_secret: "tok123",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const req = (res.payload as { requirement: { source: string | null; external_ref: string | null; callback_url: string | null; callback_secret: string | null } }).requirement;
      expect(req.source).toBe("reqgenie");
      expect(req.external_ref).toBe("rg-abc-def");
      expect(req.callback_url).toBe("https://example.com/cb");
      expect(req.callback_secret).toBe("tok123");
    }
  });

  it("不传新字段时新字段为 null（现有调用方不受影响）", async () => {
    const res = await invokeRpcMethod("requirements.create", {
      project_id: "proj-rpc-test",
      title: "普通需求",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const req = (res.payload as { requirement: { source: string | null } }).requirement;
      expect(req.source).toBeNull();
    }
  });
});
```

- [ ] **Step 4: 运行 RPC 测试**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun test tests/rpc-requirement-source-fields.test.ts
```

期望：2 个测试 PASS（若 rpc-methods import 有注册副作用冲突，参考同类测试调整 import 顺序）

- [ ] **Step 5: 运行全量测试，确认无回归**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun test
```

期望：全量绿（或与 baseline 相同的已知 flake）

- [ ] **Step 6: commit（Task 1-4 一起提交）**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
git add src/migrations/050-requirement-source-fields.ts src/core/requirements/index.ts src/daemon/rpc-methods.ts tests/migration-050.test.ts tests/rpc-requirement-source-fields.test.ts
git commit -m "feat(requirements): 迁移050加source/external_ref/callback_url/callback_secret列，RPC透传新字段"
```

---

### Task 5: useApi.ts 加新字段签名 + 新建 RequirementNew.tsx

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`（createRequirement 类型签名）
- Create: `src/web/src/pages/RequirementNew.tsx`

**Interfaces:**
- 消费：`api.createRequirement`、`api.listWorkspaces`、`api.createWorkspace`、`api.setRequirementWorkspaces`（均在 useApi.ts 已有）
- 生产：`RequirementNew` React 组件，由 App.tsx 在 `/requirements/new` 路由挂载

- [ ] **Step 1: 给 useApi.ts 的 createRequirement 加新字段**

找到（第 709-717 行）：

```typescript
  createRequirement: (body: {
    project_id?: string;
    workspace_id?: string | null;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.create", body).then((r) => r.requirement),
```

改为：

```typescript
  createRequirement: (body: {
    project_id?: string;
    workspace_id?: string | null;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
    source?: string | null;
    external_ref?: string | null;
    callback_url?: string | null;
    callback_secret?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.create", body).then((r) => r.requirement),
```

- [ ] **Step 2: 新建 RequirementNew.tsx**

```tsx
// src/web/src/pages/RequirementNew.tsx
/**
 * 深链预填新建需求页：/requirements/new?title=&spec=&workspace_url=&source=&external_ref=&callback_url=&callback_secret=&project=
 *
 * 设计：B 模式触发入口（见 selfhosted-autopilot-brain-design.md §6 步骤1）。
 * reqgenie（或任何外部系统）把表单要点编码进 URL query，用户在 autopilot 看到预填表单、
 * 点「创建需求」才真建（防止被任意链接刷需求）。
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { PageShell } from "@/components/pro";
import { FormField } from "@/components/pro";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/Toast";
import { api, type Workspace } from "@/hooks/useApi";

export function RequirementNew() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  // 从 URL query 读预填值
  const qTitle = searchParams.get("title") ?? "";
  const qSpec = searchParams.get("spec") ?? "";
  const qWorkspaceUrl = searchParams.get("workspace_url") ?? "";
  const qSource = searchParams.get("source") ?? null;
  const qExternalRef = searchParams.get("external_ref") ?? null;
  const qCallbackUrl = searchParams.get("callback_url") ?? null;
  const qCallbackSecret = searchParams.get("callback_secret") ?? null;
  const qProject = searchParams.get("project") ?? null;

  // 表单状态（预填可编辑）
  const [title, setTitle] = useState(qTitle);
  const [spec, setSpec] = useState(qSpec);
  const [workspaceUrl, setWorkspaceUrl] = useState(qWorkspaceUrl);

  // 加载 + 提交状态
  const [submitting, setSubmitting] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loadingProject, setLoadingProject] = useState(true);

  // 加载 project id（优先用 query 指定，否则取 proj-default）
  useEffect(() => {
    if (qProject) {
      setProjectId(qProject);
      setLoadingProject(false);
      return;
    }
    // 取第一个 project（通常是 proj-default）
    api.listProjects()
      .then((ps) => {
        if (ps.length > 0) setProjectId(ps[0].id);
        else setProjectId("proj-default");
      })
      .catch(() => setProjectId("proj-default"))
      .finally(() => setLoadingProject(false));
  }, [qProject]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      toast.error("标题必填", "请填写需求标题");
      return;
    }
    if (!projectId) {
      toast.error("项目加载中", "请稍后再试");
      return;
    }

    setSubmitting(true);
    try {
      // 步骤 a：有 workspace_url 时找/建 workspace
      let workspaceId: string | null = null;
      const urlTrimmed = workspaceUrl.trim();
      if (urlTrimmed) {
        // 按 remote_url 找现有 workspace
        const all = await api.listWorkspaces();
        const existing = all.find((w: Workspace) => w.remote_url === urlTrimmed);
        if (existing) {
          workspaceId = existing.id;
        } else {
          // 不存在则新建：alias 取 URL 末段（去 .git 后缀）
          const rawAlias = urlTrimmed.replace(/\.git$/, "").split("/").pop() ?? "workspace";
          const ws = await api.createWorkspace({
            alias: rawAlias,
            remote_url: urlTrimmed,
            project_id: projectId,
          });
          workspaceId = ws.id;
        }
      }

      // 步骤 b：建需求
      const req = await api.createRequirement({
        project_id: projectId,
        title: title.trim(),
        spec_md: spec.trim(),
        source: qSource,
        external_ref: qExternalRef,
        callback_url: qCallbackUrl,
        callback_secret: qCallbackSecret,
      });

      // 步骤 c：有 workspace 时绑定
      if (workspaceId) {
        await api.setRequirementWorkspaces(req.id, [workspaceId]);
      }

      // 步骤 d：跳转需求详情
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("创建需求失败", msg);
    } finally {
      setSubmitting(false);
    }
  }, [title, spec, workspaceUrl, projectId, qSource, qExternalRef, qCallbackUrl, qCallbackSecret, toast, navigate]);

  const hasSource = !!qSource;

  return (
    <PageShell
      width="form"
      hero={{ title: "新建需求", subtitle: hasSource ? `来自 ${qSource}` : undefined }}
      loading={loadingProject}
    >
      <div className="space-y-6">
        {/* 来源提示条（仅 source 有值时显示） */}
        {hasSource && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            此需求由 <span className="font-medium text-foreground">{qSource}</span> 触发预填。
            请确认内容后点「创建需求」——点击前不会建任何东西。
          </div>
        )}

        <FormField label="标题" required htmlFor="req-title">
          <Input
            id="req-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话描述需求"
            aria-invalid={!title.trim() ? true : undefined}
          />
        </FormField>

        <FormField
          label="规约"
          htmlFor="req-spec"
          hint="详细描述需求背景、验收标准等（可选，建需求后仍可补充）"
        >
          <Textarea
            id="req-spec"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="背景、验收标准、参考资料…"
            rows={8}
          />
        </FormField>

        <FormField
          label="代码库 URL"
          htmlFor="req-workspace-url"
          hint="填 Git remote URL（如 https://github.com/org/repo）；留空则不绑定代码库"
        >
          <Input
            id="req-workspace-url"
            value={workspaceUrl}
            onChange={(e) => setWorkspaceUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
          />
        </FormField>

        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="min-w-[120px]"
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? "创建中…" : "创建需求"}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)} disabled={submitting}>
            取消
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck 2>&1 | head -30
```

期望：0 错误

---

### Task 6: App.tsx 加路由，验证全量

**Files:**
- Modify: `src/web/src/App.tsx`（加 lazy import + 路由）

**Interfaces:**
- 消费：`RequirementNew` 组件（from `./pages/RequirementNew`）
- 关键约束：`/requirements/new` 路由必须在 `/requirements/:id` 之前（第 424 行之前）

- [ ] **Step 1: 加 lazy import**

在 `src/web/src/App.tsx` 的 lazy import 块中，找到 `RequirementDetail` 的 lazy import（约第 67-69 行），在其**之前**加：

```typescript
const RequirementNew = lazy(() =>
  import("./pages/RequirementNew").then((m) => ({ default: m.RequirementNew })),
);
```

- [ ] **Step 2: 加路由（必须在 `:id` 之前）**

找到（约第 422-426 行）：

```typescript
                {/* RESTful 深链：:id（当前阶段）·/:id/:step（生命周期阶段）·/:id/:step/:runId
                    （执行阶段具体 run）。三条都挂 RequirementDetail，由其按 useParams 取 step/runId。 */}
                <Route path="/requirements/:id" element={<RequirementDetail />} />
```

在这段之前插入：

```typescript
                {/* 深链预填新建需求：必须在 /requirements/:id 之前，防止 "new" 被当作 reqId */}
                <Route path="/requirements/new" element={<RequirementNew />} />
```

- [ ] **Step 3: titleForPath 加 /requirements/new 处理**

找到 `function titleForPath`（约第 137 行），在 `if (pathname.startsWith("/requirements/")) return "需求详情";` 之前加：

```typescript
  if (pathname === "/requirements/new") return "新建需求";
```

- [ ] **Step 4: typecheck**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck 2>&1 | head -30
```

期望：0 错误

- [ ] **Step 5: 全量测试**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun test
```

期望：全量绿（或与 baseline 相同的已知 flake）

- [ ] **Step 6: 构建 Web UI**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run build:web 2>&1 | tail -20
```

期望：构建成功，无 TypeScript 错误

- [ ] **Step 7: commit**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
git add src/web/src/pages/RequirementNew.tsx src/web/src/hooks/useApi.ts src/web/src/App.tsx
git commit -m "feat(web): 加/requirements/new深链预填新建需求页，支持source/workspace_url等query预填"
```

---

### Task 7: 写报告 + 最终验证

**Files:**
- Create: `.superpowers/sdd/step1-trigger-entry-report.md`

- [ ] **Step 1: 跑所有三项验证**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck && echo "typecheck OK"
bun test && echo "test OK"
bun run build:web && echo "build:web OK"
```

期望：三行都输出 OK

- [ ] **Step 2: 取最新 commit SHA**

```bash
git log --oneline -3
```

记录最新 commit 的短 SHA。

- [ ] **Step 3: 写报告**

```markdown
<!-- .superpowers/sdd/step1-trigger-entry-report.md -->
# B 模式步骤 1：深链预填触发入口 — 完成报告

**Status:** Done

**Commit SHA:** <最新短 SHA>

**迁移号:** 050

## 新增内容

### 迁移 + 列
- `src/migrations/050-requirement-source-fields.ts`：幂等加 4 列（source / external_ref / callback_url / callback_secret），均 nullable TEXT

### Core 层
- `src/core/requirements/index.ts`：`Requirement` 接口加 4 个 nullable 字段；`CreateRequirementOpts` 加 4 个可选字段；`createRequirement` INSERT 写入这 4 列

### RPC 层
- `src/daemon/rpc-methods.ts`：requirements.create handler 透传 4 个可选字段

### Web UI
- 新路由：`/requirements/new`（在 App.tsx 中注册于 `/requirements/:id` 之前）
- 新页面：`src/web/src/pages/RequirementNew.tsx` — 读 query 参数预填表单，用户确认才建需求
  - 支持 query 参数：`title` / `spec` / `workspace_url` / `source` / `external_ref` / `callback_url` / `callback_secret` / `project`
  - 有 `workspace_url` 时：先找现有 workspace（按 remote_url）→ 无则新建 → setWorkspaces 绑定
  - 建需求成功后跳转 `/requirements/:id`

### 测试
- `tests/migration-050.test.ts`：5 个用例（列存在、幂等、写字段、空字段、getById 读取）
- `tests/rpc-requirement-source-fields.test.ts`：2 个 RPC 用例（带字段/不带字段）

## 验证结果

| 验证项 | 结果 |
|--------|------|
| `bun run typecheck` | ✓ 0 错误 |
| `bun test` | ✓ 全绿 |
| `bun run build:web` | ✓ 构建成功 |

## 报告路径

`.superpowers/sdd/step1-trigger-entry-report.md`
```

- [ ] **Step 4: 最终 commit（含报告）**

```bash
cd C:\Users\larry\Desktop\workspace\autopilot
git add .superpowers/sdd/step1-trigger-entry-report.md
git commit -m "docs(sdd): 步骤1深链预填入口完成报告"
```

---

## 自检：Spec 覆盖对照

| 需求项 | 对应 Task |
|--------|-----------|
| 迁移 050 加 4 列 | Task 1 |
| TABLE_COLUMNS 登记（实际确认不需要，requirements 无独立 TABLE_COLUMNS） | Task 1 Step 2 澄清 |
| Requirement 接口加字段 | Task 2 Step 1 |
| CreateRequirementOpts 加可选字段 | Task 2 Step 2 |
| createRequirement INSERT 写 4 列 | Task 2 Step 3 |
| requirements.create RPC handler 透传 | Task 3 |
| useApi.ts 签名 | Task 5 Step 1 |
| RequirementNew.tsx 页面 | Task 5 Step 2 |
| 路由 /requirements/new 在 :id 之前 | Task 6 Step 2 |
| 有 workspace_url 找/建 workspace | Task 5 Step 2（handleSubmit） |
| source/external_ref/callback_url/callback_secret 落库 | Task 2 + Task 3 |
| 跳转 /requirements/:reqId | Task 5 Step 2 |
| 错误处理 toast | Task 5 Step 2 |
| 测试：迁移 + create 写字段 | Task 4 Step 1-2 |
| 测试：RPC 透传 | Task 4 Step 3-4 |
| bun run typecheck | Task 6 Step 4 |
| bun test | Task 6 Step 5 |
| bun run build:web | Task 6 Step 6 |
| 写报告到 .superpowers/sdd/step1-trigger-entry-report.md | Task 7 |
| commit（中文 message） | Task 4 Step 6, Task 6 Step 7, Task 7 Step 4 |
