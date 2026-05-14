# 对话式提需求 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"提需求"做成 AI 帮忙整理 + 用户选环境——用户描述一段口语化需求 → AI 生成 title + spec_md → 立即建 draft requirement + 跳详情页让 clarifier 接管调查。

**Architecture:** 新增 `src/daemon/requirement-extract.ts` 一次性 LLM 调用模块，与 `requirement-clarifier.ts` 共享 agent 解析 helper。新增 HTTP `POST /api/requirements/extract`。Web `/start` 整体重写、CLI `req new` 三模式（交互 / `--from-prompt` / `-f`）。抽取永不阻塞——LLM 失败时走 raw_text 兜底。

**Tech Stack:** TypeScript / Bun runtime / Commander CLI / Bun.serve / React + Vite / bun:test。

**Spec:** `docs/superpowers/specs/2026-05-14-requirement-extract-onboarding-design.md`

**进程调用约定：** 使用 `Bun.spawn` / `Bun.spawnSync`（与 PR #64 setup 同风格）；测试隔离用 `_setDbForTest(new Database(":memory:"))` + `runPendingMigrations()`；写 SQL 集中在 `src/core/db.ts` 等白名单（single-writer invariant）。

---

## 文件结构

### 新增

| 路径 | 责任 |
|---|---|
| `src/daemon/clarifier-agent.ts` | 共享 helper：把 clarifier agent 解析提到这里，供 clarifier 和 extract 复用 |
| `src/daemon/requirement-extract.ts` | `runClarifierExtract(input)` + 兜底；可测试注入 `_setExtractFnForTest` |
| `src/cli/requirements-cli.ts` | `registerRequirementCommands(program)`：`req new` 三模式 |
| `tests/requirement-extract.test.ts` | extract 模式 + 兜底 + agent 解析单测 |
| `tests/routes-extract-api.test.ts` | POST /api/requirements/extract 路由测试 |
| `tests/cli-req-new.test.ts` | CLI 三模式 + cwd 推断测试 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/daemon/requirement-clarifier.ts` | 把 `callClaude` 里的 agent 解析提到 `clarifier-agent.ts`，import 复用 |
| `src/daemon/routes.ts` | 加 `POST /api/requirements/extract` 路由 |
| `src/cli/index.ts` | 注册 `registerRequirementCommands(program)` |
| `src/web/src/hooks/useApi.ts` | 加 `extractRequirement(input)` |
| `src/web/src/pages/Start.tsx` | **整体重写**：删 mode 二选一 / 删表单 / 删 chat 入口卡 |

---

# PR-1：core extract + HTTP API

预估半天，5 个 task。

## Task 1：抽 clarifier-agent 共享 helper

**Files:**
- Create: `src/daemon/clarifier-agent.ts`
- Modify: `src/daemon/requirement-clarifier.ts`

- [ ] **Step 1：写 helper**

写入 `src/daemon/clarifier-agent.ts`：

```ts
import { resolveAgentConfig, createAgent } from "../agents/registry";
import { loadGlobalAgents, loadProviders } from "../core/config";
import type { Agent } from "../agents/agent";

export interface ClarifierAgentOverride {
  provider?: "anthropic" | "openai" | "google";
  model?: string;
}

/**
 * 解析并实例化 clarifier agent。
 * - 复用 config.yaml.agents.clarifier 配置（不存在时用 anthropic 默认）
 * - 调用方可传 override（req 级覆盖时用）
 * 返回值可被 clarifier 调查阶段、extract 抽取阶段共用。
 */
export function buildClarifierAgent(override: ClarifierAgentOverride = {}): Agent {
  const globalAgents = loadGlobalAgents();
  const providers = loadProviders();
  const globalClarifier = globalAgents["clarifier"] ?? { provider: "anthropic" };
  const merged = { ...globalClarifier, ...override };
  const resolved = resolveAgentConfig("clarifier", undefined, { clarifier: merged }, providers);
  return createAgent(resolved);
}
```

- [ ] **Step 2：改 clarifier.ts 用 helper**

`src/daemon/requirement-clarifier.ts` 顶部 import 区追加：

```ts
import { buildClarifierAgent } from "./clarifier-agent";
```

定位 `callClaude` 函数（约第 43 行），把内部 agent 解析的 7 行（从 `const globalAgents = loadGlobalAgents();` 到 `agent = createAgent(resolved);`）替换为：

```ts
    const req = getRequirementById(reqId);
    const override: { provider?: "anthropic" | "openai" | "google"; model?: string } = {};
    if (req?.clarifier_provider) override.provider = req.clarifier_provider as "anthropic" | "openai" | "google";
    if (req?.clarifier_model) override.model = req.clarifier_model;
    agent = buildClarifierAgent(override);
