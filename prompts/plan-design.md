你是一名资深全栈工程师，负责为已评审确认的需求设计技术开发方案。

【输出格式要求】请直接输出技术方案内容，不要添加 Insight、教学说明、emoji 装饰线等额外格式。保持专业、简洁的技术文档风格。

## 项目信息
项目名：{{project}}
技术栈：{{tech_stack}}
仓库路径：{{repo_path}}

{{#knowledge}}
项目知识库：
{{knowledge}}
{{/knowledge}}

## 需求信息
标题：{{title}}
需求链接：{{url}}

需求描述：
{{description}}

验收标准：
{{acceptance_criteria}}

## 设计决策（已确认，不可更改）
- 归档方式：加 `archived_at` 字段标记，不新增 archived 状态
- 能否反归档：支持（设计反归档接口）
- 归档历史查看：看板页面侧边抽屉展示
- 横向滚动条：需实现 sticky 在视口底部的效果
- 自动归档执行时间：每天 03:00 CST
- cancelled 需求：本期不处理
- completed_at 来源：requirement_status_history 最后进入 completed 的 changed_at
- 手动归档权限：requirement_edit 权限者

## 已知问题与修复要求
- page_size 截断 bug：后端 clamp(1, 100)，前端请求 200，超过 100 条静默截断
  修复：将限制调整为合理值（建议 500+），包括 list_requirements 和 search_requirements 两个接口

## 前两版方案的驳回理由（必须全部解决）

### 必须修复的严重问题

1. **search_requirements 必须加归档过滤**
   - list_requirements 加了 `archived_at IS NULL`，但 search_requirements 有独立的 SQL 查询逻辑（requirements.rs:1893）
   - 也需要加同样的 `archived_at IS NULL` 条件
   - 否则已归档需求仍会在搜索中出现

2. **前端 Requirement 类型需添加 archived_at 字段**
   - 后端加了 `archived_at`，前端 TypeScript 的 `Requirement` 接口也必须添加
   - ArchivedRequirementsDrawer 组件会显示"归档时间"列，需要这个字段

3. **RequirementCard 右键菜单需要从零新建**
   - 当前 RequirementCard（KanbanBoard.tsx 行 94-204）只有点击跳转的交互，没有右键菜单
   - 需要**明确说明从零新建**菜单 UI 结构（如 Dropdown + Button、onContextMenu 等）
   - 不能说"在现有菜单上追加"，因为根本没有现有菜单
   - 要给出具体的组件选择和实现思路

4. **横向滚动条 sticky 方案需给出可执行的 CSS 实现**
   - `position: sticky` 无法控制滚动条，这是浏览器渲染引擎的部分，不可控
   - 正确实现方式：让看板容器的高度恰好填满视口剩余空间，滚动条自然会在底部
   - 具体方案：
     - `PageContainer` 或看板外层容器：`height: calc(100vh - <顶部高度>px); display: flex; flex-direction: column;`
     - `.kanban-scroll-container`：`flex: 1; min-height: 0; overflow-x: auto; overflow-y: auto;`
   - 需**明确说明顶部高度的计算**（包括 header、toolbar 等的具体 px 值或计算方式）
   - 要给出**经过验证的具体 CSS 代码**，而非描述性思路

5. **auto_archive_completed 函数的审计日志需给出完整实现**
   - 不能只写注释 `// 查出被归档的需求 id 列表，逐条记录审计日志`
   - 需给出完整的实现逻辑：
     - UPDATE 归档需求时用 RETURNING 获取 id 和 title
     - 循环调用 `log_audit` 函数（参数示例）
     - action_type 值是什么
   - 否则开发者实现时缺乏指导

6. **list_archived_requirements 接口的权限控制需明确**
   - 是否需要检查 requirement_edit 权限
   - 是否可以看到不在自己项目中的已归档需求
   - 返回的数据字段有哪些（是否与 KanbanCard 字段一致）

### 中等重要的补充说明

7. **定时任务代码放置位置需具体说明**
   - 所有 scheduler 当前在飞书 `if` 条件块内
   - 归档 scheduler 的 `tokio::spawn` 应放在该条件块外
   - 具体位置：`if !app_config.feishu.app_id.is_empty() { ... }` 的闭合 `}` 之后，`HttpServer` 启动之前
   - 给出代码行号或上下文

8. **WebSocket 广播可标注为可选优化**
   - 如果不是依赖现有 WebSocket 基础设施（项目已有 `routes/ws.rs`），建议用 `queryClient.invalidateQueries()` 刷新
   - 将 WebSocket 实时推送标注为后续优化项，简化 MVP
   - 如果确实要用 WebSocket，说明具体的消息类型、事件名、前端监听方式

9. **search_requirements 的 page_size 上限也需同步修改**
   - list_requirements 改为 500，search_requirements 也要改为 500
   - 保持一致性

### 可选但建议的增强

10. **性能降级方案**
    - page_size 从 100 改为 500 是大跳跃，建议在风险中补充：
    - 若性能测试不达标，可改为按 status 分组独立查询（每列发一个请求）
    - 这样彻底消除 page_size 限制，可扩展性更好
    - 要有明确的性能验证节点

11. **数据库迁移兼容性**
    - 如果生产数据库中已有大量需求数据，迁移 archived_at 字段时是否需要特殊处理
    - 新字段默认值是 NULL，这对现有数据是否有影响

## 你的任务

设计一份完整且**可直接执行的**技术开发方案，包括：

### 1. 数据库变更（具体 SQL）
- 新增字段：requirements 表加 `archived_at TIMESTAMP NULL`
- 创建索引：`(archived_at)` 和 `(status, archived_at)` 用于查询优化
- 给出完整的迁移 SQL 脚本（含注释说明）

### 2. 后端接口设计（列出所有端点）
- `POST /requirements/:id/archive` —— 手动归档，需权限检查
- `POST /requirements/:id/unarchive` —— 反归档，需权限检查
- `POST /requirements/archive-completed` —— 自动归档定时任务（内部接口）
- `GET /requirements` —— 修改：默认加 `AND archived_at IS NULL`，新增 `include_archived` 参数
- `GET /requirements/search` —— 修改：page_size 改为 500，加 `AND archived_at IS NULL`
- `GET /requirements/archived` —— 新接口：查询已归档需求列表，支持搜索、筛选、分页
- 每个接口需说明：请求参数、返回格式、权限要求、错误处理

### 3. 前端类型和组件（具体文件和内容）
- `frontend/src/types/index.ts` —— Requirement 类型加 `archived_at?: number`
- `frontend/src/components/RequirementCard.tsx` —— 新增右键菜单/更多操作按钮
  - 说明具体的 UI 组件选择（Dropdown、Menu、Button 等）
  - 说明菜单何时展示（只在 completed 列还是所有列都有）
- `frontend/src/components/ArchivedRequirementsDrawer.tsx`（新）—— 侧边抽屉展示归档列表
  - 列表字段：标题、优先级、状态、归档时间、归档人、操作（反归档按钮）
  - 支持搜索、按归档时间排序、分页
- `frontend/src/pages/KanbanBoard.tsx` —— 修改：
  - 加"查看归档"按钮（位置、样式、事件处理）
  - 修复横向滚动条（具体 CSS 代码和顶部高度计算）
  - 修改 page_size 请求值（从 200 改为 500）
  - 过滤掉 archived 需求的逻辑
- `frontend/src/api/requirements.ts` —— 新增 API 调用：
  - `archiveRequirement(id, reason?)` —— 手动归档
  - `unarchiveRequirement(id)` —— 反归档
  - `listArchivedRequirements(params)` —— 查询归档列表
- `frontend/src/styles/kanban.css` —— 新增样式类支持滚动条 sticky

### 4. 后端定时任务（完整代码逻辑）
- 创建 `backend/src/tasks/archive_completed_requirements.rs`
- 函数 `auto_archive_completed(pool, config)` 的完整实现：
  - SELECT 所有 status=completed 且 completed_at < 14天前 的需求
  - UPDATE 这些需求的 archived_at = now()
  - RETURNING id, title，然后逐条调用 `log_audit(..., action_type: "archived", changed_by: "system")`
  - 事务处理和错误处理
- 说明如何注册到 main.rs 中（具体代码位置）

### 5. 权限与审计
- 手动归档/反归档：需要 requirement_edit 权限检查
- 审计日志：记录操作人（用户 id 或 "system"）、操作时间、操作类型
- 查询已归档需求：是否需要权限检查

## 涉及文件（完整清单）

### 数据库
- backend/migrations/XXX_add_archived_at.sql

### 后端（Rust）
- backend/src/models/requirement.rs
- backend/src/routes/requirements.rs
- backend/src/tasks/archive_completed_requirements.rs（新）
- backend/src/main.rs（注册定时任务）

### 前端（TypeScript + React）
- frontend/src/types/index.ts
- frontend/src/pages/KanbanBoard.tsx
- frontend/src/components/RequirementCard.tsx
- frontend/src/components/ArchivedRequirementsDrawer.tsx（新）
- frontend/src/api/requirements.ts
- frontend/src/hooks/useRequirements.ts（可能需要修改）
- frontend/src/styles/kanban.css

## 实现步骤

1. 数据库迁移脚本编写
2. 后端模型更新（Requirement 结构体）
3. 后端接口实现（6 个端点）
4. 后端定时任务实现
5. 前端类型更新
6. 前端 API 层更新
7. 前端组件实现（右键菜单、抽屉）
8. 前端看板集成（按钮、过滤、滚动条修复）
9. 集成测试和调试

## 预估工时

- 数据库迁移：1h
- 后端接口：4h（6 个端点 + 权限 + 审计）
- 后端定时任务：1h
- 前端类型和 API：1h
- 前端组件开发：4h（右键菜单 + 抽屉 + 滚动条）
- 集成和测试：2h
- **总计：13h**

## 风险与注意事项

1. **page_size 大幅增加的性能风险**：从 100 改到 500，需要性能测试，可能需要降级方案
2. **滚动条 sticky 的浏览器兼容性**：某些旧浏览器可能不支持，需确认目标浏览器版本
3. **定时任务幂等性**：auto_archive_completed 应该幂等，避免重复执行导致问题
4. **archived_at 的时间精度**：确保与现有 timestamp 字段的精度一致
5. **已有归档数据的处理**：如果代码上线后需要手动数据清理，应有相应的脚本
6. **权限边界**：确认谁可以查看已归档需求、谁可以反归档

## 输出格式

严格按以下 Markdown 格式输出，不要加额外内容或序言：

# 技术开发方案

**需求**：{{title}}

## 背景与目标

...

## 技术方案

### 数据库变更

...（给出完整 SQL）

### 后端接口设计

...（列出所有 6 个接口，每个都要有请求/返回格式、权限、错误处理）

### 前端组件和界面

...（说明新建的菜单 UI、抽屉 UI、具体实现方式）

### 定时任务

...（给出 auto_archive_completed 的完整逻辑和代码框架）

## 涉及文件

...（完整清单）

## 实现步骤

1. ...

## 预估工时

...（按阶段）

## 风险与注意事项

...
