# docs 中英文档同步检查 — 完成报告

**Status:** ✅ **已完成并提交**

## 执行摘要

于 2026-05-19 完成了全部实现任务。脚本已集成到 GitHub Actions CI 流程中，初期以报告模式运行（exit 0），不阻断任何 PR。

---

## 完成情况

| Task | 状态 | 详情 |
|------|------|------|
| Task 1: 脚本实现 | ✅ 已提交 | commit `e3071aa`，包含 ENFORCE_MODE + EXEMPT_FILES |
| Task 2: CI 集成 | ✅ 已提交 | `.github/workflows/ci.yml` 已添加 `docs-translation` job |
| Task 3: package.json | ✅ 已提交 | `check:docs` / `check:docs:strict` 脚本已添加 |

### Task 1 详情（commit e3071aa）

**新增功能：**
- `ENFORCE_MODE = false` 常量，控制报告/强制模式切换
- `EXEMPT_FILES` 白名单，豁免非文档类文件翻译要求：
  - `dogfood-log.md` — 项目自用记录，中文 first-class
  - `rpc-coverage.md` — 自动生成的覆盖矩阵（不可手工维护英文版）

**退出码行为：**
- **报告模式（当前）**：`ENFORCE_MODE = false` → exit 0（打印清单但不阻断 CI）
- **强制模式（后期）**：改为 `ENFORCE_MODE = true` → exit 1（阻断 PR）
- **严格模式**：`bun run check:docs:strict` → 警告也 exit 1（开发者本地用）

---

## 当前状态

### 脚本运行结果（`bun run check:docs`）

```
状态    文件                               中文行  英文行   比例   标题差
────────────────────────────────────────────────────────────────────────
✅ architecture.md                  294     295      100%   EN 少 2
✅ faq.md                           233     235      101%   =
✅ plugin-development.md            381     381      100%   =
✅ quickstart.md                    324     316      98%    =
❌ req-dev-workflow.md              146     -        -      -    ← 漏译
❌ requirement-queue.md             200     -        -      -    ← 漏译
✅ state-machine.md                 330     331      100%   =
⚠️  workflow-development.md          629     476      76%    EN 少 4 ← 内容差距

汇总：✅ 5 个  ⚠️ 1 个警告  ❌ 2 个漏译

Exit Code: 0 ✓  [report] 发现漏译文件，仅报告不阻断
```

### 豁免规则（EXEMPT_FILES）

现已豁免：
- `dogfood-log.md`
- `rpc-coverage.md`

这两个文件不再报"漏译"。

### 待补齐的漏译文件

| 文件 | 位置 | 优先级 |
|------|------|--------|
| `req-dev-workflow.md` | `docs/en/` | **高** — 设计文档，应翻译 |
| `requirement-queue.md` | `docs/en/` | **高** — 设计文档，应翻译 |

### 内容差距警告

| 文件 | 问题 | 建议 |
|------|------|--------|
| `workflow-development.md` | 英文版 476 行（中文 629 行），缺 4 个标题 | 补全英文章节 |

---

## CI 集成状态

**GitHub Actions 配置已生效：**

```yaml
# .github/workflows/ci.yml
docs-translation:
  name: 文档中英对照检查
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun run scripts/check-docs-translation.ts
```

**触发时机：**
- PR to main
- push to main

**当前行为：**
- ✅ exit 0（不阻断 PR）
- 打印中英文档对照报告，列出漏译和内容差距

---

## 如何切换到强制模式

存量漏译文件补完后（即 `req-dev-workflow.md` 和 `requirement-queue.md` 的英文版都已创建），执行：

```bash
# 编辑脚本，改一行常量
# scripts/check-docs-translation.ts 第 40 行
const ENFORCE_MODE = false;  # 改为 true

# 提交
git add scripts/check-docs-translation.ts
git commit -m "ci(docs): 切换文档检查为强制模式"
```

**切换后的行为：**
- 若有漏译文件 → exit 1，**阻断 PR**
- 若只有轻微内容差距（`--strict` 才算） → exit 0，不阻断

---

## 开发者指南

### 本地检查

```bash
# 报告模式（默认）：仅打印，exit 0
bun run check:docs

# 严格模式：警告也失败，用于本地 lint
bun run check:docs:strict
```

### 豁免新文件

若某个 CN 文档不需翻译（如新增工具输出快照），在脚本中加白名单：

```typescript
const EXEMPT_FILES = new Set([
  "dogfood-log.md",
  "rpc-coverage.md",
  "your-tool-output.md",  # 新加
]);
```

---

## 下一步

1. **补齐漏译文件（优先级高）**
   - `docs/en/req-dev-workflow.md`
   - `docs/en/requirement-queue.md`
   - `docs/en/workflow-development.md`（补齐内容，至少 85% 行数比）

2. **切换强制模式（在步骤 1 完成后）**
   - 改 `ENFORCE_MODE = true`
   - 提交并推送

3. **验证强制模式生效**
   - 在 PR 中测试，确认有新漏译文件时 CI 失败

---

## 技术细节

### 脚本逻辑

1. **扫描文件**：遍历 `docs/` 下所有 `.md` 文件，排除 `en/`, `superpowers/`, `screenshots/`
2. **对比配对**：`docs/foo.md` ↔ `docs/en/foo.md`
3. **检查内容**：行数、标题数、内容比例
4. **豁免处理**：`EXEMPT_FILES` 白名单文件不计入漏译
5. **输出报告**：彩色表格 + 汇总
6. **退出码**：由 `ENFORCE_MODE` + `STRICT` 共同决定

### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `ENFORCE_MODE` | `false` | 强制模式开关 |
| `WARN_RATIO` | 0.85 | 行数比低于此值触发警告 |
| `FAIL_RATIO` | 0.70 | 行数比低于此值在 enforce/strict 下失败 |
| `HEADING_DIFF_WARN` | 2 | 标题差超过此数触发警告 |

---

## 问题排查

**Q: CI 忽然红了，报"漏译"**
A: 检查是否新增了中文文档。若英文版确实暂时没有，两选项：
   1. 临时加 EXEMPT_FILES 豁免
   2. 赶快翻译（推荐长期方案）

**Q: 我改了 docs/en/foo.md，但脚本还是报"内容差距"**
A: 运行 `bun run check:docs` 看当前比例。行数比 < 85% 时触发警告，< 70% 时在 enforce/strict 下失败。补齐至 85%+ 消除警告。

**Q: 怎么强制通过某个文件的警告？**
A: 三种方式：
   1. 真的补齐英文内容（推荐）
   2. 加 EXEMPT_FILES 豁免（仅限确实不需翻的文件）
   3. 改 `WARN_RATIO` 阈值（不推荐，会降低整体质量）

---

**Plan 文档：** [2026-05-18-docs-translation-check.md](./2026-05-18-docs-translation-check.md)

**实现状态：** ✅ 已完成  
**提交时间：** 2026-05-19 07:09  
**提交 ID：** `e3071aa`  
**作者：** larry
