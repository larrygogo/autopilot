# autopilot 单文件可执行安装包 — 子项目 A：核心单文件化（设计）

> 本 spec 只覆盖**子项目 A：核心单文件化**。多平台实机验收（B）、各平台 installer + 代码签名（C）是后续独立子项目，各自 spec。

**目标**：让 `bun build --compile bin/autopilot.ts` 产出的**真单文件 exe** 能完整运行（init → daemon → 建需求 → 跑 phase → 访问 dashboard），不再因「运行时从磁盘读框架自带资源」而崩。

**架构取向**：把四类「运行时读盘」障碍改成「编译期可静态分析 / 嵌入」；`#1/#2/#3` 让 dev 与编译**走同一条代码路径**（无模式分支，dev 天天跑即持续验证），只有 `#4 spawn` 因 dev/编译目标本质不同才用运行时哨兵分支。

**技术栈**：Bun 1.3.9（`bun build --compile`）、TypeScript strict、bun:sqlite。

## Global Constraints（贯穿所有任务）

- **dev 模式（`bun run …`）必须始终照常工作**——任何改动同时满足「磁盘文件在」（dev）与「磁盘文件不在」（编译）。
- **框架核心 `src/core/` 不得引入工作流专属常量/逻辑**。codegen 生成物是「磁盘数据的编译期内联」，语义中立，不违此约束；若观感存疑，生成物置于 `src/generated/` 独立目录。
- **迁移护栏语义零变更**：撞号断言、file×ledger 一致性断言、`version <= currentVersion` 跳过、事务 + `PRAGMA foreign_keys=OFF/ON`、afterCommit 闭包在事务外执行、`schema_version` 账本——逐条保留。
- **生成物入库 + CI 一致性校验**：`_generated-*.ts` 提交进 git，扩展 `scripts/check-migrations.ts` 断言「生成物 == 磁盘当前状态」，防漂移。`bun run gen` 后 `git diff` 必须为空。
- `catch (e: unknown)`；跨平台 spawn 用数组参数、不拼 shell 字符串（防注入 + 防路径含空格）。
- **跨平台的「意图」本次落进代码**（spawn 写对各平台、build script 三 target 都在），但**实机端到端验收本次只做 Windows x64**；linux/macOS 验收挪子项目 B。

## 背景与现状

前置已完成：yaml 全面移除、file-yaml 轨退役、TUI（ink）删除——`bun build --compile` 的「格式层」与 ink→react-devtools-core 依赖障碍已清。实测：编译**能过**（exit 0），但编译产物一运行即崩——`迁移目录不存在：B:\~BUN\migrations` → 迁移一条没跑 → DB 空表 → `SQLiteError: no such table: users`。

## Bun 1.3.9 能力实测结论（scratchpad 已验证）

| 能力 | dev | compile | 用途 |
|------|-----|---------|------|
| `import.meta.glob(...)` | ❌ 不支持 | ❌ 不支持 | **排除** |
| 静态 `import * as m from "./001"` | ✅ | ✅ | 迁移/examples 注册表 |
| `import data from "./x.json"` | ✅ | ✅ | examples 可选 |
| `import p from "./f" with { type: "file" }` | ✅ 返回真实磁盘路径 | ✅ 返回虚拟路径 `B:/~BUN/root/<name>-<hash>.<ext>` | web-dist 嵌入 |
| 虚拟路径上 `Bun.file().exists()/.size` / `new Response(Bun.file(p))` | — | ✅ 全正常（size 正确、流式 200） | serveStatic 几乎零改 |
| `Bun.embeddedFiles` | 空 | 有，但 name 被内容 hash 化、丢目录前缀 | **不能靠它反查 URL→资源，须 codegen 清单** |
| `process.execPath` | bun 路径 | ✅ 真实 exe 路径（`argv[0]="bun"`、`argv[1]=虚拟路径`，均不可用） | 自 spawn |
| 编译版自 spawn（`execPath + 子命令`） | — | ✅ 子进程重入 exe、`argv[2]`=子命令 | daemon start/supervisor |
| 编译哨兵 | `import.meta.dir` 在磁盘 | `import.meta.dir = B:/~BUN/root`（posix `/$bunfs/`） | 模式探测 |

