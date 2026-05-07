# 工作流动态管理 W2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 W 系列 CLI 层 — 把 W1 的 DB 工作流能力暴露为 REST API + CLI 子命令，让用户能通过命令行 list / show / create / edit / delete / export / import DB 工作流。

**Architecture:**
- `src/daemon/routes.ts` 扩展：GET 端点附带 source / derives_from 字段；POST 加 derives_from 走 DB 路径；DELETE 区分 source；PUT yaml 区分 source 写到 DB 或文件。
- `src/cli/workflow.ts` 新文件，承载 `autopilot workflow` 子命令组。
- 现有 `workflow list` 命令保留并扩展输出（带 source 列）。
- 不破坏 Web UI 现有能力（保留 file yaml 通过 API 编辑、写到 disk 的旧行为）。

**Tech Stack:** Bun + TypeScript，Commander，bun:test。

---

## File Structure

**Modify:**
- `src/daemon/routes.ts` — 改造 5 个 workflow 端点 + 新增 export 端点
- `src/cli/index.ts` — 抽出 workflow 子命令到独立文件
- `src/client/http.ts`（如有）/ `src/web/src/hooks/useApi.ts` — 类型扩展（仅类型 + Web 列表的 source 显示）

**Create:**
- `src/cli/workflow.ts` — workflow 子命令组（list / show / create / edit / delete / export / import）
- `tests/routes-workflow-api.test.ts` — API 集成测试
- `tests/cli-workflow.test.ts` —（可选）CLI 行为简单冒烟测试

---

## Task 1：routes.ts 端点改造

**Files:**
- Modify: `src/daemon/routes.ts`
- Create: `tests/routes-workflow-api.test.ts`

**改造点：**
1. `GET /api/workflows` 返回数组里附带 `source / derives_from`（从 `listWorkflowsInDb` 拿）
2. `GET /api/workflows/:name` 响应附带 `source / derives_from`
3. `POST /api/workflows` 新增可选 `derives_from + yaml_content` 字段：
   - 有 derives_from → 走 `createDbWorkflow(...)` + reload
   - 无 derives_from → 现有 `createWorkflow` 文件脚手架行为
4. `DELETE /api/workflows/:name` 区分：
   - DB 中 source=db → `deleteDbWorkflow(name)` + reload
   - 否则走现有 `deleteWorkflowDir`
5. `PUT /api/workflows/:name/yaml` 区分：
   - DB 中 source=db → `updateDbWorkflow(name, { yaml_content })` + reload
   - 否则现有 `saveWorkflowYaml` 写文件 + reload
6. **新增** `GET /api/workflows/:name/export` — 只返回纯 yaml 文本（`Content-Type: text/yaml`）

- [ ] **Step 1：写失败测试**

