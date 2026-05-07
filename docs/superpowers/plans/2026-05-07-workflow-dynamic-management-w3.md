# 工作流动态管理 W3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 落地 W 系列 chat / UI 层 — chat agent 能动态创建 / 改 / 删 DB 工作流；Web UI `/workflows` 区分 file/db 来源、加「派生新工作流」按钮。

**Architecture:**
- `src/agents/tools.ts` 加 4 个新 tool：`list_phase_functions / create_db_workflow / update_db_workflow / delete_db_workflow`；扩展 `list_workflows` 返回 source / derives_from。
- `src/web/src/pages/Workflows.tsx` 列表区分 source、file 行删除按钮 disabled、新增 "派生新工作流" 按钮（dialog 选 base + 名字 → 复制 yaml → 编辑器）。
- `src/web/src/hooks/useApi.ts` 类型扩展（WorkflowInfo / WorkflowDetail 加 source / derives_from）。

---

## Task 1：chat tools 扩展

**Files:**
- Modify: `src/agents/tools.ts`
- Create: `tests/chat-tools-workflow.test.ts`

**新增 4 个 tool + 扩展 1 个：**

| Tool | 用途 |
|---|---|
| `list_phase_functions` | 列某 file workflow 可复用的 phase 函数名 |
| `create_db_workflow` | 创建 DB 工作流（必须 derives_from 一个 file） |
| `update_db_workflow` | 改 DB 工作流的 yaml |
| `delete_db_workflow` | 删 DB 工作流 |
| `list_workflows`（已有） | 扩展返回 source / derives_from |

- [ ] **Step 1：写失败测试**

新建 `tests/chat-tools-workflow.test.ts`：

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
import { buildAutopilotTools } from "../src/agents/tools";

function getText(res: { content: Array<{ type: string; text?: string }> }): string {
  const item = res.content[0] as { type: string; text?: string };
  return item.text ?? "";
}