## 四类障碍与方案

### #1 迁移加载（最核心，回归风险最高）

**现机制**（`src/core/migrate.ts`）：`readdirSync` 扫 `src/migrations/NNN-*.ts` → 排序 → 撞号断言 → file×ledger 一致性断言 → 逐条 `await import(path)` 取 `mod.up` → 事务内跑 `up(db)` + 写 `schema_version`，`up` 可返回 afterCommit 闭包。

**方案：codegen 生成静态注册表**。`scripts/gen-migrations-index.ts` 扫目录生成 `src/migrations/_generated-index.ts`：

```ts
// src/migrations/_generated-index.ts —— 生成物，勿手改
import type { Database } from "bun:sqlite";
import * as m001 from "./001-baseline";
// ...按编号全列
export interface MigrationEntry { version: number; name: string; up: (db: Database) => unknown; }
export const MIGRATIONS: MigrationEntry[] = [
  { version: 1, name: "001-baseline", up: m001.up },
  // ...
];
```

- `runPendingMigrations` 不再 `readdirSync`+`await import`，改遍历 `MIGRATIONS`；`files` 派生自 `MIGRATIONS.map(m => m.name + ".ts")`——撞号/漏号/排序/`schema_version.name` 断言逻辑**零改**，只换输入源。
- `mod.up` 从 `entry.up` 取；afterCommit 机制不动（即 `up` 返回值）。
- `latest/nextMigrationVersion` 改读注册表；`scaffoldMigration`（`migrate new`，dev-only）写完磁盘文件后**顺带重跑 codegen**（DX 不退化：仍是「建文件→自动进注册表」）。
- **dev 与 compile 都走注册表**，无分支。

### #2 examples 模板嵌入

**现机制**（`src/core/workflow/templates.ts:36`）：`findExamplesRoot`+`readdirSync` 扫 `examples/workflows/<name>/workflow.json`。消费方 7 个 + **迁移 049/052** 经 `buildTemplateSpecFromExamples` 复用。

**方案：codegen 烤 TS 常量**。`scripts/gen-examples-index.ts` 生成 `src/generated/_examples.ts`：

```ts
export interface ExampleTemplate { name: string; doc: Record<string, unknown>; revision: number; }
export const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
  { name: "dev", revision: 7, doc: { name: "dev", phases: [/* 内联 JSON */] } },
  // ...
];
```

- templates.ts 所有 `findExamplesRoot()`+磁盘读改查 `EXAMPLE_TEMPLATES`。`buildTemplateSpecFromExamples(name)` = 找 entry → `stringifyWorkflowDoc(doc,"json")` + revision。
- 「含 `workflow.ts` 的模板不种」的守卫在 codegen 期过滤（含 ts 的目录不进注册表；`seedTemplateWorkflow` 对未知 name 返回 `no-template`，语义等价）。
- **迁移 049/052 无需改**——它们 import 的函数内部换源即透明生效。dev/compile 统一走常量。

### #3 web-dist 嵌入（真单文件，已定）

**现机制**：`serveStatic`（`routes.ts:509`）`resolve(rootDir,relative)`+路径穿越校验+`existsSync`+`new Response(Bun.file())`。web-dist 是 vite hash 产物（`assets/index-[hash].js`，文件名每次构建变）。

**方案：codegen 资源清单 + `with { type: "file" }` 嵌入**。`build:web` 之后跑 `scripts/gen-web-assets.ts` 扫 `web-dist/**`，生成 `src/generated/_web-assets.ts`：每文件一条 `import aN from "../../web-dist/<相对路径>" with { type: "file" }`，导出 `WEB_ASSETS: Record<"/相对URL", string>`（key=URL 路径、value=bun handle）。

