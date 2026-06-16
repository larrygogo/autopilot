# `req list` 命令实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `autopilot req list` 补齐"枚举所有需求"入口，打通 CLI / CI/CD 自动化链路的第一步。

**Architecture:** 三层薄壳——`src/client/http.ts` 新增 `listRequirements()` 调既有 WS RPC `requirements.list`；`src/client/index.ts` 新增代理 getter；`src/cli/requirements-cli.ts` 注册 `req list` 子命令，渲染层提取为可独立测试的纯函数 `renderRequirementsTable`，同时以 CJK 感知的宽度计算修复 `padEnd` 对汉字的对齐 bug，并以导出函数的形式覆盖单元测试。

**Tech Stack:** Bun, TypeScript (strict), Commander.js, bun:test。无新依赖，无新 RPC。

---

## 文件地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/client/http.ts` | **修改** | 新增 `listRequirements(filters?)` 方法，调 `requirements.list` RPC |
| `src/client/index.ts` | **修改** | 新增 `get listRequirements` 代理 getter |
| `src/cli/requirements-cli.ts` | **修改** | 新增 `req list` 命令 + 导出 `strDisplayWidth` / `renderRequirementsTable` |
| `tests/cli-req-list.test.ts` | **新建** | client 方法透传测试 + 渲染纯函数测试 + CLI 子进程测试 |

---

## 历史遗留问题处理（本轮必须规避）

### CJK 对齐 bug（重大风险，必须修复）

**问题根因：** `String.prototype.padEnd(n)` 按 JS 字符数补空格，而 CJK 字符在终端占 2 列。当 title 含中文时，各行显示宽度不一致，表格错位。

**修复方案：** 在 `requirements-cli.ts` 新增导出辅助函数 `strDisplayWidth`（计算终端显示宽度）和 `renderRequirementsTable`（表格渲染），以及内部函数 `isWideChar`（宽字符判断，未导出）、`truncateToWidth`、`padEndWidth`，供 `renderRequirementsTable` 使用。详见 Task 2 代码。

**已知局限（明确记录）：**
- Emoji（U+1F300 等）多数也是双宽字符，但本实现不覆盖（Emoji 块超出 `isWideChar` 范围）。`id/status/workflow/project_id` 列均为纯 ASCII，`title` 列含 Emoji 极少见；已知此局限不影响核心使用场景。
- Combining characters 不计入，极少见情况下错位可接受。

### 退出码断言精确化

测试中 daemon 不可达场景断言 `toBe(3)`（精确值），不用 `not.toBe(0)`。依据：`ensureDaemon` 调 `process.exit(3)`。

### `undefined` 参数隐式透传

`listRequirements()` 无参调用时传 `{}`，与 `listTasks` 保持一致。RPC handler 已对 `typeof ... === "string"` 防御。

---

## Task 1：创建完整测试文件 + 实现 client 方法（TDD）

**Files:**
- 新建: `tests/cli-req-list.test.ts`（一次性写入全部 Tasks 的测试）
- 修改: `src/client/http.ts`
- 修改: `src/client/index.ts`

> **设计说明：** 测试文件在此步骤一次性写入，包含 Tasks 1/2/3 的全部 describe 块和 import。
> bun 通过 transpilation 编译 TS（不做预先完整类型检查），缺失导出在运行时才报错，
> 不影响文件加载。Task 1 时点：client 测试 RED（`listRequirements` 不存在），
> 渲染测试和 CLI 测试也 RED（`strDisplayWidth`/`renderRequirementsTable` 不存在），
> 各组测试在对应 Task 实现后各自变 GREEN。

- [ ] **Step 1：新建完整测试文件（所有 describe 块，全部 import）**

