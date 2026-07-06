# 单文件可执行安装包 · 子项目A 核心单文件化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bun build --compile bin/autopilot.ts` 产出的真单文件 exe 能完整运行——把四类「运行时从磁盘读框架自带资源」障碍改成「编译期可静态分析 / 嵌入」。

**Architecture:** codegen 把迁移/examples 烤成静态注册表常量（入库、CI 校验一致性），web-dist 用 `with { type: "file" }` 嵌入 + 资源清单（gitignore 生成物 + 稳定入口容错），进程 spawn 用 `isStandaloneBinary()` 哨兵在编译模式改走 `process.execPath + 子命令`。#1/#2/#3 让 dev 与编译走同一代码路径，只有 #4 因 spawn 目标本质不同才分支。

**Tech Stack:** Bun 1.3.9（`bun build --compile`）、TypeScript strict、bun:sqlite、bun:test。

## Global Constraints

- **dev 模式（`bun run …`）必须始终照常工作**——每个改动同时满足「磁盘文件在」（dev）与「磁盘文件不在」（编译）。
- 框架核心 `src/core/` 不得引入工作流专属常量/逻辑；codegen 数据常量置于 `src/generated/`（migrations 注册表因需相对 import 迁移文件，例外地放 `src/migrations/`）。
- **迁移护栏语义零变更**：撞号断言、file×ledger 一致性断言（`findSkippedMigrations`）、`version <= currentVersion` 跳过、事务 + `PRAGMA foreign_keys=OFF/ON`、afterCommit 闭包事务外执行、`schema_version` 账本——逐条保留。
- **入库生成物 + CI 一致性校验**：`_generated-index.ts`、`_examples.ts` 提交进 git；`scripts/check-migrations.ts` 断言「生成物 == 磁盘当前状态」。`bun run gen` 后 `git diff` 必须为空。**例外**：`_web-assets.generated.ts` 依赖 gitignore 的 web-dist，本身 gitignore、不入库、不进 CI 一致性校验。
- `catch (e: unknown)`；跨平台 spawn 用数组参数、不拼 shell 字符串。
- 跨平台「意图」落代码（spawn 各平台分支写对、build script 三 target 都在），**实机端到端验收本项目只做 Windows x64**。
- 编译入口 = `bin/autopilot.ts`（现有超薄壳 `import "../src/cli/index.ts"`），靠 argv 子命令分发。

---

## File Structure

**新建：**
- `src/core/runtime-env.ts` — `isStandaloneBinary()` 编译模式哨兵
- `scripts/gen-migrations-index.ts` — 生成迁移静态注册表
- `scripts/gen-examples-index.ts` — 生成 examples 常量
- `scripts/gen-web-assets.ts` — 生成 web 资源清单（依赖 web-dist 已构建）
- `src/migrations/_generated-index.ts` — 生成物（入库）：`MIGRATIONS`
- `src/generated/_examples.ts` — 生成物（入库）：`EXAMPLE_TEMPLATES` + `EXAMPLE_TS_ONLY`
- `src/generated/web-assets.ts` — 稳定入口（入库）：`initWebAssets/getWebAsset/hasWebAssets`
- `src/generated/_web-assets.generated.ts` — 生成物（**gitignore**）：`WEB_ASSETS`
- 测试：`tests/runtime-env.test.ts`、`tests/gen-migrations-index.test.ts`、`tests/gen-examples-index.test.ts`、`tests/migrate-registry.test.ts`、`tests/web-assets-serve.test.ts`、`tests/spawn-standalone.test.ts`

**修改：**
- `src/core/migrate.ts` — `runPendingMigrations`/`latestMigrationVersion`/`nextMigrationVersion` 读注册表；`scaffoldMigration` 后触发 codegen
- `src/core/workflow/templates.ts` — 8 个消费方读 `EXAMPLE_TEMPLATES`
- `src/daemon/routes.ts` — `serveStatic` 查表
- `src/daemon/index.ts` — `initWebAssets()` + `setWebDistDir`
- `src/cli/index.ts` — `startDaemonProcess` spawn 哨兵分支
- `src/daemon/supervisor.ts` — `runSupervisor` spawn 哨兵分支
- `scripts/check-migrations.ts` — 加生成物一致性断言
- `src/core/doctor.ts`、`src/core/update-check.ts` — 编译模式 guard
- `package.json` — `gen:*` / `build:exe*` scripts；`build:web` 顺带 `gen:web-assets`
- `.gitignore` — 加 `src/generated/_web-assets.generated.ts`

---

## Task 1: `isStandaloneBinary()` 哨兵

**Files:**
- Create: `src/core/runtime-env.ts`
- Test: `tests/runtime-env.test.ts`

**Interfaces:**
- Produces: `isStandaloneBinary(): boolean` — 编译单文件运行时返回 true。判据：`import.meta.dir` 命中 bun 虚拟根哨兵（Windows `~BUN`、posix `/$bunfs/`）。