describe("chat tools 工作流管理（W3）", () => {
  let tmpHome: string;
  let db: Database;

  beforeAll(async () => {
    tmpHome = join(tmpdir(), `autopilot-w3-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    _clearRegistry();
    await discover();
  });

  afterAll(() => {
    delete process.env.AUTOPILOT_HOME;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.run("DELETE FROM workflows WHERE source = 'db'");
    _clearRegistry();
    await discover();
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tools = await buildAutopilotTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    const res = await tool.handler(args, undefined as any);
    return getText(res);
  }

  it("list_workflows 返回 source / derives_from", async () => {
    const text = await callTool("list_workflows", {});
    expect(text).not.toMatch(/^错误/);
    const obj = JSON.parse(text);
    const reqDev = obj.find((w: { name: string }) => w.name === "req_dev");
    expect(reqDev).toBeDefined();
    expect(reqDev.source).toBe("file");
  });

  it("list_phase_functions 返回 base 的 phase name 集合", async () => {
    const text = await callTool("list_phase_functions", { workflow_name: "req_dev" });
    expect(text).not.toMatch(/^错误/);
    const obj = JSON.parse(text);
    expect(obj.phase_functions.sort()).toEqual(["design", "develop"]);
  });

  it("list_phase_functions 不存在的 workflow → 错误", async () => {
    const text = await callTool("list_phase_functions", { workflow_name: "no_such" });
    expect(text).toMatch(/^错误/);
  });

  it("create_db_workflow + update_db_workflow + delete_db_workflow 完整链路", async () => {
    // create
    const created = await callTool("create_db_workflow", {
      name: "req_dev_fast",
      derives_from: "req_dev",
      yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n",
      description: "skip review",
    });
    expect(created).not.toMatch(/^错误/);
    const cObj = JSON.parse(created);
    expect(cObj.name).toBe("req_dev_fast");
    expect(cObj.source).toBe("db");

    // update
    const updated = await callTool("update_db_workflow", {
      name: "req_dev_fast",
      yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n  - name: develop\n",
    });
    expect(updated).not.toMatch(/^错误/);

    // delete
    const deleted = await callTool("delete_db_workflow", { name: "req_dev_fast" });
    expect(deleted).not.toMatch(/^错误/);
  });

  it("create_db_workflow derives_from 不存在 → 错误", async () => {
    const text = await callTool("create_db_workflow", {
      name: "wf_x",
      derives_from: "no_such",
      yaml_content: "x",
    });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/不存在/);
  });

  it("update_db_workflow 改 file 工作流 → 错误", async () => {
    const text = await callTool("update_db_workflow", {
      name: "req_dev",
      yaml_content: "x",
    });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/file|只读/);
  });

  it("delete_db_workflow 删 file 工作流 → 错误", async () => {
    const text = await callTool("delete_db_workflow", { name: "req_dev" });
    expect(text).toMatch(/^错误/);
    expect(text).toMatch(/file|只读/);
  });
});
```

- [ ] **Step 2：跑测试，预期失败**

```bash
bun test tests/chat-tools-workflow.test.ts
```

- [ ] **Step 3：扩展 src/agents/tools.ts**

(a) 文件顶部 import 区追加：
```ts
import {
  listWorkflowsInDb,
  createDbWorkflow,
  updateDbWorkflow,
  deleteDbWorkflow,
  getWorkflowFromDb,
} from "../core/workflows";
import { reload as reloadRegistry } from "../core/registry";
```

(b) **改 `list_workflows` tool 的 handler**（找到现有定义，line ~124 处）：

```ts
tool(
  "list_workflows",
  "列出已注册的工作流（含 source / derives_from）。",
  {},
  async () => {
    try {
      const inMem = listWorkflows();
      const dbRows = listWorkflowsInDb();
      const sourceMap = new Map(dbRows.map((r) => [r.name, r]));
      const result = inMem.map((wf) => {
        const row = sourceMap.get(wf.name);
        return {
          name: wf.name,
          description: wf.description,
          source: row?.source ?? "file",
          derives_from: row?.derives_from ?? null,
        };
      });
      return ok(result);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
),
```

(c) 在 list_workflows 之后追加 4 个新 tool：

```ts
// ── 工作流动态管理（W3） ──

tool(
  "list_phase_functions",
  "列出某个 file 工作流的可复用 phase 函数名集合。chat 创建 DB 工作流时只能挑这里面的 phase。",
  { workflow_name: z.string().describe("file workflow 名（如 req_dev）") },
  async (args) => {
    const wf = getWorkflow(args.workflow_name);
    if (!wf) return err(`工作流不存在：${args.workflow_name}`);
    const row = getWorkflowFromDb(args.workflow_name);
    if (row && row.source !== "file") {
      return err(`${args.workflow_name} 是 source=${row.source}，必须用 source=file 工作流的 phase 函数`);
    }
    const names: string[] = [];
    for (const p of wf.phases) {
      if (isParallelPhase(p)) {
        for (const sub of p.parallel.phases) names.push(sub.name);
      } else {
        names.push(p.name);
      }
    }
    return ok({ workflow: args.workflow_name, phase_functions: names });
  },
),

tool(
  "create_db_workflow",
  "创建 DB 工作流（必须 derives_from 一个 file workflow）。yaml 里 phase name 必须 ⊆ derives_from 的 phase 集合（先用 list_phase_functions 看）。",
  {
    name: z.string().describe("新工作流名（不能跟现有工作流冲突）"),
    derives_from: z.string().describe("派生自的 file 工作流名（如 req_dev）"),
    yaml_content: z.string().describe("完整 yaml（含 name / phases 等）"),
    description: z.string().optional().describe("可选描述"),
  },
  async (args) => {
    try {
      const wf = createDbWorkflow({
        name: args.name,
        description: args.description ?? "",
        derives_from: args.derives_from,
        yaml_content: args.yaml_content,
      });
      try { await reloadRegistry(); } catch (e: unknown) { /* reload 失败不阻塞 */ }
      return ok({ name: wf.name, source: wf.source, derives_from: wf.derives_from });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
),

tool(
  "update_db_workflow",
  "更新 DB 工作流的 yaml_content（覆盖写）。仅 source=db 可改。",
  {
    name: z.string(),
    yaml_content: z.string(),
    description: z.string().optional(),
  },
  async (args) => {
    try {
      const r = updateDbWorkflow(args.name, {
        yaml_content: args.yaml_content,
        description: args.description,
      });
      if (!r) return err(`工作流不存在：${args.name}`);
      try { await reloadRegistry(); } catch (e: unknown) { /* reload 失败不阻塞 */ }
      return ok({ name: r.name, source: r.source });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
),

tool(
  "delete_db_workflow",
  "删除 DB 工作流。仅 source=db 可删；file 来源工作流请改 ~/.autopilot/workflows/<name>/ 目录。",
  { name: z.string() },
  async (args) => {
    try {
      deleteDbWorkflow(args.name);
      try { await reloadRegistry(); } catch (e: unknown) { /* reload 失败不阻塞 */ }
      return ok({ name: args.name, deleted: true });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
),
```

注意：上面用到 `getWorkflow` / `isParallelPhase` 已在文件顶部 import 进来；如果没有，从 `../core/registry` 加进 import。

(d) **更新 TOOL_NAMES 列表**（文件底部）：

```ts
export const TOOL_NAMES = [
  "list_tasks",
  "get_task",
  "get_task_logs",
  "list_workflows",
  "get_workflow",
  "list_sessions",
  "get_session",
  "get_daemon_status",
  "start_task",
  "cancel_task",
  "list_repos",
  "create_requirement_draft",
  "update_requirement_spec",
  "mark_requirement_ready",
  "enqueue_requirement",
  "list_requirements",
  "inject_feedback",
  "cancel_requirement",
  "list_phase_functions",
  "create_db_workflow",
  "update_db_workflow",
  "delete_db_workflow",
] as const;
```

- [ ] **Step 4：跑测试**

```bash
bun test tests/chat-tools-workflow.test.ts
bun run typecheck
```

- [ ] **Step 5：跑全套**

```bash
bun test
```

- [ ] **Step 6：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w3-20260507
git add src/agents/tools.ts tests/chat-tools-workflow.test.ts
git commit -m "feat(chat): 工作流动态管理 tools — list_phase_functions + create/update/delete_db_workflow"
```

---

## Task 2：Web UI 适配

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`（类型扩展）
- Modify: `src/web/src/pages/Workflows.tsx`（列表 source 标识 + 派生按钮）

### 改造点
1. WorkflowInfo / WorkflowDetail 类型加 `source: "db" | "file"` 和 `derives_from: string | null`
2. 列表行加 source 徽章（file 显示 📁 标签 / db 显示 🗄 标签）
3. file 工作流的「删除」按钮 disabled（hover 提示「文件工作流只读」）
4. 顶部加 "派生新工作流" 按钮（次按钮，点击弹 dialog）
5. 派生 dialog：选 base file workflow（select 下拉）+ 输入新 name + 描述 → 复制 base yaml 到 textarea 让用户改 → 保存调 createWorkflow

- [ ] **Step 1：扩展 useApi.ts 类型**

打开 `src/web/src/hooks/useApi.ts`，找到现有 workflow 相关类型 / 方法。如果没有显式 WorkflowInfo 类型导出，把 `api.listWorkflows()` 的返回元素类型改为：

```ts
{ name: string; description: string; source?: "db" | "file"; derives_from?: string | null }
```

`api.getWorkflow(name)` 返回类型扩展同上。

`api.createWorkflow` body 的接受参数加可选：`derives_from?: string; yaml_content?: string`（如果之前是 inline 类型，改成 inline + 可选）。

- [ ] **Step 2：改 Workflows.tsx 类型与 import**

(a) WorkflowInfo / WorkflowDetail 接口加字段：

```ts
interface WorkflowInfo {
  name: string;
  description: string;
  source?: "db" | "file";
  derives_from?: string | null;
}

interface WorkflowDetail {
  // ... 现有字段
  source?: "db" | "file";
  derives_from?: string | null;
}
```

(b) import 区追加：
```ts
import { GitBranch, FileCode, Database } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/input";
```

注意：Textarea 的 import 路径以你项目实际为准。

- [ ] **Step 3：列表行加 source 徽章 + file 行 disable 删除**

找到现有列表渲染（应该有个 `workflows.map(...)` 块）。给每行 name 后面加：

```tsx
{wf.source === "db" && (
  <span title={`派生自 ${wf.derives_from}`} className="ml-2 inline-flex items-center text-xs text-muted-foreground">
    <Database className="h-3 w-3 mr-0.5" />db
  </span>
)}
{wf.source === "file" && (
  <span className="ml-2 inline-flex items-center text-xs text-muted-foreground">
    <FileCode className="h-3 w-3 mr-0.5" />file
  </span>
)}
```

把删除按钮的 `disabled` 改为：
```tsx
disabled={loadingDetail || wf.source === "file"}
title={wf.source === "file" ? "文件工作流只读，请改源目录" : "删除"}
```

- [ ] **Step 4：加「派生新工作流」按钮 + Dialog**

(a) 在组件顶部 state 区追加：
```tsx
const [deriveOpen, setDeriveOpen] = useState(false);
const [deriveBase, setDeriveBase] = useState("");
const [deriveName, setDeriveName] = useState("");
const [deriveDesc, setDeriveDesc] = useState("");
const [deriveYaml, setDeriveYaml] = useState("");
const [deriveSaving, setDeriveSaving] = useState(false);

const fileWorkflows = workflows.filter((w) => (w.source ?? "file") === "file");

const openDerive = async () => {
  // 默认选第一个 file 工作流，预填 yaml
  const base = fileWorkflows[0]?.name ?? "";
  setDeriveBase(base);
  setDeriveName("");
  setDeriveDesc("");
  if (base) {
    try {
      const r = await api.getWorkflowYaml(base);
      setDeriveYaml(r.yaml);
    } catch {
      setDeriveYaml("");
    }
  } else {
    setDeriveYaml("");
  }
  setDeriveOpen(true);
};

const onChangeDeriveBase = async (newBase: string) => {
  setDeriveBase(newBase);
  if (!newBase) {
    setDeriveYaml("");
    return;
  }
  try {
    const r = await api.getWorkflowYaml(newBase);
    setDeriveYaml(r.yaml);
  } catch {
    setDeriveYaml("");
  }
};

const saveDerive = async () => {
  if (!deriveName.trim() || !deriveBase) {
    toast.error("校验失败", "name 和 base 必填");
    return;
  }
  setDeriveSaving(true);
  try {
    await api.createWorkflow({
      name: deriveName.trim(),
      description: deriveDesc.trim() || undefined,
      derives_from: deriveBase,
      yaml_content: deriveYaml,
    });
    toast.success(`已创建派生工作流 ${deriveName.trim()}`);
    setDeriveOpen(false);
    refresh();
  } catch (e: unknown) {
    toast.error("创建失败", (e as Error)?.message ?? String(e));
  } finally {
    setDeriveSaving(false);
  }
};
```

(b) 顶部按钮区（找到 `setNewOpen(true)` 那个 New 按钮所在 flex 容器），紧邻加：

```tsx
<Button variant="outline" size="sm" onClick={openDerive}>
  <GitBranch className="h-4 w-4" />
  派生
</Button>
```

(c) 在文件渲染末尾、原有 `NewWorkflowDialog` 之后加 Dialog：

```tsx
<Dialog open={deriveOpen} onOpenChange={(open) => { if (!open && !deriveSaving) setDeriveOpen(false); }}>
  <DialogContent className="sm:max-w-2xl">
    <DialogHeader>
      <DialogTitle>派生新工作流</DialogTitle>
      <DialogDescription>
        基于一个 file 工作流的 phase 函数集合，新建一个 DB 工作流（仅修改 yaml 配置）。
      </DialogDescription>
    </DialogHeader>
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <Label htmlFor="derive-base">派生自 (base)</Label>
        <select
          id="derive-base"
          className="border rounded px-2 py-1.5 text-sm w-full bg-background"
          value={deriveBase}
          onChange={(e) => { void onChangeDeriveBase(e.target.value); }}
        >
          <option value="">选择 file 工作流</option>
          {fileWorkflows.map((w) => (
            <option key={w.name} value={w.name}>{w.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="derive-name">新工作流名</Label>
        <Input id="derive-name" placeholder="例如：req_dev_fast"
          value={deriveName} onChange={(e) => setDeriveName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="derive-desc">描述（可选）</Label>
        <Input id="derive-desc" placeholder="一句话说明"
          value={deriveDesc} onChange={(e) => setDeriveDesc(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="derive-yaml">YAML 内容（默认填了 base 的 yaml，按需修改）</Label>
        <Textarea id="derive-yaml" className="min-h-[260px] font-mono text-xs"
          value={deriveYaml} onChange={(e) => setDeriveYaml(e.target.value)} />
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setDeriveOpen(false)} disabled={deriveSaving}>取消</Button>
      <Button onClick={saveDerive} disabled={deriveSaving || !deriveName.trim() || !deriveBase}>
        {deriveSaving ? "创建中…" : "创建"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5：typecheck + 构建**

```bash
bun run typecheck
bun run build:web
```
预期：0 错。

如果遇到 useApi.ts 里 `createWorkflow` body 类型不接受 `derives_from / yaml_content` 字段，先改 useApi.ts 的方法签名（W2 Task 2 时已经改过 client/http.ts，前端 useApi.ts 可能没同步——补上）。

- [ ] **Step 6：跑全套（防止 typecheck 错误以外的破坏）**

```bash
bun test
```

- [ ] **Step 7：commit**

```bash
git branch --show-current  # 必须是 feat/workflow-dynamic-mgmt-w3-20260507
git add src/web/src/pages/Workflows.tsx src/web/src/hooks/useApi.ts
git commit -m "feat(web): Workflows 页面区分 source + 派生新工作流 dialog"
```

---

## Task 3：终验 + push + PR（控制者执行）

由控制 agent 执行（不是 implementer subagent）：

- 跑 `bun test` 全套
- `bun run typecheck`
- `bun run build:web`
- push 分支
- 用 gh CLI 开 PR

PR title: `feat: 工作流动态管理 W3 — chat tools + Web UI 派生编辑`

PR body 简要描述：
- chat tools 新增 4 个（list_phase_functions / create_db_workflow / update_db_workflow / delete_db_workflow）+ list_workflows 扩展
- Web UI 列表加 source 徽章 + file 行只读 + 派生 dialog
- 测试：chat-tools-workflow 7 用例
- 关联：spec §4.5 §4.6，plan W3，上游 #45 / #46

---

## Self-Review

### Spec coverage
- §4.5 chat tools → Task 1 ✅
- §4.6 Web UI → Task 2 ✅
- W 系列收官（W4 是收官 PR，已标 不在范围）

### 假设验证
- `getWorkflow / isParallelPhase` 在 src/agents/tools.ts 已经 import 进来（W1/W2 的现有代码）
- `reload as reloadRegistry` 在 src/core/registry.ts 已 export（W1 看过 line 85）
- `api.createWorkflow` 在 useApi.ts 是否接受 derives_from / yaml_content 字段：可能需要补，实施时 verify

### 失误防御
- 每 task commit 前 `git branch --show-current` 验证
- sandbox 切分支后 commit 落到 main 时按 cherry-pick + reset 修复