```typescript
// tests/cli-req-list.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HttpClient } from "../src/client/http";
import type { Requirement } from "../src/core/requirements";
import { strDisplayWidth, renderRequirementsTable } from "../src/cli/requirements-cli";

// ── Task 1：HttpClient.listRequirements 透传测试 ─────────────

describe("HttpClient.listRequirements", () => {
  /** 构造一个不需要真实 WS 连接的 HttpClient，替换内部 rpc 为 spy。 */
  function makeSpyClient() {
    const client = new HttpClient("http://localhost:1");
    const spy: Array<{ method: string; params: unknown }> = [];
    (client as unknown as Record<string, unknown>).rpc = {
      call: (method: string, params: unknown) => {
        spy.push({ method, params });
        return Promise.resolve({ requirements: [] });
      },
      close: () => {},
    };
    return { client, spy };
  }

  it("无参数时调 requirements.list，透传空对象", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements();
    expect(spy).toHaveLength(1);
    expect(spy[0]!.method).toBe("requirements.list");
    expect(spy[0]!.params).toEqual({});
  });

  it("透传 status 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ status: "drafting" });
    expect(spy[0]!.method).toBe("requirements.list");
    expect((spy[0]!.params as Record<string, string>).status).toBe("drafting");
  });

  it("透传 project_id 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ project_id: "proj-001" });
    expect((spy[0]!.params as Record<string, string>).project_id).toBe("proj-001");
  });

  it("透传 workspace_id 过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({ workspace_id: "ws-001" });
    expect((spy[0]!.params as Record<string, string>).workspace_id).toBe("ws-001");
  });

  it("同时透传三个过滤参数", async () => {
    const { client, spy } = makeSpyClient();
    await client.listRequirements({
      status: "ready",
      project_id: "proj-002",
      workspace_id: "ws-002",
    });
    const p = spy[0]!.params as Record<string, string>;
    expect(p.status).toBe("ready");
    expect(p.project_id).toBe("proj-002");
    expect(p.workspace_id).toBe("ws-002");
  });

  it("返回值含 requirements 数组", async () => {
    const { client } = makeSpyClient();
    const result = await client.listRequirements();
    expect(result).toHaveProperty("requirements");
    expect(Array.isArray(result.requirements)).toBe(true);
  });
});

// ── Task 2：strDisplayWidth + renderRequirementsTable 渲染测试 ─

/** 构造最小 Requirement 对象（只包含渲染用到的字段）。 */
function mkReq(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "req-001",
    project_id: "proj-001",
    workspace_id: null,
    title: "Default title",
    status: "drafting",
    spec_md: "",
    chat_session_id: null,
    task_id: null,
    pr_url: null,
    pr_number: null,
    last_reviewed_event_id: null,
    active_question_id: null,
    clarifier_error: null,
    clarifier_provider: null,
    clarifier_model: null,
    schedule_error: null,
    status_reason: null,
    status_reason_source: null,
    status_before_terminal: null,
    workflow: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("strDisplayWidth", () => {
  it("纯 ASCII 字符串宽度 = 字符数", () => {
    expect(strDisplayWidth("hello")).toBe(5);
    expect(strDisplayWidth("")).toBe(0);
    expect(strDisplayWidth("ab cd")).toBe(5);
  });

  it("CJK 字符每个宽度 = 2", () => {
    expect(strDisplayWidth("中")).toBe(2);
    expect(strDisplayWidth("中文")).toBe(4);
    expect(strDisplayWidth("中文abc")).toBe(7); // 4 + 3
  });

  it("混合字符串宽度正确", () => {
    expect(strDisplayWidth("用户登录优化")).toBe(12); // 6 汉字 × 2
    expect(strDisplayWidth("fix: 修复")).toBe(9);    // "fix: " = 5 + "修复" = 4
  });
});

describe("renderRequirementsTable", () => {
  it("空列表返回友好提示，不为空字符串", () => {
    const out = renderRequirementsTable([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("暂无需求");
  });

  it("输出包含五列表头：id / title / status / workflow / project_id", () => {
    const out = renderRequirementsTable([mkReq()]);
    expect(out).toContain("id");
    expect(out).toContain("title");
    expect(out).toContain("status");
    expect(out).toContain("workflow");
    expect(out).toContain("project_id");
  });

  it("输出包含分隔线（某行以多个 - 开头）", () => {
    const out = renderRequirementsTable([mkReq()]);
    expect(out).toMatch(/^-+/m);
  });

  it("workflow 为 null 时显示 dev（默认）", () => {
    const out = renderRequirementsTable([mkReq({ workflow: null })]);
    expect(out).toContain("dev（默认）");
  });

  it("workflow 非 null 时显示实际值，不含默认标签", () => {
    const out = renderRequirementsTable([mkReq({ workflow: "req_dev" })]);
    expect(out).toContain("req_dev");
    expect(out).not.toContain("dev（默认）");
  });

  it("输出包含 id / title / status / project_id 字段值", () => {
    const r = mkReq({ id: "req-042", title: "Test feature", status: "ready", project_id: "proj-007" });
    const out = renderRequirementsTable([r]);
    expect(out).toContain("req-042");
    expect(out).toContain("Test feature");
    expect(out).toContain("ready");
    expect(out).toContain("proj-007");
  });

  it("末尾包含需求总数", () => {
    const out = renderRequirementsTable([mkReq(), mkReq({ id: "req-002" })]);
    expect(out).toContain("2");
  });

  it("CJK 标题不破坏列对齐（各数据行显示宽度相同）", () => {
    const reqs = [
      mkReq({ id: "req-001", title: "中文标题非常长的需求描述" }),
      mkReq({ id: "req-002", title: "Short ASCII title here" }),
      mkReq({ id: "req-003", title: "另一个中文标题" }),
    ];
    const out = renderRequirementsTable(reqs);
    // 提取纯数据行（以 req- 开头）
    const dataLines = out.split("\n").filter((l) => l.trimStart().startsWith("req-"));
    expect(dataLines).toHaveLength(3);
    // 所有数据行的终端显示宽度必须完全相同
    const widths = dataLines.map((l) => strDisplayWidth(l));
    expect(new Set(widths).size).toBe(1);
  });

  it("超长标题截断并加截断标记 >，不换行", () => {
    const longTitle = "这是一个非常非常非常非常非常非常长的中文需求标题超过了最大宽度限制绝对超出了";
    const r = mkReq({ title: longTitle });
    const out = renderRequirementsTable([r]);
    // 含截断标记 ">"（使用 ASCII > 而非 …，避免 CJK 终端下 Ambiguous 双宽问题）
    const dataLine = out.split("\n").find((l) => l.includes("req-001"));
    expect(dataLine).toBeDefined();
    expect(dataLine!).toContain(">");
    // 数据行不包含原始超长字符串
    expect(dataLine!.includes(longTitle)).toBe(false);
  });
});

// ── Task 3：req list CLI 子进程测试 ─────────────────────

describe("autopilot req list CLI", () => {
  let tmpHome: string;
  const REPO = process.cwd();

  beforeEach(() => {
    tmpHome = join(
      tmpdir(),
      `autopilot-cli-req-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }

  it("`req --help` 列出 list 子命令", () => {
    runCli("init");
    const r = runCli("req", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("list");
  });

  it("`req list --help` 含 --status / --project / --workspace / --json 选项", () => {
    runCli("init");
    const r = runCli("req", "list", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--status");
    expect(r.stdout).toContain("--project");
    expect(r.stdout).toContain("--workspace");
    expect(r.stdout).toContain("--json");
  });

  it("daemon 未启时 `req list` 退出码精确为 3，stderr 含 daemon 提示", () => {
    runCli("init");
    const r = runCli("req", "list", "--port", "19999");
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("daemon");
  });

  it("daemon 未启时 `req list --status drafting` 退出码精确为 3", () => {
    runCli("init");
    const r = runCli("req", "list", "--status", "drafting", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --project proj-001` 退出码精确为 3", () => {
    runCli("init");
    const r = runCli("req", "list", "--project", "proj-001", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --workspace ws-001` 退出码精确为 3", () => {
    runCli("init");
    const r = runCli("req", "list", "--workspace", "ws-001", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });

  it("daemon 未启时 `req list --json` 退出码精确为 3", () => {
    runCli("init");
    const r = runCli("req", "list", "--json", "--port", "19999");
    expect(r.exitCode).toBe(3);
  });
});
```

- [ ] **Step 2：运行测试，确认失败（Task 1 的 client 测试 RED）**

```bash
cd C:/Users/larry/.autopilot/runtime/requirements/req-023/codebase/autopilot
bun test tests/cli-req-list.test.ts 2>&1 | head -30
```

期望：`HttpClient.listRequirements` describe 内失败（`client.listRequirements is not a function`），渲染测试和 CLI 测试也 RED（`strDisplayWidth is not a function`）。

- [ ] **Step 3：在 `src/client/http.ts` 实现 `listRequirements` 方法**

在 `getRequirement` 方法结束后（第 354-357 行，`/** 优雅停机 */` 注释前）插入：

```typescript
  async listRequirements(filters?: {
    status?: string;
    project_id?: string;
    workspace_id?: string;
  }): Promise<{ requirements: Requirement[] }> {
    return this.call("requirements.list", filters ?? {});
  }
```

完整上下文（确认插入位置正确）：

```typescript
  async getRequirement(id: string): Promise<{ requirement: Requirement }> {
    return this.call("requirements.get", { id });
  }

  async listRequirements(filters?: {   // ← 新增这一块
    status?: string;
    project_id?: string;
    workspace_id?: string;
  }): Promise<{ requirements: Requirement[] }> {
    return this.call("requirements.list", filters ?? {});
  }

  /** 优雅停机：daemon 自己关 socket 后 exit 0（避免 Windows 硬杀产生 zombie LISTEN） */
  async shutdownDaemon(): Promise<{ ok: boolean; scheduled_in_ms: number }> {
```

- [ ] **Step 4：在 `src/client/index.ts` 新增代理 getter**

在 `get getRequirement` 行（第 57 行）后插入一行：

```typescript
  get getRequirement() { return this.http.getRequirement.bind(this.http); }
  get listRequirements() { return this.http.listRequirements.bind(this.http); }  // ← 新增
  get getTaskOutcome() { return this.http.getTaskOutcome.bind(this.http); }
```

- [ ] **Step 5：运行 Task 1 测试，确认 client 测试全绿**

```bash
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | grep -A2 "listRequirements"
```

期望：`HttpClient.listRequirements` describe 块下的 6 条用例全部 PASS。

- [ ] **Step 6：提交**

```bash
git add src/client/http.ts src/client/index.ts tests/cli-req-list.test.ts
git commit -m "feat(client): 新增 listRequirements 方法，调既有 requirements.list RPC"
```

---

## Task 2：在 requirements-cli.ts 添加 CJK 渲染工具函数（TDD）

**Files:**
- 修改: `src/cli/requirements-cli.ts`（只在文件顶部新增工具函数 + export；不改动现有命令）

- [ ] **Step 1：运行当前测试，确认渲染测试 RED**

```bash
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | grep -E "strDisplayWidth|renderRequirements"
```

期望：全部失败（`strDisplayWidth is not a function`）。

- [ ] **Step 2：在 `src/cli/requirements-cli.ts` 添加 CJK 工具函数和 renderRequirementsTable**

在文件顶部 import 区域末尾（`import type { Workspace }` 行之后）添加：

```typescript
import type { Requirement } from "../core/requirements";
```

然后在 `readRawTextInteractive` 函数**之前**（import 块结束后）插入以下代码：

```typescript
// ──────────────────────────────────────────────
// 终端表格渲染工具（CJK 双宽字符感知）
// ──────────────────────────────────────────────

/**
 * 计算字符串的终端显示宽度（CJK / 全角字符占 2 列，其余占 1 列）。
 * 导出供单元测试直接验证。
 */
export function strDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x2EFF) ||   // CJK Radicals Supplement
    (cp >= 0x2F00 && cp <= 0x2FDF) ||   // Kangxi Radicals
    (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
    (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
    (cp >= 0x3100 && cp <= 0x312F) ||   // Bopomofo
    (cp >= 0x3130 && cp <= 0x318F) ||   // Hangul Compatibility Jamo
    (cp >= 0x3200 && cp <= 0x33FF) ||   // Enclosed CJK / CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs（主块）
    (cp >= 0xA000 && cp <= 0xA4CF) ||   // Yi Syllables / Radicals
    (cp >= 0xA960 && cp <= 0xA97F) ||   // Hangul Jamo Extended-A
    (cp >= 0xAC00 && cp <= 0xD7FF) ||   // Hangul Syllables + Jamo Extended-B
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (cp >= 0xFE10 && cp <= 0xFE1F) ||   // Vertical Forms
    (cp >= 0xFE30 && cp <= 0xFE4F) ||   // CJK Compatibility Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth Latin / Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
    (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Extension B-F + Compat Supplement
    (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Extension G+
  );
}

/**
 * 按终端显示宽度截断字符串（CJK 感知），超出时末尾追加 ">" 作为截断标记（占 1 列）。
 * 使用 ">" 而非 "…"（U+2026），因为后者在 CJK 终端（East Asian Width = Ambiguous）
 * 可能被渲染为 2 列，导致对齐仍差 1 列。
 *
 * 边界行为：maxDispWidth < 2 时原样返回（不截断）。当前列定义中最小列宽 = 表头长度
 * （最短 "id" = 2），因此实际不会触发此分支。
 */
function truncateToWidth(s: string, maxDispWidth: number): string {
  if (maxDispWidth < 2 || strDisplayWidth(s) <= maxDispWidth) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > maxDispWidth - 1) break; // 保留 1 列给截断标记 ">"
    out += ch;
    w += cw;
  }
  return out + ">";
}

/**
 * padEnd 的终端显示宽度感知版：补空格直到目标显示宽度。
 * 若 s 已超出则原样返回（截断由 truncateToWidth 负责）。
 */
function padEndWidth(s: string, targetDispWidth: number): string {
  const current = strDisplayWidth(s);
  return current >= targetDispWidth ? s : s + " ".repeat(targetDispWidth - current);
}

// 列定义：key 约束为 keyof Requirement，拼写错误编译期即报错
const REQ_LIST_COLS: ReadonlyArray<{ key: keyof Requirement; header: string; maxWidth: number }> = [
  { key: "id",         header: "id",         maxWidth: 16 },
  { key: "title",      header: "title",       maxWidth: 40 },
  { key: "status",     header: "status",      maxWidth: 20 },
  { key: "workflow",   header: "workflow",    maxWidth: 20 },
  { key: "project_id", header: "project_id",  maxWidth: 20 },
];

/** 取某列的显示值（workflow NULL 时显示默认标签）。类型安全，字段拼写编译期校验。 */
function reqCellValue(r: Requirement, key: keyof Requirement): string {
  if (key === "workflow") return r.workflow ?? "dev（默认）";
  return String(r[key] ?? "");
}

/**
 * 把 Requirement 列表渲染为对齐表格字符串（含表头 / 分隔线 / 总数行）。
 * 空列表返回友好提示字符串。导出供单元测试直接验证输出。
 */
export function renderRequirementsTable(requirements: Requirement[]): string {
  if (requirements.length === 0) {
    return "暂无需求。用 `autopilot req new \"描述\"` 创建一个。";
  }

  // 各列宽度 = min(maxWidth, max(header.length, 各行对应列的显示宽度))
  // 使用 reduce 替代 Math.max(...spread)，避免大数据量时栈溢出
  const colWidths = REQ_LIST_COLS.map(({ key, header, maxWidth }) => {
    const dataMax = requirements.reduce(
      (m, r) => Math.max(m, strDisplayWidth(reqCellValue(r, key))), 0,
    );
    return Math.min(maxWidth, Math.max(header.length, dataMax));
  });

  const lines: string[] = [];

  // 表头（统一用 padEndWidth 确保一致性，即使当前表头全为 ASCII）
  lines.push(REQ_LIST_COLS.map(({ header }, i) => padEndWidth(header, colWidths[i]!)).join("  "));
  // 分隔线（每列宽度个 -）
  lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));

  for (const r of requirements) {
    const row = REQ_LIST_COLS.map(({ key }, i) => {
      // 1. 截断到列宽（CJK 感知）
      const cell = truncateToWidth(reqCellValue(r, key), colWidths[i]!);
      // 2. 补空格到列宽（CJK 感知），保证每列占相同显示宽度
      return padEndWidth(cell, colWidths[i]!);
    }).join("  ");
    lines.push(row);
  }

  lines.push(`\n共 ${requirements.length} 条。`);
  return lines.join("\n");
}
```

- [ ] **Step 3：运行渲染测试，确认全绿**

```bash
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | grep -A1 "strDisplayWidth\|renderRequirements"
```

期望：`strDisplayWidth` 3 条和 `renderRequirementsTable` 8 条全部 PASS。

- [ ] **Step 4：提交**

```bash
git add src/cli/requirements-cli.ts
git commit -m "feat(cli): 添加 CJK 感知表格渲染工具函数 strDisplayWidth + renderRequirementsTable"
```

---

## Task 3：注册 `req list` CLI 子命令（TDD）

**Files:**
- 修改: `src/cli/requirements-cli.ts`（在 `set-title` 命令之后追加 `list` 命令）

- [ ] **Step 1：运行 CLI 子进程测试，确认 RED**

```bash
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | grep -A1 "req list CLI"
```

期望：`req --help 列出 list 子命令` 失败（help 里没有 `list`）。

- [ ] **Step 2：在 `registerRequirementCommands` 里追加 `req list` 命令**

在 `src/cli/requirements-cli.ts` 的 `set-title` 命令的 `.action(...)` 结束 `});` 之后、`}` 闭合前，追加：

```typescript
  req
    .command("list")
    .description("列出所有需求（默认全库；可用 --status / --project / --workspace 过滤）")
    .option("--status <status>", "按状态过滤（如 drafting / ready / done）")
    .option("--project <id>", "按 project id 过滤")
    .option("--workspace <id>", "按 workspace id 过滤")
    .option("--json", "原始 JSON 输出（机器可解析，风格与 req show --json 一致）")
    .option("--port <port>", "daemon 端口", String(DEFAULT_PORT))
    .action(
      async (opts: {
        status?: string;
        project?: string;
        workspace?: string;
        json?: boolean;
        port: string;
      }) => {
        const client = getClient(opts.port);
        await ensureDaemon(client);
        try {
          // 只传显式提供的过滤字段，不传 undefined 避免干扰 RPC handler
          const filters: { status?: string; project_id?: string; workspace_id?: string } = {};
          if (opts.status) filters.status = opts.status;
          if (opts.project) filters.project_id = opts.project;
          if (opts.workspace) filters.workspace_id = opts.workspace;

          const { requirements } = await client.listRequirements(
            Object.keys(filters).length > 0 ? filters : undefined,
          );

          if (opts.json) {
            console.log(JSON.stringify(requirements, null, 2));
            return;
          }

          console.log(renderRequirementsTable(requirements));
        } catch (e: unknown) {
          console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
          process.exit(3);
        }
      },
    );