- [ ] **Step 1: 写实现**（无独立可跑的失败测试——判据依赖运行环境，用纯函数 + 注入参数使其可测）

```ts
// src/core/runtime-env.ts
/**
 * 编译单文件（bun build --compile）运行时探测。
 * 编译后 import.meta.dir 指向 bun 虚拟根：Windows `B:/~BUN/root`、posix `/$bunfs/root`。
 * dev（bun run）下是真实磁盘目录。用于 #4 spawn 在编译模式改走 execPath 子命令。
 */
export function isStandaloneDir(dir: string): boolean {
  return dir.includes("/$bunfs/") || dir.includes("\\$bunfs\\") || /[/\\]~BUN[/\\]/.test(dir);
}

export function isStandaloneBinary(): boolean {
  return isStandaloneDir(import.meta.dir);
}
```

- [ ] **Step 2: 写测试**

```ts
// tests/runtime-env.test.ts
import { test, expect } from "bun:test";
import { isStandaloneDir } from "../src/core/runtime-env";

test("识别 bun 编译虚拟根", () => {
  expect(isStandaloneDir("B:/~BUN/root")).toBe(true);
  expect(isStandaloneDir("/$bunfs/root")).toBe(true);
  expect(isStandaloneDir("C:\\Users\\larry\\autopilot\\src\\core")).toBe(false);
  expect(isStandaloneDir("/home/user/autopilot/src/core")).toBe(false);
});
```

- [ ] **Step 3: 跑测试** — `bun test tests/runtime-env.test.ts`，Expected: PASS
- [ ] **Step 4: Commit** — `feat(packaging): isStandaloneBinary 编译模式哨兵`

---

## Task 2: 迁移注册表 codegen（不改消费方）

**Files:**
- Create: `scripts/gen-migrations-index.ts`, `src/migrations/_generated-index.ts`（脚本产出）
- Test: `tests/gen-migrations-index.test.ts`
- Modify: `scripts/check-migrations.ts`, `package.json`

**Interfaces:**
- Produces: `MIGRATIONS: MigrationEntry[]`，`MigrationEntry = { version: number; name: string; up: (db: Database) => unknown }`（`name` 不含 `.ts` 后缀，如 `"001-baseline"`；按 version 升序）。

- [ ] **Step 1: 写 codegen 脚本**

```ts
// scripts/gen-migrations-index.ts
#!/usr/bin/env bun
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";

const MIG_DIR = join(import.meta.dir, "../src/migrations");
const OUT = join(MIG_DIR, "_generated-index.ts");
const RE = /^(\d{3})-[\w-]+\.ts$/;

const files = readdirSync(MIG_DIR)
  .filter((f) => RE.test(f))
  .sort();

const entries = files.map((f) => ({ name: f.replace(/\.ts$/, ""), version: parseInt(f.slice(0, 3), 10) }));

const imports = entries.map((e, i) => `import * as m${i} from "./${e.name}";`).join("\n");
const rows = entries
  .map((e, i) => `  { version: ${e.version}, name: ${JSON.stringify(e.name)}, up: m${i}.up as MigrationEntry["up"] },`)
  .join("\n");

const body = `// 由 scripts/gen-migrations-index.ts 生成，勿手改。加迁移用 \`autopilot migrate new\` 会自动重跑本脚本。
import type { Database } from "bun:sqlite";
${imports}

export interface MigrationEntry { version: number; name: string; up: (db: Database) => unknown; }

export const MIGRATIONS: MigrationEntry[] = [
${rows}
];
`;
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 生成 ${entries.length} 条迁移注册表 → ${OUT}`);
```

- [ ] **Step 2: 生成 + 入库** — `bun run scripts/gen-migrations-index.ts`，确认 `src/migrations/_generated-index.ts` 列出全部 52 条。
- [ ] **Step 3: 加 package.json script**

```jsonc
"gen:migrations": "bun run scripts/gen-migrations-index.ts",
```

- [ ] **Step 4: 扩展 check-migrations.ts 加一致性断言**（在现有撞号检查后追加）

```ts
// scripts/check-migrations.ts 末尾（原 console.log 成功行之前）追加：
import { execSync } from "child_process";
// ③ 生成物与磁盘一致性：重跑 codegen 后 git 无 diff
execSync("bun run scripts/gen-migrations-index.ts", { stdio: "ignore" });
const diff = execSync("git status --porcelain src/migrations/_generated-index.ts", { encoding: "utf-8" }).trim();
if (diff) {
  console.error("✗ src/migrations/_generated-index.ts 与磁盘迁移文件不一致。请跑 `bun run gen:migrations` 并提交。");
  process.exit(1);
}
```

- [ ] **Step 5: 写测试**（校验生成物结构：版本升序、条数=磁盘、每条有 up）

```ts
// tests/gen-migrations-index.test.ts
import { test, expect } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { MIGRATIONS } from "../src/migrations/_generated-index";