新建 `tests/routes-workflow-api.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover } from "../src/core/registry";
import { createDbWorkflow } from "../src/core/workflows";
import { handleRequest } from "../src/daemon/routes";

describe("workflows API（W2 扩展）", () => {
  let tmpHome: string;
  let db: Database;

  beforeAll(() => {
    // setup 一次：创建 tmp home + base 文件工作流
    tmpHome = join(tmpdir(), `autopilot-w2-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows", "req_dev"), { recursive: true });
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.yaml"),
      `name: req_dev\nphases:\n  - name: design\n    timeout: 60\n  - name: develop\n    timeout: 60\n`
    );
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.ts"),
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    process.env.AUTOPILOT_HOME = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    delete process.env.AUTOPILOT_HOME;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.run("DELETE FROM workflows");
    _clearRegistry();
    await discover();
  });

  it("GET /api/workflows 响应包含 source / derives_from", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; source: string; derives_from: string | null }>;
    const reqDev = body.find((w) => w.name === "req_dev");
    expect(reqDev).toBeDefined();
    expect(reqDev!.source).toBe("file");
    expect(reqDev!.derives_from).toBeNull();
  });

  it("POST /api/workflows 带 derives_from 创建 DB 工作流", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "req_dev_fast",
          description: "skip review",
          derives_from: "req_dev",
          yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; name: string; source: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("req_dev_fast");
    expect(body.source).toBe("db");
  });

  it("POST /api/workflows derives_from 不存在的 base → 400", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "wf_x",
          derives_from: "no_such",
          yaml_content: "name: wf_x\nphases: []\n",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("PUT /api/workflows/:name/yaml 修改 DB 工作流走 updateDbWorkflow", async () => {
    createDbWorkflow({
      name: "wf_db",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_db\nphases:\n  - name: design\n",
    });
    _clearRegistry();
    await discover();

    const newYaml = "name: wf_db\nphases:\n  - name: design\n  - name: develop\n";
    const res = await handleRequest(
      new Request("http://localhost/api/workflows/wf_db/yaml", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: newYaml }),
      })
    );
    expect(res.status).toBe(200);

    // 验证 DB 里 yaml 真的改了
    const getRes = await handleRequest(new Request("http://localhost/api/workflows/wf_db/yaml"));
    const body = (await getRes.json()) as { yaml: string };
    expect(body.yaml).toBe(newYaml);
  });

  it("DELETE /api/workflows/:name 删 DB 工作流", async () => {
    createDbWorkflow({
      name: "wf_to_delete",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_to_delete\nphases: []\n",
    });
    _clearRegistry();
    await discover();

    const res = await handleRequest(
      new Request("http://localhost/api/workflows/wf_to_delete", { method: "DELETE" })
    );
    expect(res.status).toBe(200);

    const getRes = await handleRequest(new Request("http://localhost/api/workflows/wf_to_delete"));
    expect(getRes.status).toBe(404);
  });

  it("GET /api/workflows/:name/export 返回纯 yaml 文本", async () => {
    createDbWorkflow({
      name: "wf_export",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_export\nphases:\n  - name: design\n",
    });
    _clearRegistry();
    await discover();

    const res = await handleRequest(new Request("http://localhost/api/workflows/wf_export/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml|text/);
    const text = await res.text();
    expect(text).toContain("name: wf_export");
  });

  it("GET /api/workflows/:name/export 文件来源也支持", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/req_dev/export"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("name: req_dev");
  });

  it("GET /api/workflows/:name/export 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/no_such/export"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/routes-workflow-api.test.ts
```
预期：多用例 FAIL。

- [ ] **Step 3：改造 src/daemon/routes.ts**

(a) 文件顶部 import 区追加（如已有合并）：
```ts
import {
  listWorkflowsInDb,
  getWorkflowFromDb,
  createDbWorkflow,
  updateDbWorkflow,
  deleteDbWorkflow,
} from "../core/workflows";
```

(b) **改 `GET /api/workflows`**（在路由分支里找到）：

```ts
// GET /api/workflows
if (method === "GET" && path === "/api/workflows") {
  const inMem = listWorkflows();             // registry 内存里的（含描述）
  const dbRows = listWorkflowsInDb();         // DB 的来源 + derives_from
  const sourceMap = new Map(dbRows.map((r) => [r.name, r]));
  const result = inMem.map((wf) => {
    const row = sourceMap.get(wf.name);
    return {
      ...wf,
      source: row?.source ?? "file",
      derives_from: row?.derives_from ?? null,
    };
  });
  return json(result);
}
```

(c) **改 `POST /api/workflows`**：

```ts
// POST /api/workflows — 创建工作流
if (method === "POST" && path === "/api/workflows") {
  const body = await req.json() as {
    name?: string;
    description?: string;
    firstPhase?: string;
    derives_from?: string;
    yaml_content?: string;
  };
  if (typeof body.name !== "string" || !body.name) return error("name is required");

  // 带 derives_from → 创建 DB 工作流
  if (body.derives_from) {
    if (typeof body.yaml_content !== "string") {
      return error("derives_from 模式下 yaml_content 必填");
    }
    try {
      const wf = createDbWorkflow({
        name: body.name,
        description: body.description ?? "",
        derives_from: body.derives_from,
        yaml_content: body.yaml_content,
      });
      await reload();
      emit({ type: "workflow:reloaded", payload: {} });
      return json({ ok: true, name: wf.name, source: wf.source }, 201);
    } catch (e: unknown) {
      return error(`创建失败：${e instanceof Error ? e.message : String(e)}`, 400);
    }
  }

  // 否则走原文件脚手架
  try {
    const result = createWorkflow({
      name: body.name,
      description: body.description,
      firstPhase: body.firstPhase,
    });
    await reload();
    emit({ type: "workflow:reloaded", payload: {} });
    return json({ ok: true, name: body.name, source: "file", dir: result.dir }, 201);
  } catch (e: unknown) {
    return error(`创建失败：${e instanceof Error ? e.message : String(e)}`, 400);
  }
}
```

(d) **改 `DELETE /api/workflows/:name`**：

```ts
const wfDeleteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)$/);
if (method === "DELETE" && wfDeleteMatch) {
  const row = getWorkflowFromDb(wfDeleteMatch);
  // DB 工作流走 deleteDbWorkflow
  if (row && row.source === "db") {
    try {
      deleteDbWorkflow(wfDeleteMatch);
      await reload();
      emit({ type: "workflow:reloaded", payload: {} });
      return json({ ok: true });
    } catch (e: unknown) {
      return error(`删除失败：${e instanceof Error ? e.message : String(e)}`, 400);
    }
  }
  // 文件来源走原文件目录删除
  try {
    const ok = deleteWorkflowDir(wfDeleteMatch);
    if (!ok) return error("Workflow not found", 404);
    await reload();
    emit({ type: "workflow:reloaded", payload: {} });
    return json({ ok: true });
  } catch (e: unknown) {
    return error(`删除失败：${e instanceof Error ? e.message : String(e)}`, 400);
  }
}
```

(e) **改 `PUT /api/workflows/:name/yaml`**：

```ts
const yamlWriteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
if (method === "PUT" && yamlWriteMatch) {
  const body = await req.json() as { yaml: string };
  if (typeof body.yaml !== "string") return error("yaml field is required");

  const row = getWorkflowFromDb(yamlWriteMatch);
  if (row && row.source === "db") {
    try {
      updateDbWorkflow(yamlWriteMatch, { yaml_content: body.yaml });
      await reload();
      emit({ type: "workflow:reloaded", payload: {} });
      return json({ ok: true });
    } catch (e: unknown) {
      return error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // file 来源 → 写文件（保持原行为）
  try {
    saveWorkflowYaml(yamlWriteMatch, body.yaml);
    await reload();
    emit({ type: "workflow:reloaded", payload: {} });
    return json({ ok: true });
  } catch (e: unknown) {
    return error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

(f) **改 `GET /api/workflows/:name/yaml`**（让 db 工作流也能拿到 yaml）：

```ts
const yamlReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
if (method === "GET" && yamlReadMatch) {
  const row = getWorkflowFromDb(yamlReadMatch);
  if (row && row.source === "db") {
    return json({ yaml: row.yaml_content });
  }
  const yaml = getWorkflowYaml(yamlReadMatch);
  if (yaml === null) return error("Workflow not found", 404);
  return json({ yaml });
}
```

(g) **改 `GET /api/workflows/:name`**：在响应 `{ ...safe, phases: safePhasesArr }` 上附加 source/derives_from：

```ts
const wfMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)$/);
if (method === "GET" && wfMatch) {
  const wf = getWorkflow(wfMatch);
  if (!wf) return error("Workflow not found", 404);
  const { setup_func, notify_func, ...safe } = wf;
  const safePhasesArr = safe.phases.map((p: any) => {
    if ("parallel" in p) {
      return {
        parallel: {
          ...p.parallel,
          phases: p.parallel.phases.map((sub: any) => {
            const { func, ...rest } = sub;
            return rest;
          }),
        },
      };
    }
    const { func, ...rest } = p;
    return rest;
  });
  const row = getWorkflowFromDb(wfMatch);
  return json({
    ...safe,
    phases: safePhasesArr,
    source: row?.source ?? "file",
    derives_from: row?.derives_from ?? null,
  });
}
```

(h) **新增 `GET /api/workflows/:name/export`**（在 yaml 端点附近加）：

```ts
const exportMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/export$/);
if (method === "GET" && exportMatch) {
  const row = getWorkflowFromDb(exportMatch);
  let yaml: string | null = null;
  if (row && row.source === "db") {
    yaml = row.yaml_content;
  } else {
    yaml = getWorkflowYaml(exportMatch);
  }
  if (yaml === null) return error("Workflow not found", 404);
  return new Response(yaml, {
    status: 200,
    headers: { "Content-Type": "text/yaml; charset=utf-8" },
  });
}
```

注意：`exportMatch` 的路由必须放在 `/api/workflows/:name` 通配前面（避免被吃掉）。

- [ ] **Step 4：跑测试**

```bash
bun test tests/routes-workflow-api.test.ts
bun run typecheck
```
预期：8 用例 pass。

- [ ] **Step 5：跑全套**

```bash
bun test
```

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w2-20260507
git add src/daemon/routes.ts tests/routes-workflow-api.test.ts
git commit -m "feat(api): workflows 端点扩展 — source/derives_from + DB 创建/删除/编辑"
```

---

## Task 2：CLI workflow 子命令组

**Files:**
- Create: `src/cli/workflow.ts`
- Modify: `src/cli/index.ts`

**目标：**
- 抽出现有 `workflow list` 到独立文件
- 新增 `show / create / edit / delete / export / import` 共 6 个子命令
- `edit` 调 `$EDITOR`（缺省 `vim` / Windows `notepad`）

由于 CLI 行为很难严格 unit test（需要 spawn 真 daemon），**不写 CLI 单测**；本任务靠 typecheck + 手工 e2e（plan 末尾给步骤）保证。

- [ ] **Step 1：抽 + 实现 src/cli/workflow.ts**

新建 `src/cli/workflow.ts`：

```ts
import { Command } from "commander";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AutopilotClient } from "../client";

export interface WorkflowCmdContext {
  getClient: (opts: { port: string }) => AutopilotClient;
  ensureDaemon: (client: AutopilotClient) => Promise<void>;
  defaultPort: number;
}

interface WorkflowItem {
  name: string;
  description?: string;
  source?: "db" | "file";
  derives_from?: string | null;
}

/**
 * 注册 autopilot workflow 子命令组。
 * （由 src/cli/index.ts 调用）
 */
export function registerWorkflowCommands(program: Command, ctx: WorkflowCmdContext): void {
  const wf = program.command("workflow").description("工作流管理");

  // ── list ──
  wf.command("list")
    .description("列出已注册工作流（含 source / derives_from）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      const list = (await client.listWorkflows()) as WorkflowItem[];
      if (list.length === 0) {
        console.log("暂无已注册工作流。");
        return;
      }
      console.log(`已注册工作流（共 ${list.length} 个）：\n`);
      const namePad = Math.max(...list.map((w) => w.name.length), 4);
      const srcPad = 6;
      console.log(
        "  " +
          "NAME".padEnd(namePad) +
          "  " +
          "SOURCE".padEnd(srcPad) +
          "  " +
          "DERIVES_FROM   DESCRIPTION"
      );
      for (const w of list) {
        const src = (w.source ?? "file").padEnd(srcPad);
        const derives = (w.derives_from ?? "-").padEnd(14);
        const desc = w.description ?? "";
        console.log("  " + w.name.padEnd(namePad) + "  " + src + "  " + derives + " " + desc);
      }
    });

  // ── show ──
  wf.command("show <name>")
    .description("查看单个工作流（yaml + 元信息）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const meta = (await client.getWorkflow(name)) as WorkflowItem & {
          phases?: unknown[];
        };
        const yaml = (await client.getWorkflowYaml(name)) as { yaml: string };
        console.log(`# ${meta.name}`);
        console.log(`source: ${meta.source ?? "file"}`);
        if (meta.derives_from) console.log(`derives_from: ${meta.derives_from}`);
        if (meta.description) console.log(`description: ${meta.description}`);
        console.log("\n--- yaml ---\n");
        console.log(yaml.yaml);
      } catch (e: unknown) {
        console.error(`查询失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── create ──
  wf.command("create <name>")
    .description("创建 DB 工作流（必须 --derives-from 一个 file 工作流）")
    .requiredOption("--derives-from <base>", "派生自的 file 工作流名（如 req_dev）")
    .option("--from <yaml-file>", "初始 yaml 文件路径；不传则用 base 的 yaml 进 EDITOR 编辑")
    .option("-d, --description <desc>", "工作流描述", "")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: {
      derivesFrom: string;
      from?: string;
      description: string;
      port: string;
    }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);

      let yaml: string;
      if (opts.from) {
        try {
          yaml = readFileSync(opts.from, "utf8");
        } catch (e: unknown) {
          console.error(`读 ${opts.from} 失败：${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      } else {
        // 用 base 的 yaml 起编辑
        const baseYaml = (await client.getWorkflowYaml(opts.derivesFrom)) as { yaml: string };
        yaml = await editInTempFile(baseYaml.yaml);
      }

      try {
        const result = (await client.createWorkflow({
          name,
          description: opts.description,
          derives_from: opts.derivesFrom,
          yaml_content: yaml,
        })) as { name: string; source: string };
        console.log(`✓ 已创建 ${result.source} 工作流 ${result.name}`);
      } catch (e: unknown) {
        console.error(`创建失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── edit ──
  wf.command("edit <name>")
    .description("用 EDITOR 编辑工作流的 yaml（仅 source=db 可改）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const cur = (await client.getWorkflowYaml(name)) as { yaml: string };
        const newYaml = await editInTempFile(cur.yaml);
        if (newYaml === cur.yaml) {
          console.log("内容未变，跳过保存。");
          return;
        }
        await client.saveWorkflowYaml(name, newYaml);
        console.log(`✓ 已保存 ${name}`);
      } catch (e: unknown) {
        console.error(`编辑失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── delete ──
  wf.command("delete <name>")
    .description("删除工作流（仅 source=db 可删）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        await client.deleteWorkflow(name);
        console.log(`✓ 已删除 ${name}`);
      } catch (e: unknown) {
        console.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── export ──
  wf.command("export <name>")
    .description("把工作流的 yaml 输出到 stdout（用于备份 / 重定向到文件）")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: { port: string }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      try {
        const yaml = await client.exportWorkflow(name);
        process.stdout.write(yaml);
      } catch (e: unknown) {
        console.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // ── import ──
  wf.command("import <name>")
    .description("从 yaml 文件创建 DB 工作流")
    .requiredOption("--derives-from <base>", "派生自的 file 工作流名")
    .requiredOption("--from <yaml-file>", "yaml 文件路径")
    .option("-d, --description <desc>", "工作流描述", "")
    .option("-p, --port <port>", "daemon 端口", String(ctx.defaultPort))
    .action(async (name: string, opts: {
      derivesFrom: string;
      from: string;
      description: string;
      port: string;
    }) => {
      const client = ctx.getClient(opts);
      await ctx.ensureDaemon(client);
      let yaml: string;
      try {
        yaml = readFileSync(opts.from, "utf8");
      } catch (e: unknown) {
        console.error(`读 ${opts.from} 失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      try {
        await client.createWorkflow({
          name,
          description: opts.description,
          derives_from: opts.derivesFrom,
          yaml_content: yaml,
        });
        console.log(`✓ 已导入 ${name}（派生自 ${opts.derivesFrom}）`);
      } catch (e: unknown) {
        console.error(`导入失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

/**
 * 把内容写到临时文件，启动 $EDITOR（缺省 vim / Windows notepad），等用户保存退出后读回。
 */
async function editInTempFile(initial: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "autopilot-edit-"));
  const tmpFile = join(tmpDir, "workflow.yaml");
  writeFileSync(tmpFile, initial, "utf8");
  const editor =
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "vim");
  const result = spawnSync(editor, [tmpFile], { stdio: "inherit" });
  if (result.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`EDITOR ${editor} 退出码 ${result.status}`);
  }
  const content = readFileSync(tmpFile, "utf8");
  rmSync(tmpDir, { recursive: true, force: true });
  return content;
}
```

注意：`AutopilotClient` 类型需要在 client 模块里有以下方法：
- `listWorkflows() → WorkflowItem[]`（已有）
- `getWorkflow(name) → WorkflowItem`（已有）
- `getWorkflowYaml(name) → { yaml }`（已有）
- `saveWorkflowYaml(name, yaml) → ...`（已有）
- `deleteWorkflow(name)`（已有）
- `createWorkflow({ name, description, derives_from, yaml_content })`（**已有，但 W2 加 derives_from / yaml_content 字段**）
- `exportWorkflow(name) → string`（**新增**）

如果 client 缺这些方法，**先补 client 类型** —— 见 Step 2。

- [ ] **Step 2：扩展 client（src/client/http.ts 或 web/src/hooks/useApi.ts，看实际位置）**

W1 时已经看过 `src/client/` 目录。在 client 实现里把 `createWorkflow` 的 body 类型加上可选 `derives_from / yaml_content`，并新增 `exportWorkflow`：

打开 `src/client/http.ts`（如果存在）或 `src/client/index.ts` 找到 `createWorkflow`，扩展 body 类型；加新方法 `exportWorkflow(name): Promise<string>` —— 调 `GET /api/workflows/:name/export` 返回纯 text。

如果 client 是被 daemon Web UI 共享的（`src/web/src/hooks/useApi.ts`），同步那边的类型扩展。

代码骨架：
```ts
async createWorkflow(body: {
  name: string;
  description?: string;
  firstPhase?: string;
  derives_from?: string;
  yaml_content?: string;
}): Promise<{ ok: boolean; name: string; source?: string; dir?: string }> {
  return this.post("/api/workflows", body);
}

async exportWorkflow(name: string): Promise<string> {
  const res = await fetch(`${this.baseUrl}/api/workflows/${name}/export`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
```

实施时按你 client 的真实风格调整（fetch / text / 错误处理）。

- [ ] **Step 3：在 src/cli/index.ts 注册新命令组**

打开 `src/cli/index.ts`，找到现有的 `workflow` command 定义（line ~501）。把整段 workflow command 块**删除**，替换为 import + 注册：

文件顶部 import 加：
```ts
import { registerWorkflowCommands } from "./workflow";
```

在原 `const workflow = program.command(...)` 那段删掉，改成：
```ts
registerWorkflowCommands(program, {
  getClient,
  ensureDaemon,
  defaultPort: DEFAULT_PORT,
});
```

确保 `getClient / ensureDaemon / DEFAULT_PORT` 在 src/cli/index.ts 中可见（已有的 helpers）。

- [ ] **Step 4：typecheck**

```bash
bun run typecheck
```
预期：0 错。如果 client 类型不匹配，按真实定义调整 cli/workflow.ts 中的类型声明。

- [ ] **Step 5：手工冒烟（可选，需 daemon 在跑）**

```bash
# 启动 daemon（如果没开）
autopilot daemon status

# list 看现有工作流（应该看到 source / derives_from 列）
autopilot workflow list

# show 现有 file 工作流
autopilot workflow show req_dev

# 创建 db 工作流（需要 EDITOR）
autopilot workflow create req_dev_test --derives-from req_dev --description "测试派生"
# 编辑器打开 → 改下 phases → 保存退出

# list 应该看到 req_dev_test
autopilot workflow list

# export
autopilot workflow export req_dev_test

# delete
autopilot workflow delete req_dev_test
```

如果第 5 步在你的环境跑不通，**记下问题，commit 时 commit message 里说明**，不要纠结于交互式验证（实施时优先靠 typecheck + Task 1 的 API 集成测试覆盖）。

- [ ] **Step 6：跑全套**

```bash
bun test
```
预期：全 pass。

- [ ] **Step 7：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w2-20260507
git add src/cli/workflow.ts src/cli/index.ts src/client/
git commit -m "feat(cli): workflow 子命令组（list/show/create/edit/delete/export/import）"
```

---

## Task 3：终验 + push + PR

- [ ] **Step 1：跑全套测试 + typecheck**

```bash
bun test
bun run typecheck
```
预期：全 pass、0 typecheck 错。

- [ ] **Step 2：push**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w2-20260507
git push -u origin feat/workflow-dynamic-mgmt-w2-20260507
```

- [ ] **Step 3：开 PR**

```bash
gh pr create \
  --base main \
  --head feat/workflow-dynamic-mgmt-w2-20260507 \
  --title "feat: 工作流动态管理 W2 — REST API 扩展 + CLI workflow 子命令组" \
  --body "## 变更摘要

W2：把 W1 的 DB 工作流能力暴露成 REST API + CLI 命令。

### REST API 改造（src/daemon/routes.ts）
- GET /api/workflows / GET /api/workflows/:name 响应附带 source / derives_from
- POST /api/workflows 加 derives_from + yaml_content 字段：
  - 有 derives_from → 走 createDbWorkflow
  - 无 → 现有文件脚手架行为
- DELETE /api/workflows/:name 区分 source（db 用 deleteDbWorkflow，file 用 deleteWorkflowDir）
- PUT /api/workflows/:name/yaml 区分 source（db 用 updateDbWorkflow，file 写文件）
- 新增 GET /api/workflows/:name/export（纯 yaml 文本响应）

### CLI（src/cli/workflow.ts）
新增子命令组（替换原 list 单命令）：
- list — 含 source / derives_from 列
- show <name> — 元信息 + yaml
- create <name> --derives-from <base> [--from yaml] [--description] — 创建 DB 工作流
- edit <name> — \$EDITOR 编辑 yaml
- delete <name> — 删（仅 db 可删）
- export <name> — yaml 输出到 stdout
- import <name> --derives-from <base> --from yaml — 导入

EDITOR 环境变量缺省 vim / Windows notepad。

### Client
- createWorkflow body 加 derives_from / yaml_content 可选字段
- 新增 exportWorkflow(name)

## 测试
- routes-workflow-api：8 用例（list / show / create db / 错误 / yaml 改写 / delete db / export db / export file / 404）
- 全套：保持 pass
- CLI 行为：靠 typecheck + 手工冒烟

## 关联
- spec: docs/superpowers/specs/2026-05-07-workflow-dynamic-management-design.md §4.4
- plan: docs/superpowers/plans/2026-05-07-workflow-dynamic-management-w2.md
- 上游：W1 (#45)
- 后续：W3（chat tools + Web UI）"
```

- [ ] **Step 4：通知用户 PR 已创建**

输出 PR 链接给用户。

---

## Self-Review

### Spec coverage

- §4.4 CLI workflow 子命令组 → Task 2 ✅
- §4.4 REST API 改造 → Task 1 ✅
- §6 错误处理（DB 工作流派生错误、404 等）→ Task 1 测试覆盖

### 假设验证

- `handleRequest` 已 export 在 src/daemon/routes.ts（W1 时确认过）
- `_setDbForTest / _clearRegistry` 已 export
- AutopilotClient 现有方法名跟 plan 里一致；如果不一致**实施时按真实命名调整**
- EDITOR 环境变量在 Windows 缺省 notepad；如果用户在 Git Bash 这类环境会自动用 EDITOR=vim

### 失误防御

- 每 task 的 commit step 都用 `git branch --show-current` 强制 verify 分支
- 如果 sandbox 切分支后 commit 落到 main，agent 必须 cherry-pick + reset main 修复
