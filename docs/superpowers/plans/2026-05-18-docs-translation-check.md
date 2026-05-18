# docs 中英文档同步检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CI 中对比 `docs/`（中文）与 `docs/en/`（英文）的文件列表，找出漏译文件，初期仅报告不阻断，后期一键切换为强制模式。

**Architecture:** 单文件 TypeScript 脚本（Bun 运行），通过内置 `fs` 模块遍历文件系统，无外部依赖；通过脚本顶部的 `ENFORCE_MODE` 布尔常量控制报告/强制两种模式；GitHub Actions `docs-translation` job 直接调用该脚本。

**Tech Stack:** Bun + TypeScript，Node.js 内置 `fs`/`path` 模块（无需 bun install），GitHub Actions。

---

## 1. 需求分析

### 背景

`docs/` 存放中文文档，`docs/en/` 存放对应英文翻译，两边文件数量不一致，需工具发现差距。

### 当前状态（截至 2026-05-18）

| 项目 | 状态 | 说明 |
|------|------|------|
| `scripts/check-docs-translation.ts` | ✅ 已实现（未提交） | 功能比需求更丰富：文件存在性 + 行数/标题内容对比 + `--strict` 模式 |
| `.github/workflows/ci.yml` docs-translation job | ✅ 已实现（未提交） | 触发条件：push/PR to main |
| `package.json` check:docs 脚本 | ✅ 已实现（未提交） | `bun run scripts/check-docs-translation.ts` |
| **报告模式（exit 0 on missing）** | ❌ 缺失 | 当前脚本有漏译文件时直接 exit 1，不符合"初期仅报告"需求 |

### 现有漏译文件（运行脚本可见）

`docs/en/` 中缺少（对比 `docs/` 顶层 .md，排除 `en/`, `superpowers/`, `screenshots/`）：
- `req-dev-workflow.md`
- `requirement-queue.md`
- `rpc-coverage.md`

### 功能需求确认

- **文件存在性对比**：`docs/foo.md` 存在但 `docs/en/foo.md` 不存在 → 报"漏译"
- **内容级对比**：本期不做（现有脚本已有此功能但不阻断）
- **CI 触发**：push 到 main + PR to main（已实现）
- **两阶段模式**：
  - **报告模式（初期）**：exit 0，打印漏译清单，CI 通过
  - **强制模式（后期）**：exit 1，阻断 PR；切换方式：改脚本顶部 `ENFORCE_MODE` 常量

---

## 2. 技术方案

### 文件结构

```
scripts/
└── check-docs-translation.ts   # 修改：添加 ENFORCE_MODE 常量，修复 exit 逻辑
.github/workflows/
└── ci.yml                      # 已有 docs-translation job，确认配置正确
package.json                    # 已有 check:docs / check:docs:strict，无需改动
```

### 核心改动：ENFORCE_MODE 常量

在脚本顶部配置区新增：

```typescript
// 切换到强制模式时将此常量改为 true（存量漏译补完后操作）
const ENFORCE_MODE = false;
```

修改退出码逻辑：

```typescript
// 报告模式：始终 exit 0，仅打印清单
// 强制模式：有漏译或严重内容差距时 exit 1
if (ENFORCE_MODE && hasHardFail) {
  console.log(`\n${RED}[enforce] 存在漏译或严重内容差距，退出码 1${RESET}\n`);
  process.exit(1);
}

// --strict 仍独立生效（无论 ENFORCE_MODE 如何）
if (STRICT && hasAnyIssue) {
  console.log(`\n${RED}[strict] 存在文档差异，退出码 1${RESET}\n`);
  process.exit(1);
}

process.exit(0);
```

### 模式说明

| 模式 | 配置 | CI 行为 |
|------|------|---------|
| 报告模式（初期） | `ENFORCE_MODE = false` | 打印清单，exit 0，CI 通过 |
| 强制模式（后期） | `ENFORCE_MODE = true` | 有漏译时 exit 1，CI 失败 |
| 超严格模式 | `bun run check:docs:strict` | 警告也失败（开发者本地用） |

---

## 3. 实现步骤

### Task 1：修复脚本 — 添加 ENFORCE_MODE，调整退出码逻辑

**Files:**
- Modify: `scripts/check-docs-translation.ts`

- [ ] **Step 1: 在配置区添加 ENFORCE_MODE 常量**

在 `const STRICT = process.argv.includes("--strict");` 这行后面加：

```typescript
// 初期保持 false（报告模式）；存量漏译补完后改为 true 切换到强制模式
const ENFORCE_MODE = false;
```

- [ ] **Step 2: 替换退出码逻辑块**

找到文件末尾从 `if (STRICT && hasAnyIssue)` 开始的退出逻辑，替换为：

```typescript
// ── 退出码 ────────────────────────────────────────────────────────

// --strict 超严格模式：警告也失败（开发者本地用）
if (STRICT && hasAnyIssue) {
  console.log(`\n${RED}[strict] 存在文档差异，退出码 1${RESET}\n`);
  process.exit(1);
}

// 强制模式：漏译或严重内容差距时失败（存量补完后切换）
if (ENFORCE_MODE && hasHardFail) {
  console.log(`\n${RED}[enforce] 存在漏译或严重内容差距，退出码 1${RESET}\n`);
  process.exit(1);
}

// 报告模式（默认）：打印清单，始终 exit 0
if (missing.length > 0 || fails.length > 0) {
  console.log(`\n${YELLOW}[report] 发现漏译文件，仅报告不阻断。补完后将 ENFORCE_MODE 改为 true。${RESET}\n`);
} else if (warns.length > 0) {
  console.log(`\n${YELLOW}有轻微内容差距但不阻断。如需严格检查，加 --strict 参数。${RESET}\n`);
} else {
  console.log(`\n${GREEN}所有文档中英对照无问题。${RESET}\n`);
}

process.exit(0);
```