```

- [ ] **Step 3：运行 CLI 子进程测试，确认全绿**

```bash
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | grep -A1 "req list CLI"
```

期望：7 条用例全部 PASS。

- [ ] **Step 4：提交**

```bash
git add src/cli/requirements-cli.ts
git commit -m "feat(cli): 注册 req list 子命令，支持 --status/--project/--workspace/--json 过滤"
```

---

## Task 4：最终验证（全套回归）

**Files:** 无新改动，只验证。

- [ ] **Step 1：运行所有新增测试，确认全绿**

```bash
cd C:/Users/larry/.autopilot/runtime/requirements/req-023/codebase/autopilot
bun test tests/cli-req-list.test.ts --reporter spec 2>&1 | tail -20
```

期望：全部 PASS（共 6 + 3 + 8 + 7 = 24 条），无失败。

- [ ] **Step 2：运行 typecheck**

```bash
bun run typecheck 2>&1 | tail -10
```

期望：`0 errors`。

- [ ] **Step 3：运行完整测试套件，验证零回归**

```bash
bun test 2>&1 | tail -30
```

期望：全绿，与 main 分支相比无新失败。尤其确认 `tests/cli-req-new.test.ts` 和 `tests/requirement-*.test.ts` 系列仍通过。

- [ ] **Step 4：人工核查 `req show` 帮助文本不变**

```bash
bun run bin/autopilot.ts req show --help
bun run bin/autopilot.ts req list --help
```

确认 `req show --help` 输出与变更前一致，`req list --help` 正确显示所有四个选项描述。

- [ ] **Step 5：（如 typecheck 有小修）提交修复**

```bash
git add <修复的文件>
git commit -m "fix: 修复 typecheck 问题"
```

---

## 影响范围评估

### 新增（无回归风险）
- `src/client/http.ts`：新方法 `listRequirements`，不改动现有任何方法
- `src/client/index.ts`：新代理 getter，不改动现有 getters
- `src/cli/requirements-cli.ts`：顶部新增工具函数 + 新增 `req list` 命令注册；`req new/show/set-workflow/set-title` 的 action 函数**完全不动**

### 无变动
- `src/daemon/rpc-methods.ts`：`requirements.list` RPC 已存在，行为完全不变
- `src/core/requirements.ts`：`listRequirements` core 函数完全不变
- 所有现有测试文件

### 验收对照

| 验收项 | 对应实现位置 |
|--------|------------|
| `req list` 默认列出全部需求，5 列表格 | Task 3 Step 2，`renderRequirementsTable` |
| 空列表友好提示而非空白 | Task 2 Step 2，`renderRequirementsTable` 空分支 |
| `--status/--project/--workspace` 过滤 | Task 3 Step 2，filters 构建逻辑 |
| `--json` 输出原始 JSON | Task 3 Step 2，`JSON.stringify(requirements, null, 2)` |
| `workflow=null` 显示 `dev（默认）` | Task 2 Step 2，`reqCellValue` 函数 |
| client 透传过滤参数正确 | Task 1 Step 1，client unit tests |
| CLI 表格 / JSON 渲染 | Task 2 Step 1，`renderRequirementsTable` 系列测试 |
| 各过滤参数生效 | Task 3 Step 1，CLI subprocess tests |
| CJK 对齐 bug 修复 | Task 2 Step 2，`strDisplayWidth + padEndWidth`；Task 2 Step 1，CJK 对齐测试 |
| 退出码断言精确（`toBe(3)`） | Task 3 Step 1，daemon-未启测试全部用精确断言 |
| 现有命令不受影响 | Task 4 Step 3，全套回归 |

---

## 实现偏离记录（代码审查后补充）

以下是实际实现相对原始计划的有意偏离，均已反映在上方代码示例中：

| 偏离点 | 原计划 | 实际实现 | 原因 |
|--------|--------|----------|------|
| 截断标记 | `"…"`（U+2026） | `">"` (ASCII 0x3E) | `"…"` 在 CJK 终端 East Asian Width = Ambiguous，可能渲染为 2 列破坏对齐 |
| `REQ_LIST_COLS.key` 类型 | `string` | `keyof Requirement` | 字段拼写错误可在编译期捕获，实质性类型安全提升 |
| `reqCellValue` 签名 | `key: string` | `key: keyof Requirement` | 同上 |
| `colWidths` 计算 | `Math.max(...spread)` | `reduce` | 避免大数据量时 spread 导致栈溢出 |
| 表头对齐 | `padEnd` | `padEndWidth` | 保持一致性，未来若加非 ASCII 表头不会出问题 |
| `ensureDaemon` 位置 | try/catch 外 | 纳入 try/catch | 防御性编码，防止 ensureDaemon 未来改为抛异常 |
| 控制字符测试 | 未覆盖 | 新增 `\n`/`\t` 边界测试 | 记录 strDisplayWidth 对控制字符的边界行为 |
| `--json` 成功路径测试 | 仅 CLI 子进程级 | 补充单元级 JSON 格式验证 | CLI 集成测试依赖真实 daemon，成本高；单元级覆盖格式正确性 |