test("注册表条数 = 磁盘迁移文件数", () => {
  const disk = readdirSync(join(import.meta.dir, "../src/migrations"))
    .filter((f) => /^\d{3}-[\w-]+\.ts$/.test(f));
  expect(MIGRATIONS.length).toBe(disk.length);
});

test("注册表按 version 升序且每条有 up 函数", () => {
  for (let i = 1; i < MIGRATIONS.length; i++) {
    expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version);
  }
  for (const m of MIGRATIONS) expect(typeof m.up).toBe("function");
});
```

- [ ] **Step 6: 跑测试 + 校验脚本** — `bun test tests/gen-migrations-index.test.ts` PASS；`bun run scripts/check-migrations.ts` 输出成功且 `git status` 干净。
- [ ] **Step 7: Commit** — `feat(packaging): 迁移静态注册表 codegen + CI 一致性校验`

---

## Task 3: examples 常量 codegen（不改消费方）

**Files:**
- Create: `scripts/gen-examples-index.ts`, `src/generated/_examples.ts`（产出）
- Test: `tests/gen-examples-index.test.ts`
- Modify: `scripts/check-migrations.ts`（复用为通用生成物校验）, `package.json`

**Interfaces:**
- Produces: `EXAMPLE_TEMPLATES: ExampleTemplate[]`，`ExampleTemplate = { name: string; doc: Record<string, unknown>; revision: number }`（按 name 排序）；`EXAMPLE_TS_ONLY: string[]`（含 workflow.ts 的目录名，当前为空，保留 has-ts 契约）。

- [ ] **Step 1: 写 codegen 脚本**

```ts
// scripts/gen-examples-index.ts
#!/usr/bin/env bun
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../examples/workflows");
const OUT_DIR = join(import.meta.dir, "../src/generated");
const OUT = join(OUT_DIR, "_examples.ts");

const names = readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory()).sort();
const templates: { name: string; doc: unknown; revision: number }[] = [];
const tsOnly: string[] = [];

for (const name of names) {
  const dir = join(ROOT, name);
  if (existsSync(join(dir, "workflow.ts"))) { tsOnly.push(name); continue; }
  const jsonPath = join(dir, "workflow.json");
  if (!existsSync(jsonPath)) continue;
  const doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
  const revision = typeof doc.template_revision === "number" ? doc.template_revision : 0;
  templates.push({ name, doc, revision });
}

const rows = templates
  .map((t) => `  { name: ${JSON.stringify(t.name)}, revision: ${t.revision}, doc: ${JSON.stringify(t.doc)} },`)
  .join("\n");

const body = `// 由 scripts/gen-examples-index.ts 生成，勿手改。examples/workflows/*/workflow.json 的编译期内联。
export interface ExampleTemplate { name: string; doc: Record<string, unknown>; revision: number; }
export const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
${rows}
];
export const EXAMPLE_TS_ONLY: string[] = ${JSON.stringify(tsOnly)};
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 生成 ${templates.length} 个 examples 模板常量（含 ts 跳过 ${tsOnly.length}）→ ${OUT}`);
```

- [ ] **Step 2: 生成 + 入库** — `bun run scripts/gen-examples-index.ts`，确认 11 个模板、`EXAMPLE_TS_ONLY = []`。
- [ ] **Step 3: package.json script** — `"gen:examples": "bun run scripts/gen-examples-index.ts"`，并加 `"gen": "bun run gen:migrations && bun run gen:examples"`。
- [ ] **Step 4: check-migrations.ts 追加 examples 生成物一致性**（同 Task 2 手法，对 `src/generated/_examples.ts` 校验重跑无 diff）。
- [ ] **Step 5: 写测试**

```ts
// tests/gen-examples-index.test.ts
import { test, expect } from "bun:test";
import { EXAMPLE_TEMPLATES, EXAMPLE_TS_ONLY } from "../src/generated/_examples";

test("dev 与 ad-hoc 模板在常量里、doc 有 phases", () => {
  const names = EXAMPLE_TEMPLATES.map((t) => t.name);
  expect(names).toContain("dev");
  expect(names).toContain("ad-hoc");
  const dev = EXAMPLE_TEMPLATES.find((t) => t.name === "dev")!;
  expect(Array.isArray(dev.doc.phases)).toBe(true);
  expect(dev.revision).toBeGreaterThanOrEqual(0);
});