- [ ] **Step 3: 本地验证脚本行为**

```bash
bun run scripts/check-docs-translation.ts
```

期望输出：打印漏译清单（req-dev-workflow.md、requirement-queue.md、rpc-coverage.md），结尾显示 `[report]` 提示，**退出码 0**。

验证退出码：
```bash
bun run scripts/check-docs-translation.ts; echo "exit: $?"
```
期望：`exit: 0`

- [ ] **Step 4: 验证 --strict 仍然生效**

```bash
bun run scripts/check-docs-translation.ts --strict; echo "exit: $?"
```
期望：因有漏译文件，`exit: 1`

- [ ] **Step 5: Commit 脚本**

```bash
git add scripts/check-docs-translation.ts
git commit -m "feat(docs): 添加中英文档同步检查脚本，初期报告模式"
```

---

### Task 2：确认并提交 CI 配置

**Files:**
- Modify: `.github/workflows/ci.yml`（已修改，确认内容正确）
- Modify: `package.json`（已修改，确认 scripts 已添加）

- [ ] **Step 1: 确认 ci.yml 中 docs-translation job 内容**

检查 `.github/workflows/ci.yml`，确保以下 job 存在且正确：

```yaml
docs-translation:
  name: 文档中英对照检查
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: latest
    # 不需要 bun install，脚本只用 Node 内置模块
    - name: 检查中英文档对照
      run: bun run scripts/check-docs-translation.ts
```

- [ ] **Step 2: 确认 package.json scripts**

检查 `package.json` 中存在：

```json
"check:docs": "bun run scripts/check-docs-translation.ts",
"check:docs:strict": "bun run scripts/check-docs-translation.ts --strict"
```

- [ ] **Step 3: Commit CI 和 package.json 变更**

```bash
git add .github/workflows/ci.yml package.json
git commit -m "ci: 添加 docs 中英对照检查 job"
```

---

### Task 3：补充 README / 使用说明（可选）

> 本步骤非阻断，仅在需要时执行

- [ ] **Step 1: 在 CLAUDE.md 或 docs/rpc-coverage.md 旁边的说明中添加切换指引**

在 `CLAUDE.md` 中，若有文档维护章节，或在 docs 根目录的 README.md（如有）补充：

```markdown
## 文档中英对照检查

- 检查脚本：`bun run check:docs`
- 严格模式：`bun run check:docs:strict`
- **切换为强制模式**（存量漏译补完后）：将 `scripts/check-docs-translation.ts`
  第一行常量 `ENFORCE_MODE = false` 改为 `true`，提交即生效
```

- [ ] **Step 2: Commit（若有改动）**

```bash
git add CLAUDE.md
git commit -m "docs: 补充 check-docs 切换说明"
```

---

## 4. 影响范围

| 模块 | 影响 | 说明 |
|------|------|------|
| `scripts/check-docs-translation.ts` | **修改** | 仅改退出码逻辑，不影响检查逻辑和输出格式 |
| `.github/workflows/ci.yml` | **新增 job** | 独立 job，不影响 typecheck / test job |
| `package.json` | **新增两条 scripts** | 仅 devScript，不影响产物 |
| 现有 CI 通过率 | **无影响（报告模式）** | 初期 exit 0，现有 PR 不受影响 |
| 文档文件本身 | **不修改** | 仅读取，不写入 |

### 回归风险

- **低**：脚本零外部依赖，读取文件系统，无副作用
- **注意**：切换 `ENFORCE_MODE = true` 后，若 docs/en/ 仍有漏译，所有含 CN 新文档的 PR 都会被阻断，需提前补完存量

---

## 5. 测试计划

### 本地测试

| 场景 | 操作 | 期望结果 |
|------|------|---------|
| 报告模式，有漏译 | `bun run check:docs` | 打印漏译清单，exit 0 |
| 报告模式，无漏译 | 临时在 docs/en/ 补齐所有文件后运行 | `所有文档中英对照无问题`，exit 0 |
| 强制模式，有漏译 | 改 `ENFORCE_MODE = true`，`bun run check:docs` | 打印清单，exit 1 |
| 强制模式，无漏译 | `ENFORCE_MODE = true`，docs/en/ 已补齐 | exit 0 |
| strict 模式 | `bun run check:docs:strict` | 有警告时 exit 1 |

### CI 验证

- [ ] 推送本次变更到 PR，确认 `docs-translation` job 通过（exit 0）
- [ ] 确认 job 在 GitHub Actions 中打印出漏译文件列表
- [ ] 确认 `typecheck` / `test` 两个 job 不受影响

### 切换为强制模式的前置条件检查

在执行 `ENFORCE_MODE = true` 切换前，运行：

```bash
bun run check:docs
```

确认输出中 `❌ 缺少英文版` 计数为 **0** 后再切换。

---

## 附：当前漏译文件清单（2026-05-18）

执行 `bun run check:docs` 可见：

```
docs/en/req-dev-workflow.md      （对应 docs/req-dev-workflow.md）
docs/en/requirement-queue.md     （对应 docs/requirement-queue.md）
docs/en/rpc-coverage.md          （对应 docs/rpc-coverage.md）
```

补完这 3 个文件后即可切换强制模式。