- serveStatic 改 `WEB_ASSETS[urlPath]` 查表 → `Bun.file(handle)`。dev 下 handle=真实磁盘路径、compile 下=虚拟路径，同一套代码。
- **清单即白名单**：路径穿越校验（`resolve+startsWith`）整段删。SPA fallback = 「URL 无扩展名 → `WEB_ASSETS["/index.html"]`」。缓存策略按 key 前缀（`/assets/` 前缀 → immutable、其余 no-cache），逻辑不变。
- 不用 `Bun.embeddedFiles` 运行时扫（嵌入名被再 hash、丢 `assets/` 前缀，无法可靠反查）。

serveStatic 改造骨架：

```ts
function serveStatic(urlPath: string): Response | null {
  const key = (urlPath === "" || urlPath === "/") ? "/index.html" : urlPath;
  let handle = WEB_ASSETS[key];
  if (!handle && !/\.[a-zA-Z0-9]+$/.test(urlPath)) handle = WEB_ASSETS["/index.html"]; // SPA fallback
  if (!handle) return null;
  const isHashed = key.startsWith("/assets/");
  return new Response(Bun.file(handle), {
    headers: { "Content-Type": mimeFor(key), "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "no-cache" },
  });
}
```

### #4 进程 spawn 模型（编译版 `daemon start`/supervisor 会断）

**现机制**：`src/cli/index.ts:389` 和 `src/daemon/supervisor.ts:106` 用 `join(import.meta.dir,"../daemon/index.ts")` + `bun run <script.ts>` 拉后台 daemon。编译单文件里既无 `bun` 保证在 PATH、也无 `.ts` 文件 → 断。（`daemon run` 前台进程内启动、phase 执行进程内 `Bun.spawn(claude CLI)`——均不受影响；agent CLI 是用户装的外部二进制，非框架资源。）

**方案**：抽 `isStandaloneBinary()` 哨兵（`import.meta.dir` 命中 `~BUN`/`$bunfs`），集中在 `src/core/runtime-env.ts`：
- 编译模式：spawn `process.execPath` + 子命令（`[execPath, "daemon", "run", ...]`，supervisor 重入同 exe）。不用 argv[0]/argv[1]。
- dev 模式：保持 `bun run <script.ts>`。
- Windows 后台化（现 `cmd /c start /b bun run …`）改直接 `nodeSpawn(execPath, ["daemon","run",...], {detached, stdio:"ignore"})`，**保留路径含空格防御**（installer 装 `Program Files` 必含空格）——本点实现期专门测。

### 可降级点（非阻塞，编译模式 guard 掉即可）

`doctor.ts:184` repoRoot、`update-check.ts:18` git 版本检测、`autopilot-resolver.ts:50`（`@autopilot/*` 别名——用户 workflow.ts 已退役、编译版是死码，可删或 guard）。

## 构建流程与 package.json

串联（codegen 在 compile 前；web-assets codegen 在 build:web 后）：

```
gen:migrations ─┐
gen:examples   ─┼─→ (typecheck/test)
build:web → gen:web-assets ─┘
                             └─→ bun build --compile bin/autopilot.ts
```

```jsonc
{
  "gen:migrations": "bun run scripts/gen-migrations-index.ts",
  "gen:examples":   "bun run scripts/gen-examples-index.ts",
  "gen:web-assets": "bun run scripts/gen-web-assets.ts",
  "gen": "bun run gen:migrations && bun run gen:examples",
  "prebuild:exe": "bun run gen && bun run build:web && bun run gen:web-assets",
  "build:exe": "bun run prebuild:exe && bun build --compile bin/autopilot.ts --outfile dist/autopilot.exe",
  "build:exe:win":   "bun run prebuild:exe && bun build --compile --target=bun-windows-x64 bin/autopilot.ts --outfile dist/autopilot-win-x64.exe",
  "build:exe:linux": "bun run prebuild:exe && bun build --compile --target=bun-linux-x64   bin/autopilot.ts --outfile dist/autopilot-linux-x64",
  "build:exe:macos": "bun run prebuild:exe && bun build --compile --target=bun-darwin-arm64 bin/autopilot.ts --outfile dist/autopilot-macos-arm64"
}
```