test("当前无含 ts 模板", () => { expect(EXAMPLE_TS_ONLY).toEqual([]); });
```

- [ ] **Step 6: 跑测试** — `bun test tests/gen-examples-index.test.ts` PASS；`bun run scripts/check-migrations.ts` 干净。
- [ ] **Step 7: Commit** — `feat(packaging): examples 模板常量 codegen`

---

## Task 4: templates.ts 消费方切注册表（阶段 1）

**Files:**
- Modify: `src/core/workflow/templates.ts`
- Test: `tests/template-revision.test.ts`（现有，跑通即可）+ 新增断言

**Interfaces:**
- Consumes: `EXAMPLE_TEMPLATES`, `EXAMPLE_TS_ONLY` from `src/generated/_examples`。
- 8 个消费方（`listWorkflowTemplates`/`buildTemplateSpecFromExamples`/`seedTemplateWorkflow`/`cloneTemplate`/`templateRevisionStatus`/`reseedTemplateWorkflow`/`listOutdatedWorkflowCopies` + 内部 `availableTemplates`）行为不变，数据源从磁盘换成常量。

- [ ] **Step 1: 加 helper，删磁盘扫描**。在 templates.ts 顶部 import 常量，用一个 map 查找替换 `findExamplesRoot()`：

```ts
import { EXAMPLE_TEMPLATES, EXAMPLE_TS_ONLY } from "../../generated/_examples";

function findExample(name: string): { doc: Record<string, unknown>; revision: number } | null {
  const t = EXAMPLE_TEMPLATES.find((e) => e.name === name);
  return t ? { doc: t.doc, revision: t.revision } : null;
}
function exampleHasTs(name: string): boolean { return EXAMPLE_TS_ONLY.includes(name); }
```

- [ ] **Step 2: 改各消费方**（逐个替换，保持返回契约）：
  - `listWorkflowTemplates`：遍历 `EXAMPLE_TEMPLATES` 产 `WorkflowTemplate[]`（label/description/phase_count/agent_count 从 `t.doc` 取），按 name 排序。
  - `buildTemplateSpecFromExamples(name)`：`exampleHasTs(name)` → null；`findExample(name)` 无 → null；有 → `{ description, specJson: stringifyWorkflowDoc(doc,"json"), revision }`。
  - `seedTemplateWorkflow(name)`：`getWorkflowFromDb` exists → "exists"；`exampleHasTs` → "has-ts"；`findExample` 无 → "no-template"；否则 `createTemplateDbWorkflow` → "seeded"。
  - `cloneTemplate(template,target)`：`findExample(template)` 无 → throw（列 `EXAMPLE_TEMPLATES.map(t=>t.name)` 当 hint）；有 → 深拷贝 doc、`doc.name=target`、`createNativeDbWorkflow`。
  - `templateRevisionStatus(name)`：template revision 从 `findExample(name)?.revision ?? 0`。
  - `reseedTemplateWorkflow(name)`：内部已调 `buildTemplateSpecFromExamples`，透明生效，无需改。
  - `listOutdatedWorkflowCopies`：遍历 `EXAMPLE_TEMPLATES` 而非 readdirSync。
  - 删 `findExamplesRoot`/`availableTemplates`/`readTemplateRevision` 及 `fs` import（若无其他用）。

> **深拷贝注意**：`cloneTemplate` 改 `doc.name`，必须 `JSON.parse(JSON.stringify(t.doc))` 避免污染共享常量。

- [ ] **Step 3: 跑相关测试** — `bun test tests/template-revision.test.ts` 及涉及 workflow 种植/克隆的测试 PASS。
- [ ] **Step 4: 全量回归** — `bun test` 全绿、`bun run typecheck` 净。
- [ ] **Step 5: Commit** — `refactor(packaging): examples 消费方切静态常量（阶段1）`

---

## Task 5: migrate.ts 切注册表（阶段 2，风险最高，单独 PR）

**Files:**
- Modify: `src/core/migrate.ts`
- Test: `tests/migrate-registry.test.ts`（新）+ 现有 migrate 相关测试

**Interfaces:**
- Consumes: `MIGRATIONS` from `src/migrations/_generated-index`。
- `runPendingMigrations(): Promise<number>` / `latestMigrationVersion(): number` / `nextMigrationVersion(files)` 签名不变；`findSkippedMigrations`/`normalizeMigrationSlug`/`scaffoldMigration` 保留。所有 9 个调用点（cli/index.ts + daemon）零改。

- [ ] **Step 1: 写测试先行**（验证注册表驱动 + 护栏保留）

```ts
// tests/migrate-registry.test.ts
import { test, expect } from "bun:test";
import { MIGRATIONS } from "../src/migrations/_generated-index";
import { findSkippedMigrations, latestMigrationVersion } from "../src/core/migrate";

test("latestMigrationVersion = 注册表最高号", () => {
  const max = Math.max(...MIGRATIONS.map((m) => m.version));
  expect(latestMigrationVersion()).toBe(max);
});