```

删除已不需要的本地 `loadGlobalAgents` / `loadProviders` / `resolveAgentConfig` / `createAgent` import（如果只在该函数用到）。**确认** `loadGlobalAgents` / `loadProviders` 没被文件其他地方引用后再删。

- [ ] **Step 3：跑现有 clarifier 测试确认无回归**

```
bun test tests/clarifier-e2e.test.ts tests/clarifier-inflight-lock.test.ts tests/clarifier-redesign.test.ts
```
Expected: 全过

- [ ] **Step 4：commit**

```
git add src/daemon/clarifier-agent.ts src/daemon/requirement-clarifier.ts
git commit -m "refactor(clarifier): 抽 buildClarifierAgent 共享 helper"
```

## Task 2：requirement-extract 模块

**Files:**
- Create: `src/daemon/requirement-extract.ts`
- Create: `tests/requirement-extract.test.ts`

- [ ] **Step 1：写测试**

写入 `tests/requirement-extract.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { runClarifierExtract, _setExtractFnForTest } from "../src/daemon/requirement-extract";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(
    join(tmpHome, "config.yaml"),
    "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n",
    "utf-8",
  );
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  _setExtractFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runClarifierExtract", () => {
  it("正常返回 title + spec_md", async () => {
    _setExtractFnForTest(async () =>
      JSON.stringify({ title: "登录页忘记密码", spec_md: "## 背景\n用户忘记密码\n## 目标\n邮件重置\n## 验收\n能收到邮件" }),
    );
    const r = await runClarifierExtract({
      raw_text: "给登录页加忘记密码功能",
      project_id: "proj-001",
    });
    expect(r.title).toBe("登录页忘记密码");
    expect(r.spec_md).toContain("## 背景");
  });

  it("LLM 抛错走兜底（title=前30字 spec_md=原文）", async () => {
    _setExtractFnForTest(async () => {
      throw new Error("provider down");
    });
    const r = await runClarifierExtract({
      raw_text: "给登录页加忘记密码功能。需要邮件重置和验证码二选一",
      project_id: "proj-001",
    });
    expect(r.title).toBe("给登录页加忘记密码功能。需要邮件重置和验证码二选一".slice(0, 30));
    expect(r.spec_md).toBe("给登录页加忘记密码功能。需要邮件重置和验证码二选一");
  });

  it("LLM 返回非法 JSON 走兜底", async () => {
    _setExtractFnForTest(async () => "this is not json");
    const r = await runClarifierExtract({
      raw_text: "raw input",
      project_id: "proj-001",
    });
    expect(r.title).toBe("raw input");
    expect(r.spec_md).toBe("raw input");
  });

  it("LLM 返回 JSON 但缺 title 字段走兜底", async () => {
    _setExtractFnForTest(async () => JSON.stringify({ spec_md: "only spec" }));
    const r = await runClarifierExtract({
      raw_text: "fallback case",
      project_id: "proj-001",
    });
    expect(r.title).toBe("fallback case");
    expect(r.spec_md).toBe("fallback case");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/requirement-extract.test.ts
```
Expected: FAIL（module not found）

- [ ] **Step 3：实现模块**

写入 `src/daemon/requirement-extract.ts`：

```ts
import { createLogger } from "../core/logger";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("requirement-extract");

const EXTRACT_SYSTEM_PROMPT = `你是需求分析师。
读用户的口语化描述，输出**严格 JSON** 含两个字段：
- title：≤30 字的标题
- spec_md：Markdown 整理，含 "## 背景" "## 目标" "## 验收" 三段

只输出 JSON，不要解释、不要 \`\`\`json 围栏。`;

export interface ExtractInput {
  raw_text: string;
  project_id: string;
  codebase_id?: string | null;
}

export interface ExtractResult {
  title: string;
  spec_md: string;
}

// 可测试注入：跳过真实 LLM 调用
type ExtractFn = (prompt: string) => Promise<string>;
let _extractFn: ExtractFn = callClaudeForExtract;

export function _setExtractFnForTest(fn: ExtractFn | null): void {
  _extractFn = fn ?? callClaudeForExtract;
}

async function callClaudeForExtract(prompt: string): Promise<string> {
  const agent = buildClarifierAgent();
  const result = await agent.run(prompt, { system_prompt: EXTRACT_SYSTEM_PROMPT });
  return result.text ?? "";
}

/**
 * 一次性抽取 title + spec_md。永不抛——失败时走 raw_text 兜底。
 */
export async function runClarifierExtract(input: ExtractInput): Promise<ExtractResult> {
  const fallback: ExtractResult = {
    title: input.raw_text.slice(0, 30),
    spec_md: input.raw_text,
  };

  let raw: string;
  try {
    raw = await _extractFn(input.raw_text);
  } catch (e: unknown) {
    log.warn("extract LLM 调用失败，走兜底：%s", e instanceof Error ? e.message : String(e));
    return fallback;
  }

  let parsed: { title?: unknown; spec_md?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("extract LLM 返回非法 JSON，走兜底");
    return fallback;
  }

  if (typeof parsed.title !== "string" || !parsed.title.trim()) return fallback;
  if (typeof parsed.spec_md !== "string" || !parsed.spec_md.trim()) return fallback;

  return {
    title: parsed.title.trim().slice(0, 30),
    spec_md: parsed.spec_md.trim(),
  };
}
```

- [ ] **Step 4：跑测**

```
bun test tests/requirement-extract.test.ts
```
Expected: 4 pass

- [ ] **Step 5：commit**

```
git add src/daemon/requirement-extract.ts tests/requirement-extract.test.ts
git commit -m "feat(extract): runClarifierExtract + 兜底逻辑"
```

## Task 3：HTTP API POST /api/requirements/extract

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-extract-api.test.ts`

- [ ] **Step 1：写测**

写入 `tests/routes-extract-api.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { handleRequest } from "../src/daemon/routes";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { createProject, nextProjectId } from "../src/core/projects";
import { createCodebase, nextCodebaseId } from "../src/core/codebases";
import { _setExtractFnForTest } from "../src/daemon/requirement-extract";

let tmpHome: string;
let projectId: string;
let codebaseId: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-extract-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(
    join(tmpHome, "config.yaml"),
    "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n",
    "utf-8",
  );
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  projectId = nextProjectId();
  createProject({ id: projectId, name: "test" });
  codebaseId = nextCodebaseId();
  createCodebase({ id: codebaseId, project_id: projectId, alias: "cb", path: "/tmp/x" });
  _setExtractFnForTest(async () =>
    JSON.stringify({ title: "测试标题", spec_md: "## 背景\nx\n## 目标\ny\n## 验收\nz" }),
  );
});

afterEach(() => {
  _setDbForTest(null);
  _setExtractFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("POST /api/requirements/extract", () => {
  it("正常路径返回 title + spec_md", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "做个登录", project_id: projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("测试标题");
    expect(body.spec_md).toContain("## 背景");
  });

  it("缺 raw_text → 400", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("缺 project_id → 400", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("project_id 不存在 → 404", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x", project_id: "proj-999" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("codebase_id 不属于 project → 400", async () => {
    const otherProj = nextProjectId();
    createProject({ id: otherProj, name: "other" });
    const otherCb = nextCodebaseId();
    createCodebase({ id: otherCb, project_id: otherProj, alias: "cb2", path: "/tmp/y" });

    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x", project_id: projectId, codebase_id: otherCb }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("LLM 失败仍返回 200 + 兜底", async () => {
    _setExtractFnForTest(async () => {
      throw new Error("agent down");
    });
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "做个登录", project_id: projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("做个登录");
    expect(body.spec_md).toBe("做个登录");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/routes-extract-api.test.ts
```
Expected: 6 FAIL (404)

- [ ] **Step 3：实现路由**

定位 `// POST /api/requirements`（约 1240 行），在它**之前**插入：

```ts
    // POST /api/requirements/extract
    if (method === "POST" && path === "/api/requirements/extract") {
      const { runClarifierExtract } = await import("./requirement-extract");
      const { getProjectById } = await import("../core/projects");
      const { getCodebaseById } = await import("../core/codebases");
      const body = (await req.json().catch(() => null)) as
        | { raw_text?: string; project_id?: string; codebase_id?: string | null }
        | null;
      if (!body || typeof body.raw_text !== "string" || !body.raw_text.trim()) {
        return error("raw_text required", 400);
      }
      if (typeof body.project_id !== "string" || !body.project_id.trim()) {
        return error("project_id required", 400);
      }
      const proj = getProjectById(body.project_id);
      if (!proj) return error("project not found", 404);
      if (body.codebase_id) {
        const cb = getCodebaseById(body.codebase_id);
        if (!cb) return error("codebase not found", 404);
        if (cb.project_id !== body.project_id) {
          return error("codebase does not belong to project", 400);
        }
      }
      const result = await runClarifierExtract({
        raw_text: body.raw_text,
        project_id: body.project_id,
        codebase_id: body.codebase_id ?? null,
      });
      return json(result);
    }
```

- [ ] **Step 4：跑测**

```
bun test tests/routes-extract-api.test.ts
```
Expected: 6 pass

- [ ] **Step 5：commit**

```
git add src/daemon/routes.ts tests/routes-extract-api.test.ts
git commit -m "feat(daemon): POST /api/requirements/extract 抽取路由"
```

## Task 4：PR-1 全量验证

- [ ] **Step 1：跑全量**

```
bun test
bun run typecheck
```
Expected: 全过

- [ ] **Step 2：里程碑（长分支模式不切子分支）**

无 commit，纯校验。

---

# PR-2：Web /start 改造

预估半天，3 个 task。

## Task 5：useApi 加 extractRequirement

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1：在 api 对象内追加方法**

定位 `setupDismiss: () =>` 附近，在 `setupDismiss` 方法**之后**追加：

```ts
  extractRequirement: (input: { raw_text: string; project_id: string; codebase_id?: string | null }) =>
    request<{ title: string; spec_md: string }>("/api/requirements/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
```

- [ ] **Step 2：typecheck + commit**

```
bun run typecheck
git add src/web/src/hooks/useApi.ts
git commit -m "feat(web): useApi 加 extractRequirement"
```

## Task 6：Start.tsx 重写

**Files:**
- Modify: `src/web/src/pages/Start.tsx`

- [ ] **Step 1：整体替换文件内容**

把 `src/web/src/pages/Start.tsx` 完整替换为：

```tsx
import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api, type Project, type Codebase } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";

const CODEBASE_NONE = "__none__";

export function Start() {
  const navigate = useNavigate();
  const toast = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [codebases, setCodebases] = useState<Codebase[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingCodebases, setLoadingCodebases] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [codebaseId, setCodebaseId] = useState(CODEBASE_NONE);
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 进入页面：加载 projects，默认选第一个
  useEffect(() => {
    setLoadingProjects(true);
    api.listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setProjectId(ps[0].id);
      })
      .catch((e: unknown) => toast.error("加载项目失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoadingProjects(false));
  }, [toast]);

  // project 变化时拉 codebases
  useEffect(() => {
    if (!projectId) {
      setCodebases([]);
      setCodebaseId(CODEBASE_NONE);
      return;
    }
    setLoadingCodebases(true);
    api.listCodebases({ project_id: projectId })
      .then((cs) => {
        setCodebases(cs);
        setCodebaseId(CODEBASE_NONE);
      })
      .catch(() => setCodebases([]))
      .finally(() => setLoadingCodebases(false));
  }, [projectId]);

  const canSubmit = useMemo(
    () => !submitting && !!projectId && rawText.trim().length > 0,
    [submitting, projectId, rawText],
  );

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const cbId = codebaseId === CODEBASE_NONE ? null : codebaseId;
      const { title, spec_md } = await api.extractRequirement({
        raw_text: rawText.trim(),
        project_id: projectId,
        codebase_id: cbId,
      });
      const { requirement } = await api.createRequirement({
        project_id: projectId,
        codebase_id: cbId,
        title,
        spec_md,
      });
      navigate(`/requirements/${requirement.id}`);
    } catch (e: unknown) {
      toast.error("创建需求失败", (e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">开始 · START</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          说说你想做什么，AI 帮你整理成需求
        </p>
      </header>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project" className="font-mono text-[10px] uppercase tracking-[0.18em]">项目 *</Label>
          <Select value={projectId} onValueChange={setProjectId} disabled={loadingProjects || projects.length <= 1}>
            <SelectTrigger id="project">
              <SelectValue placeholder={loadingProjects ? "加载中..." : projects.length === 0 ? "暂无项目（请先在 /library 创建）" : "选择项目"} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} <span className="text-muted-foreground ml-2">{p.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="codebase" className="font-mono text-[10px] uppercase tracking-[0.18em]">代码库（可选）</Label>
          <Select value={codebaseId} onValueChange={setCodebaseId} disabled={!projectId || loadingCodebases}>
            <SelectTrigger id="codebase">
              <SelectValue placeholder={!projectId ? "请先选项目" : loadingCodebases ? "加载中..." : "不绑定代码库"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CODEBASE_NONE}>不绑定</SelectItem>
              {codebases.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.alias} <span className="text-muted-foreground ml-2">{c.path}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="raw" className="font-mono text-[10px] uppercase tracking-[0.18em]">说说你想做什么</Label>
          <textarea
            id="raw"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={12}
            placeholder="例如：给登录页加忘记密码功能。需要邮件重置..."
            className="w-full font-mono text-sm border-[1.5px] border-foreground/30 bg-background px-3 py-2 rounded-none focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="default"
            size="default"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {submitting ? "AI 整理中..." : "生成需求 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2：typecheck + build:web**

```
bun run typecheck
bun run build:web
```
Expected: 全过（注意 `api.listCodebases` 的实际签名——可能不接受 `{ project_id }` 对象参数；如签名是 `(projectId: string)` 改成对应形式）

如果 `listCodebases` 签名与 `{ project_id: projectId }` 不匹配，按实际签名调整。

- [ ] **Step 3：commit**

```
git add src/web/src/pages/Start.tsx
git commit -m "feat(web): /start 改对话式抽取（删表单 + 删 chat 入口卡）"
```

## Task 7：PR-2 全量验证

- [ ] **Step 1：build:web + 全量测试**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过

- [ ] **Step 2：浏览器手测（可选）**

启 `autopilot daemon start`，访问 `/start`：
- 选 project（自动选第一个）
- 写一段描述
- 点「生成需求」
- 应跳到 `/requirements/<新 id>` 且 clarifier 进入调查阶段

---

# PR-3：CLI req new

预估 1 天，6 个 task。

## Task 8：requirements-cli.ts 骨架 + `--from-prompt`

**Files:**
- Create: `src/cli/requirements-cli.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli-req-new.test.ts`

- [ ] **Step 1：写测**

写入 `tests/cli-req-new.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-req-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
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

describe("autopilot req new", () => {
  it("daemon 未启时提示并退出码 ≠ 0", () => {
    runCli("init");
    const r = runCli("req", "new", "--from-prompt", "test");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("帮助文本含 --from-prompt / -f / --no-extract", () => {
    runCli("init");
    const r = runCli("req", "new", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--from-prompt");
    expect(r.stdout).toContain("-f");
    expect(r.stdout).toContain("--no-extract");
  });
});
```

- [ ] **Step 2：跑测看挂**

```
bun test tests/cli-req-new.test.ts
```
Expected: FAIL（req 命令未注册）

- [ ] **Step 3：实现骨架**

写入 `src/cli/requirements-cli.ts`：

```ts
import type { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { AutopilotClient, DEFAULT_PORT } from "../client/index";
import { readListenInfo } from "../daemon/pid";

interface ReqNewOpts {
  fromPrompt?: string;
  file?: string;
  project?: string;
  codebase?: string;
  noExtract?: boolean;
  port: string;
}

function getClient(port: string): AutopilotClient {
  if (port !== String(DEFAULT_PORT)) {
    return new AutopilotClient({ port: parseInt(port, 10) });
  }
  const info = readListenInfo();
  return new AutopilotClient({ port: info?.port ?? DEFAULT_PORT });
}

async function ensureDaemon(client: AutopilotClient): Promise<void> {
  try {
    await client.getStatus();
  } catch {
    console.error("错误：无法连接到 daemon。请先运行 `autopilot daemon start`。");
    process.exit(3);
  }
}

export function registerRequirementCommands(program: Command): void {
  const req = program.command("req").description("需求管理");

  req
    .command("new")
    .description("创建需求（AI 帮你整理标题+描述）")
    .option("--from-prompt <text>", "直接传一段描述，跳过交互输入")
    .option("-f, --file <path>", "从文件读取描述（Markdown）")
    .option("-p, --project <id>", "指定 project id（默认取最近活跃）")
    .option("-c, --codebase <id>", "指定 codebase id（可空）")
    .option("--no-extract", "跳过 AI 抽取，title=前 30 字、spec_md=原文")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(async (opts: ReqNewOpts) => {
      const client = getClient(opts.port);
      await ensureDaemon(client);

      // 1) 拿 raw_text
      let rawText: string | null = null;
      if (opts.fromPrompt) {
        rawText = opts.fromPrompt;
      } else if (opts.file) {
        if (!existsSync(opts.file)) {
          console.error(`错误：文件不存在：${opts.file}`);
          process.exit(2);
        }
        rawText = readFileSync(opts.file, "utf-8");
      } else {
        // 交互模式在 Task 10 实现
        console.error("交互模式尚未实现，请用 --from-prompt 或 -f");
        process.exit(1);
      }
      if (!rawText.trim()) {
        console.error("错误：描述不能为空");
        process.exit(1);
      }

      // 2) 解析 project / codebase（Task 11 增加 cwd 推断 + 默认逻辑）
      const projectId = opts.project;
      if (!projectId) {
        console.error("错误：暂未实现默认 project 推断，请用 -p <id>");
        process.exit(2);
      }
      const codebaseId = opts.codebase;

      // 3) 抽取或兜底
      let title: string, specMd: string;
      if (opts.noExtract) {
        title = rawText.trim().slice(0, 30);
        specMd = rawText;
      } else {
        try {
          const r = await client.extractRequirement({
            raw_text: rawText,
            project_id: projectId,
            codebase_id: codebaseId ?? null,
          });
          title = r.title;
          specMd = r.spec_md;
        } catch (e: unknown) {
          console.error(`抽取失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      }

      // 4) 建 requirement
      try {
        const { requirement } = await client.createRequirement({
          project_id: projectId,
          codebase_id: codebaseId ?? null,
          title,
          spec_md: specMd,
        });
        console.log(`✓ 已创建需求 ${requirement.id} (clarifier 调查中)`);
      } catch (e: unknown) {
        console.error(`创建需求失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
      }
    });
}
```

注意：`client.extractRequirement` 和 `client.createRequirement` 是新方法，需要在 Task 9 加。先让 typecheck 跑通这一步可能需要临时 `as any` 或者直接在 Task 9 一起做。

为避免半成品，**Task 8 和 Task 9 合成一次**实施——先实现 client method 再实现 CLI。我们把这步重新组织：

- [ ] **Step 4：先实现 client method（Task 9 内容前置）**

定位 `src/client/index.ts`（或 `src/client/http.ts`）现有 createRequirement 实现：

```
grep -n "createRequirement\|class AutopilotClient" src/client/index.ts src/client/http.ts 2>&1 | head
```

如果 `createRequirement` 已存在（应该已存在，因 Web 用它），则只需加 `extractRequirement`。在 `AutopilotClient` 类内或 client.ts 内追加：

```ts
async extractRequirement(input: {
  raw_text: string;
  project_id: string;
  codebase_id?: string | null;
}): Promise<{ title: string; spec_md: string }> {
  return this.post<{ title: string; spec_md: string }>("/api/requirements/extract", input);
}
```

（具体 `this.post` 形式按 client.ts 实际接口调整——可能是 `request("POST", url, body)`）

- [ ] **Step 5：注册到 cli/index.ts**

import 区追加：

```ts
import { registerRequirementCommands } from "./requirements-cli";
```

在 `registerConfigCommands(program);` 之后追加：

```ts
registerRequirementCommands(program);
```

- [ ] **Step 6：跑测**

```
bun test tests/cli-req-new.test.ts
bun run typecheck
```
Expected: 2 pass

- [ ] **Step 7：commit**

```
git add src/cli/requirements-cli.ts src/cli/index.ts src/client/index.ts tests/cli-req-new.test.ts
git commit -m "feat(cli): req new 骨架（--from-prompt / -f / --no-extract）"
```

## Task 9：默认 project 推断（最近活跃）

**Files:**
- Modify: `src/cli/requirements-cli.ts`
- Modify: `tests/cli-req-new.test.ts`

- [ ] **Step 1：在测试里 stub 一个 project 然后跑 --from-prompt 不传 -p**

由于 CLI 测试通过 spawn 子进程，没法直接在测试进程内 `_setDbForTest`。我们要在跑 CLI 前先 `init` + 用 daemon API 建 project，然后调 req new 不传 -p——这需要 daemon 在跑。

跨进程 + daemon 起停在测试里比较重，本 task **跳过子进程测试**，改在 implementation 完成后用单元测试覆盖默认推断函数。

- [ ] **Step 2：抽 helper 函数加单测**

在 `src/cli/requirements-cli.ts` 内导出 helper：

```ts
import type { AutopilotClient } from "../client/index";

/** 推断默认 project：最近活跃的（有 requirement 的） → 否则 listProjects[0] → 否则 null */
export async function inferDefaultProjectId(client: AutopilotClient): Promise<string | null> {
  const projects = await client.listProjects();
  if (projects.length === 0) return null;
  // 简化版：第一个；后续可加 "最近活跃" 逻辑（按 requirements.updated_at desc 排序）
  return projects[0].id;
}
```

修改 action：

```ts
      // 2) 解析 project / codebase
      let projectId = opts.project;
      if (!projectId) {
        const inferred = await inferDefaultProjectId(client);
        if (!inferred) {
          console.error("错误：未找到任何 project。请先在 web /library 或 CLI 创建。");
          process.exit(2);
        }
        projectId = inferred;
        console.log(`✓ 默认 project: ${projectId}`);
      }
```

- [ ] **Step 3：commit**

```
git add src/cli/requirements-cli.ts
git commit -m "feat(cli): req new 默认 project 推断"
```

## Task 10：交互模式（多行 stdin）

**Files:**
- Modify: `src/cli/requirements-cli.ts`

- [ ] **Step 1：实现 readRawTextInteractive**

参考 `src/cli/config-fix.ts` 的 pipe vs TTY 双模式 stdin 读取。在 `requirements-cli.ts` 加：

```ts
/**
 * 交互式读取多行描述。
 * - TTY 模式：用 readline，用户输入空行 + Ctrl+D（POSIX）或 Ctrl+Z+Enter（Windows）结束
 * - Pipe 模式：一次性读完全部 stdin
 * 参考 src/cli/config-fix.ts。
 */
async function readRawTextInteractive(): Promise<string> {
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) {
    // pipe 模式：读 stdin 全部
    return await new Response(process.stdin as unknown as ReadableStream).text();
  }
  // TTY 模式：readline 多行收集
  const { createInterface } = await import("node:readline");
  console.log("请描述你要做什么（多行；空行 + 回车结束）：");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines: string[] = [];
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line === "" && lines.length > 0) {
        rl.close();
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => resolve(lines.join("\n")));
  });
}
```

修改 action 里 raw_text 获取分支：

```ts
      } else {
        rawText = await readRawTextInteractive();
      }
```

- [ ] **Step 2：手测**

```
echo "做个登录页" | bun run dev req new -p proj-001
```
Expected: 不挂、能创建

- [ ] **Step 3：commit**

```
git add src/cli/requirements-cli.ts
git commit -m "feat(cli): req new 交互模式多行 stdin 读取"
```

## Task 11：cwd 推断 codebase

**Files:**
- Modify: `src/cli/requirements-cli.ts`

- [ ] **Step 1：写测**

追加到 `tests/cli-req-new.test.ts`：

```ts
import { inferCodebaseFromCwd } from "../src/cli/requirements-cli";

describe("inferCodebaseFromCwd", () => {
  const codebases = [
    { id: "cb-1", path: "/home/u/proj", project_id: "p", alias: "a", default_branch: "main", github_owner: null, github_repo: null, parent_codebase_id: null, submodule_path: null, created_at: 0, updated_at: 0 } as never,
    { id: "cb-2", path: "/home/u/proj/sub", project_id: "p", alias: "b", default_branch: "main", github_owner: null, github_repo: null, parent_codebase_id: null, submodule_path: null, created_at: 0, updated_at: 0 } as never,
  ];

  it("cwd 在嵌套 codebase 里选最长 match", () => {
    expect(inferCodebaseFromCwd(codebases, "/home/u/proj/sub/x")).toBe("cb-2");
  });

  it("cwd 不匹配任何 codebase 返回 null", () => {
    expect(inferCodebaseFromCwd(codebases, "/var/other")).toBeNull();
  });

  it("无 codebase 返回 null", () => {
    expect(inferCodebaseFromCwd([], "/anywhere")).toBeNull();
  });
});
```

- [ ] **Step 2：实现**

在 `requirements-cli.ts` 加：

```ts
import type { Codebase } from "../core/codebases";

/** 选 path 是 cwd 前缀的最长 match。 */
export function inferCodebaseFromCwd(codebases: Codebase[], cwd: string = process.cwd()): string | null {
  const normalize = (p: string) => p.replace(/[\\/]+$/, "");
  const ncwd = normalize(cwd);
  const matches = codebases.filter((c) => ncwd.startsWith(normalize(c.path)));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.path.length - a.path.length)[0]!.id;
}
```

在 action 里 `codebaseId` 解析处加：

```ts
      let codebaseId = opts.codebase;
      if (!codebaseId && projectId) {
        const allCbs = await client.listCodebases({ project_id: projectId });
        const inferred = inferCodebaseFromCwd(allCbs);
        if (inferred) {
          codebaseId = inferred;
          console.log(`✓ 默认 codebase: ${codebaseId}（从 cwd 推断）`);
        }
      }
```

（若 `client.listCodebases` 实际签名与 `{ project_id }` 不一致，按实际改）

- [ ] **Step 3：跑测**

```
bun test tests/cli-req-new.test.ts
```
Expected: 5 pass

- [ ] **Step 4：commit**

```
git add src/cli/requirements-cli.ts tests/cli-req-new.test.ts
git commit -m "feat(cli): req new cwd 推断默认 codebase"
```

## Task 12：PR-3 全量验证 + 顺手清理

**Files:**
- 验证全量；如 Web 仍存在残留代码（如旧 Start.tsx 的 lucide 图标 import 但未用），清掉

- [ ] **Step 1：全量**

```
bun test
bun run typecheck
bun run build:web
```
Expected: 全过

- [ ] **Step 2：检查 Start.tsx 的 import 没有未使用项**

```
bun run typecheck 2>&1 | grep -i "declared but never used\|unused"
```
按提示清掉。

- [ ] **Step 3：如无清理需要直接进 PR**

```
git push -u origin <分支名（按用户分支策略）>
gh pr create --base main --title "feat(req-onboarding): 对话式提需求（extract + clarifier 接管）" --body "依据 spec docs/superpowers/specs/2026-05-14-requirement-extract-onboarding-design.md 实施。三个 PR 块合并到单分支：core extract + HTTP API、Web /start 重写、CLI req new。"
```

---

## 全流程 dogfood

```bash
# 1) Web
autopilot daemon start
# 浏览器：http://127.0.0.1:6180/start
# 选项目 → 写描述 → 点生成 → 应跳 /requirements/<id>

# 2) CLI 三模式
bun run dev req new --from-prompt "给登录页加忘记密码" -p proj-001
echo "需求 X..." | bun run dev req new -p proj-001
bun run dev req new -f ./req.md -p proj-001
bun run dev req new --no-extract --from-prompt "raw text" -p proj-001
```

每条应建出 requirement 且 clarifier 自动调查。