**生成物位置约定**：`_generated-index.ts` 放 `src/migrations/`（要 `import "./001-baseline"` 相对路径，同目录最自然）；`_examples.ts` 与 `_web-assets.ts` 放 `src/generated/`（无同目录 import 约束，集中一处、与 core 业务码隔离，避免「数据常量混进 core 逻辑」的观感）。

**编译入口 = `bin/autopilot.ts`（统一 CLI）**，单 exe 靠 argv 子命令分发（`autopilot.exe daemon run` / `dashboard` / `task …`）。三 target script 本次就写上（跨平台意图落代码），linux/macOS 实机验收留子项目 B。

## 分阶段落地（每阶段独立 ship、`bun test`+`typecheck`+（改前端的）`build:web` 全绿）

- **阶段 0 · 基建（零行为变更）**：写 `isStandaloneBinary()` + 三个 codegen 脚本 + 生成物入库；扩展 `check-migrations.ts` 断言生成物与磁盘一致。验证：`bun run gen` 后 `git diff` 为空。
- **阶段 1 · examples 切注册表**（爆炸半径限工作流子系统）：templates.ts 消费方改读 `EXAMPLE_TEMPLATES`。验证：`workflow list/create/sync`、init 种 dev/ad-hoc、049/052 相关测试。
- **阶段 2 · 迁移切注册表**（风险最高，单独 PR、单独 review）：migrate.ts 改读 `MIGRATIONS`。验证：①空库全量迁移到最新 ②已有库增量升级 ③撞号/漏号断言仍触发 ④afterCommit 仍在事务外跑。临时脚本：删测试库→`runPendingMigrations`→断言 `getCurrentVersion()` 达最新且表齐全。
- **阶段 3 · web-dist 嵌入**：`gen:web-assets` + serveStatic 查表。验证：dev 下访问 Web、`build:web` 后重跑、路径穿越用例改为「不在清单即 404」、SPA fallback、缓存头。
- **阶段 4 · spawn 模型 + 编译入口**：`daemon start`/supervisor 加哨兵分支；确认 `bun run dev daemon start` dev 路径不变；Windows 后台化路径含空格专测。
- **阶段 5 · 首个 compile 产物端到端验收**：`bun run build:exe` → 全新 `AUTOPILOT_HOME` 跑 `autopilot.exe init` → `daemon run` → 建需求 → 访问 dashboard → 跑一个 phase。这是「立即崩」场景的最终验收。

## 回归风险热点

迁移账本（阶段 2）> spawn Windows 后台化路径含空格（阶段 4）> web-dist 缓存头/SPA fallback（阶段 3）> examples revision 比对（阶段 1）。阶段 2、4 各自单独 PR。

## 验收标准（子项目 A 完成的定义）

1. `bun test` 全量绿、`bun run typecheck` 净、`bun run build:web` 过。
2. `bun run gen` 后 `git diff` 为空（生成物与磁盘一致）。
3. `bun run build:exe` 产出单文件 `dist/autopilot.exe`。
4. 全新 `AUTOPILOT_HOME` 下该 exe 完成 init→daemon run→建需求→访问 dashboard→跑 phase 全链路，无「读不到框架资源」类崩溃。
5. dev 模式（`bun run …`）所有路径行为与改造前一致。

## 与后续子项目的边界

- **B（多平台验收）**：`build:exe:linux`/`:macos` 产物的实机端到端 + CI matrix。本 spec 只保证 script 存在、spawn 各平台分支写对，不做实机验收。
- **C（各平台 installer + 签名）**：NSIS/pkg/deb 打包、写 PATH/自启/卸载、代码签名证书。完全独立。