test("findSkippedMigrations 仍抓 file×ledger 漏洞（护栏保留）", () => {
  const files = MIGRATIONS.map((m) => m.name + ".ts");
  // 造一个「currentVersion 高于某未应用迁移」的场景
  const applied = new Set(MIGRATIONS.slice(0, -1).map((m) => m.version)); // 缺最后一条
  const cur = Math.max(...MIGRATIONS.map((m) => m.version));
  const skipped = findSkippedMigrations(files, cur, applied);
  expect(skipped.length).toBe(1); // 最后一条 ≤cur 但未 applied
});
```

- [ ] **Step 2: 跑测试看失败** — `latestMigrationVersion` 现读 readdirSync（dev 下磁盘存在会碰巧通过），但改造目标是切注册表。此步确认测试可跑。
- [ ] **Step 3: 改 migrate.ts**：
  - 顶部 `import { MIGRATIONS } from "../migrations/_generated-index";`
  - `latestMigrationVersion()`：`return MIGRATIONS.length ? Math.max(...MIGRATIONS.map(m=>m.version)) : 0;`（删 readdirSync/existsSync 分支）。
  - `runPendingMigrations()`：
    - `const files = MIGRATIONS.map((m) => m.name + ".ts");`（替换 readdirSync + filter + sort；注册表已升序，但显式 `.slice().sort()` 保防御一致）
    - 撞号断言、`findSkippedMigrations`、`currentVersion` 逻辑**原样保留**（输入换成 `files`）。
    - 逐条循环改为遍历 `MIGRATIONS`：`for (const entry of MIGRATIONS)`，`version = entry.version`，`if (version <= currentVersion) continue;`，**删 `await import(migrationPath)`**，直接 `const upResult = entry.up(db)`（在事务内）。`schema_version` 写 `entry.name`（原 `file.replace(/\.ts$/, "")`）。事务 + `PRAGMA foreign_keys` + afterCommit 逻辑**完全不动**。
    - 删 `MIGRATIONS_DIR` 的 readdirSync 用途（`ensureSchemaVersionTable`/existsSync 目录不存在告警删除——注册表始终在）。**保留** `MIGRATIONS_DIR` 常量（`scaffoldMigration` 仍用它写磁盘）。
  - `scaffoldMigration()`：末尾追加触发 codegen：`Bun.spawnSync(["bun","run",join(import.meta.dir,"../../scripts/gen-migrations-index.ts")])`（dev-only；`migrate new` 后自动把新文件纳入注册表，DX 不退化）。
- [ ] **Step 4: 跑迁移端到端验证脚本**（临时脚本，scratchpad；验证空库全量迁移达最高版本、关键表在）：

```ts
// scratchpad/verify-migrate.ts — 用隔离 HOME 跑全量迁移
import { rmSync } from "fs";
process.env.AUTOPILOT_HOME = "<scratch>/mig-verify";
rmSync(process.env.AUTOPILOT_HOME, { recursive: true, force: true });
const { initDb, getDb } = await import("../src/core/db");
const { runPendingMigrations, getCurrentVersion, latestMigrationVersion } = await import("../src/core/migrate");
initDb();
const n = await runPendingMigrations();
console.log(`应用 ${n} 条，当前 v${getCurrentVersion()}，目标 v${latestMigrationVersion()}`);
if (getCurrentVersion() !== latestMigrationVersion()) throw new Error("版本未达最高");
getDb().query("SELECT 1 FROM users LIMIT 1").all();          // 不抛 = users 表在
getDb().query("SELECT 1 FROM requirements LIMIT 1").all();   // 关键业务表
console.log("✓ 空库全量迁移验证通过");
```
预期：应用 52 条、当前版本 = 最高号、两个 `SELECT` 不抛。**再跑一次**：应用 0 条（幂等，已是最新）。

- [ ] **Step 5: 跑测试 + 全量** — `bun test tests/migrate-registry.test.ts` PASS；`bun test` 全绿；`bun run typecheck` 净。**重点核对**：迁移相关既有测试（撞号/afterCommit/049-052）全绿。
- [ ] **Step 6: Commit** — `refactor(packaging)!: 迁移加载切静态注册表（阶段2·核心）`

---

## Task 6: web 资源清单 codegen + 稳定入口（阶段 3a）

**Files:**
- Create: `scripts/gen-web-assets.ts`, `src/generated/web-assets.ts`（稳定入口，入库）
- Modify: `.gitignore`, `package.json`

**Interfaces:**
- Produces: `initWebAssets(): Promise<void>`（daemon 启动调一次，try 动态 import 生成物填表）、`getWebAsset(urlKey: string): string | undefined`、`hasWebAssets(): boolean`。生成物 `_web-assets.generated.ts` 导出 `WEB_ASSETS: Record<string, string>`（key=`/index.html`、`/assets/xxx.js` 形态的 URL 路径，value=bun `with{type:"file"}` handle）。

- [ ] **Step 1: 写 codegen 脚本**

```ts
// scripts/gen-web-assets.ts
#!/usr/bin/env bun
import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, relative } from "path";

const WEB_DIST = join(import.meta.dir, "../web-dist");
const OUT_DIR = join(import.meta.dir, "../src/generated");
const OUT = join(OUT_DIR, "_web-assets.generated.ts");

if (!existsSync(WEB_DIST)) { console.error("✗ web-dist/ 不存在，先跑 bun run build:web"); process.exit(1); }

