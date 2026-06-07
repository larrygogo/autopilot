<!-- generated:2026-06-07T05:47:40.711Z -->
计划已写完并保存至 `docs/superpowers/plans/2026-06-07-project-create-with-workspace.md`。

已在计划中逐一解决全部 4 条驳回意见：

| 驳回点 | 修订内容 |
|--------|---------|
| **[Critical] FolderPicker 不可行** | 设计决策第 1 条 + Task 8 注释明确：该组件通过 `api.browseFs()` 调用 daemon 服务端目录 RPC，不是浏览器 File API，`ProjectDetail.tsx` 已有先例 |
| **[Important] 成功输出未定义** | 设计决策第 3 条定义精确文案表格；CLI 展示 `workspace.alias`（含实际追加后缀的结果）；Web toast 含实际 alias |
| **[Important] resolveUniqueAlias 范围不明确** | 设计决策第 2 条明确「全局（跨所有 project_id）」+ Task 2 SQL 无 `project_id` 过滤 |
| **[Important] Core 缺少单元测试** | Task 1 新增 `tests/core-create-project-with-workspace.test.ts`（16 个测试：5 纯函数 + 4 DB + 7 集成），使用项目已有的 `_setDbForTest` + 内存 DB 模式，TDD 先写红灯再实现 |

---

**现在有两种执行选项：**

**1. Subagent 驱动（推荐）** — 每个 Task 派一个 fresh subagent，我在两个 Task 之间审查，迭代快

**2. 内联执行** — 在本 session 中直接逐步执行（executing-plans），有检查点确认

请选择哪种方式？