const files: string[] = [];
(function walk(dir: string) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(WEB_DIST);

const imports: string[] = [];
const rows: string[] = [];
files.forEach((abs, i) => {
  const rel = relative(WEB_DIST, abs).replace(/\\/g, "/");
  const urlKey = "/" + rel;
  imports.push(`import a${i} from "../../web-dist/${rel}" with { type: "file" };`);
  rows.push(`  ${JSON.stringify(urlKey)}: a${i},`);
});

const body = `// 由 scripts/gen-web-assets.ts 生成（build:exe 前跑）。依赖 gitignore 的 web-dist，本文件亦 gitignore、不入库。
${imports.join("\n")}

export const WEB_ASSETS: Record<string, string> = {
${rows.join("\n")}
};
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 嵌入 ${files.length} 个 web 资源 → ${OUT}`);
```

- [ ] **Step 2: 写稳定入口**（容错：生成物不存在时空表，serveStatic 回退磁盘）

```ts
// src/generated/web-assets.ts —— 入库稳定入口，勿被 _web-assets.generated.ts（gitignore 生成物）混淆
let assets: Record<string, string> = {};

/** daemon 启动调一次。try 动态 import 生成的嵌入清单；dev 未构建则空表。 */
export async function initWebAssets(): Promise<void> {
  try {
    const gen = (await import("./_web-assets.generated")) as { WEB_ASSETS: Record<string, string> };
    assets = gen.WEB_ASSETS;
  } catch {
    assets = {}; // dev 未跑 gen:web-assets：空表，serveStatic 回退磁盘 setWebDistDir
  }
}

export function getWebAsset(urlKey: string): string | undefined { return assets[urlKey]; }
export function hasWebAssets(): boolean { return Object.keys(assets).length > 0; }
```

> **compile 前提**：`bun build --compile` 静态分析 `import("./_web-assets.generated")` 字面量路径——build:exe 流程保证 `gen:web-assets` 先跑、文件存在、被打包。dev 下 `bun run` 该文件不存在，动态 import 运行时 reject 被 catch。

- [ ] **Step 3: .gitignore 加一行** — `src/generated/_web-assets.generated.ts`
- [ ] **Step 4: package.json** — `"gen:web-assets": "bun run scripts/gen-web-assets.ts"`；`build:web` 追加：`"build:web": "cd src/web && bunx vite build --outDir ../../web-dist && cd ../.. && bun run gen:web-assets"`（dev 跑 build:web 即自动生成嵌入清单，serveStatic 查表路径 dev 也覆盖）。
- [ ] **Step 5: 验证** — `bun run build:web` 后确认 `_web-assets.generated.ts` 存在且含 `/index.html` 键；`git status` 显示它被 ignore。
- [ ] **Step 6: Commit** — `feat(packaging): web-dist 嵌入清单 codegen + 稳定入口`

---

## Task 7: serveStatic 查表（阶段 3b）

**Files:**
- Modify: `src/daemon/routes.ts`（`serveStatic`）, `src/daemon/index.ts`（启动调 `initWebAssets`）
- Test: `tests/web-assets-serve.test.ts`

**Interfaces:**
- Consumes: `getWebAsset`/`hasWebAssets`/`initWebAssets` from `src/generated/web-assets`。
- `serveStatic(urlPath): Response | null` 行为：`hasWebAssets()` → 查表；否则回退现有磁盘逻辑（dev 未构建，保留 `notBuiltPage`）。

- [ ] **Step 1: index.ts 启动接线** — 在 `setWebDistDir(...)` 附近 `await initWebAssets();`（daemon 启动早期，serve 前）。
- [ ] **Step 2: 改 serveStatic**（查表分支前置，磁盘分支保留为 else）：

```ts
function serveStatic(urlPath: string): Response | null {
  if (hasWebAssets()) {
    const key = (urlPath === "" || urlPath === "/") ? "/index.html" : decodeSafe(urlPath);
    if (key === null) return null;
    let handle = getWebAsset(key);
    if (!handle && !/\.[a-zA-Z0-9]+$/.test(urlPath)) handle = getWebAsset("/index.html"); // SPA fallback
    if (!handle) return /\.[a-zA-Z0-9]+$/.test(urlPath) ? null : notBuiltPage();
    const ext = key.substring(key.lastIndexOf("."));
    const isHashed = key.startsWith("/assets/");
    return new Response(Bun.file(handle), {
      headers: {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }
  return serveStaticFromDisk(urlPath); // 原 serveStatic 主体抽成此函数，dev 未构建/未 gen 时用
}

function decodeSafe(urlPath: string): string | null {
  let d: string;
  try { d = decodeURIComponent(urlPath); } catch { return null; }
  if (d.includes("\0")) return null;
  return "/" + d.replace(/^[/\\]+/, ""); // 归一成 /assets/... 形态的 key
}
```

> 把现有 `serveStatic` 主体（磁盘 resolve + 穿越校验 + `notBuiltPage`）原样重命名为 `serveStaticFromDisk`，不改其逻辑（dev 回退路径）。查表分支天然白名单（key 不在表即 404），无需路径穿越校验。

- [ ] **Step 3: 写测试**（构造假 WEB_ASSETS 验证查表 + SPA fallback + 缓存头）——因 `assets` 是模块私有，测试通过 `initWebAssets` 无法注入假表；改为**测 `decodeSafe` 纯函数** + 一个集成层面断言（dev 下 `build:web` 后起 daemon 请求 `/` 返回 200 text/html、请求 `/assets/<真实hash>.js` 返回 immutable）。最小化：单测 `decodeSafe` 边界（NUL/穿越归一），集成验证放阶段 5。

```ts
// tests/web-assets-serve.test.ts
import { test, expect } from "bun:test";
import { decodeSafe } from "../src/daemon/routes"; // 导出 decodeSafe 供测
test("decodeSafe 归一与拒绝", () => {
  expect(decodeSafe("/assets/x.js")).toBe("/assets/x.js");
  expect(decodeSafe("///assets/x.js")).toBe("/assets/x.js");
  expect(decodeSafe("/%00")).toBe(null);
});
```

- [ ] **Step 4: 跑测试 + dev 手验** — `bun test` 全绿；`bun run build:web` 后 `bun run daemon`（隔离 HOME）访问 dashboard 正常、Network 面板确认 `/assets/*` immutable、`/` no-cache。
- [ ] **Step 5: Commit** — `feat(packaging): serveStatic 查嵌入清单（阶段3）`

---

## Task 8: CLI daemon start spawn 哨兵（阶段 4a）

**Files:**
- Modify: `src/cli/index.ts`（`startDaemonProcess`）
- Test: `tests/spawn-standalone.test.ts`

**Interfaces:**
- Consumes: `isStandaloneBinary` from `src/core/runtime-env`。
- 编译模式：spawn `process.execPath` + `["daemon","run",...]`（supervise 时 `["daemon","run","--supervise"...]` 或对应子命令）；dev 模式保持 `bun run <script.ts>`。

- [ ] **Step 1: 抽 spawn 目标为纯函数**（可测）：

```ts
// 在 cli/index.ts 内新增（导出供测）
export function daemonSpawnPlan(opts: {
  standalone: boolean; supervise: boolean; execPath: string; scriptDir: string;
  port?: number; host?: string;
}): { cmd: string; args: string[] } {
  const extra: string[] = [];
  if (opts.port) extra.push("--port", String(opts.port));
  if (opts.host) extra.push("--host", opts.host);
  if (opts.standalone) {
    const sub = opts.supervise ? ["daemon", "run", "--supervise"] : ["daemon", "run"];
    return { cmd: opts.execPath, args: [...sub, ...extra] };
  }
  const script = opts.supervise
    ? `${opts.scriptDir}/../daemon/supervisor.ts`
    : `${opts.scriptDir}/../daemon/index.ts`;
  return { cmd: "bun", args: ["run", script, ...extra] };
}
```

> 注：`daemon run --supervise` 需 CLI 支持——确认/补 `daemon run` 的 `--supervise` flag 走 `runSupervisor`（Task 9 supervisor 侧对齐）。若现无该 flag，本 task 内补：`daemon run` 加 `--supervise` 选项，standalone 编译版靠它重入。

- [ ] **Step 2: startDaemonProcess 用 plan**：`const plan = daemonSpawnPlan({ standalone: isStandaloneBinary(), supervise, execPath: process.execPath, scriptDir: import.meta.dir, port, host });` 然后 Windows 分支 `nodeSpawn(plan.cmd, plan.args, {detached/unref})`（**不再拼 `cmd /c start` 字符串**——编译版 execPath 装 Program Files 含空格，数组传参 nodeSpawn detached 直接拉；保留 `windowsHide`）；POSIX 分支 `nodeSpawn(plan.cmd, plan.args, {detached, stdio:"ignore"})`。删除「路径含空格提前报错」（数组传参不再受此限）。
- [ ] **Step 3: 写测试**

```ts
// tests/spawn-standalone.test.ts
import { test, expect } from "bun:test";
import { daemonSpawnPlan } from "../src/cli/index";
test("编译模式 spawn execPath 子命令", () => {
  const p = daemonSpawnPlan({ standalone: true, supervise: false, execPath: "C:/Program Files/autopilot/autopilot.exe", scriptDir: "/x", port: 6180 });
  expect(p.cmd).toBe("C:/Program Files/autopilot/autopilot.exe");
  expect(p.args).toEqual(["daemon", "run", "--port", "6180"]);
});
test("dev 模式 spawn bun run script", () => {
  const p = daemonSpawnPlan({ standalone: false, supervise: false, execPath: "bun", scriptDir: "/x/cli" });
  expect(p.cmd).toBe("bun");
  expect(p.args[0]).toBe("run");
  expect(p.args[1]).toContain("daemon/index.ts");
});
```

- [ ] **Step 4: 跑测试 + dev 回归** — `bun test tests/spawn-standalone.test.ts` PASS；`bun run typecheck` 净；dev 手验 `bun run dev daemon start` 仍能起后台 daemon（`daemon status` 确认）。
- [ ] **Step 5: Commit** — `feat(packaging): daemon start spawn 编译模式哨兵（阶段4a）`

---

## Task 9: supervisor spawn 哨兵 + 可降级点 guard（阶段 4b）

**Files:**
- Modify: `src/daemon/supervisor.ts`（`runSupervisor`）, `src/core/doctor.ts`, `src/core/update-check.ts`, `src/core/autopilot-resolver.ts`

**Interfaces:**
- Consumes: `isStandaloneBinary`。supervisor 编译模式 `Bun.spawn([execPath,"daemon","run",...])`；dev 保持 `["bun","run",daemonScript,...]`。

- [ ] **Step 1: supervisor spawn 分支**：

```ts
// supervisor.ts runSupervisor 内，替换 daemonScript/baseArgs：
const standalone = isStandaloneBinary();
const spawnCmd: string[] = standalone
  ? [process.execPath, "daemon", "run"]
  : ["bun", "run", join(import.meta.dir, "index.ts")];
if (opts.port) spawnCmd.push("--port", String(opts.port));
if (opts.host) spawnCmd.push("--host", opts.host);
// 循环内：currentChild = Bun.spawn(spawnCmd, { stdout:"ignore", stderr:"ignore" });
```

- [ ] **Step 2: 可降级点 guard**（编译模式跳过、不崩）：
  - `doctor.ts:184` repoRoot / git 检测：`if (!isStandaloneBinary()) { …git… }`，编译模式该项显示「打包运行，跳过仓库检查」。
  - `update-check.ts:18` git 版本检测：编译模式跳过（`isStandaloneBinary()` 直接 return「打包版无 git 更新检测」）。
  - `autopilot-resolver.ts`：`installAutopilotResolver` 编译模式直接 return（用户 workflow.ts 已退役、编译版死码，Bun.plugin 在 compile 运行时可能报错）。
- [ ] **Step 3: 跑测试 + typecheck** — `bun test` 全绿、`bun run typecheck` 净；dev 手验 `bun run dev daemon start`（默认 supervise）后台起、`daemon stop` 干净。
- [ ] **Step 4: Commit** — `feat(packaging): supervisor spawn 哨兵 + 编译模式降级 guard（阶段4b）`

---

## Task 10: 构建脚本 + 编译产物端到端验收（阶段 5）

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加 build scripts**

```jsonc
"prebuild:exe": "bun run gen && bun run build:web",
"build:exe": "bun run prebuild:exe && bun build --compile bin/autopilot.ts --outfile dist/autopilot.exe",
"build:exe:win":   "bun run prebuild:exe && bun build --compile --target=bun-windows-x64 bin/autopilot.ts --outfile dist/autopilot-win-x64.exe",
"build:exe:linux": "bun run prebuild:exe && bun build --compile --target=bun-linux-x64   bin/autopilot.ts --outfile dist/autopilot-linux-x64",
"build:exe:macos": "bun run prebuild:exe && bun build --compile --target=bun-darwin-arm64 bin/autopilot.ts --outfile dist/autopilot-macos-arm64"
```

> `build:web` 已（Task 6）内含 `gen:web-assets`，故 `prebuild:exe` = `gen`（migrations+examples）+ `build:web`（含 web-assets）。`dist/` 加进 `.gitignore`。

- [ ] **Step 2: 构建单文件** — `bun run build:exe`，确认 `dist/autopilot.exe` 生成、exit 0。
- [ ] **Step 3: 端到端验收**（隔离 HOME，复刻「立即崩」场景）：

```bash
export AUTOPILOT_HOME=<scratch>/exe-verify
"dist/autopilot.exe" init            # 跑迁移（注册表）+ 种 dev/ad-hoc（examples 常量）
"dist/autopilot.exe" daemon run &    # 前台起 daemon，观察无「迁移目录不存在」「no such table」
# 另开：访问 http://127.0.0.1:6180 dashboard（web-assets 嵌入）、建需求、跑一个 phase
```
预期：init 成功建表（无 `no such table: users`）、daemon 起、dashboard 可访问、需求/phase 跑通。

- [ ] **Step 4: dev 模式回归** — `bun test` 全量、`bun run typecheck`、`bun run build:web` 全绿；`bun run dev daemon start/status/stop` 正常。
- [ ] **Step 5: Commit** — `feat(packaging): build:exe 构建链 + 端到端验收（阶段5）`

---

## 收尾（全部 task 后）

- [ ] `bun run coverage:rpc` 无异常；`bun run smoke-test` 通过。
- [ ] 更新 CLAUDE.md「启动和使用」加 `bun run build:exe` 单文件打包说明；CHANGELOG「未发布」加 Added 条目。
- [ ] 更新 memory `single-file-packaging-blockers`：三处障碍已解、子项目 A 完成、B/C 待做。
