# 工作流动态管理 设计文档

| | |
|---|---|
| 状态 | Draft |
| 日期 | 2026-05-07 |
| 作者 | larry |
| 上游依赖 | 需求队列 P1–P5 已落地（PR #25–#42） |

## 1. 背景与目标

### 1.1 现状

工作流目前**只能从文件系统加载**：

```
~/.autopilot/workflows/<name>/
├── workflow.yaml    ← 阶段定义
└── workflow.ts      ← 阶段函数实现
```

`src/core/registry.ts` 启动时扫这个目录，把每个子目录注册成一个工作流。用户要新增工作流必须：
1. 在文件系统手动建目录
2. 写 YAML
3. 写 TS（包括所有 phase 函数实现）
4. `daemon reload` 才能生效

不便之处：
- chat agent / Web UI 无法通过对话或图形化创建新工作流
- 临时改一下 phase 顺序、agent、timeout 都要改文件
- 已有工作流（如 `req_dev`）的"派生变体"成本高（拷整个目录）

### 1.2 目标

把工作流配置层（YAML）从纯文件提升到 **DB 主导 + 文件兼容**：

1. **DB 作为权威配置存储**：所有工作流都登记进 `workflows` 表（包括文件来源镜像）
2. **chat / CLI / Web UI 能动态创建工作流**：直接派生自现有 file 工作流，只调 YAML 部分
3. **文件工作流仍保留**：作为 phase 函数实现的载体（TS 不入 DB），git 管理友好
4. **同名/冲突检测**：启动时检查、报错前置

### 1.3 非目标（明确不做）

- ❌ **DB 存 TS 源码 + 沙箱 eval**：安全 / 依赖 / 调试三难，YAGNI
- ❌ **chat 让 LLM 生成全新 phase 函数 TS**：质量不稳定、调试黑盒；只允许复用已有 phase 函数库
- ❌ **运行时一次性工作流**（`autopilot run --prompt` 不入库）：现有 chat agent + req_dev 能覆盖大部分场景，YAGNI
- ❌ **跨机器同步 DB 工作流**：单 daemon、单 SQLite，不考虑多端同步
- ❌ **工作流版本管理 / undo**：DB 改动直接生效，靠 export 备份

## 2. 关键决策（已澄清）

| 维度 | 决策 | 原因 |
|---|---|---|
| 存储模型 | DB 是权威；文件作为 phase 函数实现载体 | 用户明确「配置移动到 DB 管理」 |
| TS 处理 | TS 仍在文件系统；DB 只存 YAML | DB 存 TS + eval 风险大；混合方案最务实 |
| chat 创建范围 | 仅改 YAML，复用已有 phase 函数库 | 安全 / 稳定；LLM 不写 TS |
| DB 工作流约束 | 必须 `derives_from` 一个 file 工作流 | phase 函数实现来自 file 的 TS，DB 工作流的 phase name 必须是 file 工作流 phase 集合的子集 |
| 文件工作流编辑 | 文件工作流在 DB 里只读（镜像）；要改去改文件 | 保持 git 单一权威；避免文件 / DB 不一致 |
| 启动时镜像 | daemon 启动扫文件 + 同步到 `workflows` 表 source=file | Web UI / chat tools 只查一个表，UX 一致 |
| 一次性工作流 | 不做（YAGNI） | 现有 chat agent 已覆盖 |
| 同名冲突 | daemon 启动失败、明确报错 | fail-fast，避免运行时迷惑 |

## 3. 数据模型

### 3.1 新增 `workflows` 表（migration 007）

```sql
CREATE TABLE IF NOT EXISTS workflows (
  name           TEXT PRIMARY KEY,
  description    TEXT NOT NULL DEFAULT '',
  yaml_content   TEXT NOT NULL,
  source         TEXT NOT NULL CHECK(source IN ('db', 'file')),
  derives_from   TEXT,        -- 仅 source=db 时必填
  file_path      TEXT,        -- 仅 source=file 时记录绝对路径
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK(
    (source = 'db'   AND derives_from IS NOT NULL AND file_path IS NULL) OR
    (source = 'file' AND derives_from IS NULL     AND file_path IS NOT NULL)
  )
);

CREATE INDEX idx_workflows_source ON workflows(source);
```

约束（应用层补充校验）：
- `derives_from` 指向的 workflow **必须 source=file**（不允许嵌套派生）
- DB 工作流 YAML 里的 phase name 必须 ⊆ derives_from 的 phase 集合
- 同名冲突：daemon 启动时如果发现 file 扫描结果和 DB 已有行 name 相同但 source 不同 → 启动失败

### 3.2 现有 `tasks` 表的兼容

`tasks.workflow` 列继续存 workflow name。任务创建时 `workflow_snapshot` 已经把 yaml + meta 落地到 task 行（manifest），DB 工作流改动不会影响已存在 task 的执行。

## 4. 架构改造

### 4.1 Registry 多源加载

`src/core/registry.ts::discover()` 改造：

```ts
function discover(): Map<string, WorkflowDefinition> {
  const result = new Map();

  // (1) 扫文件 → 同步到 workflows 表 source=file
  const fileWorkflows = scanFileWorkflowsDir();   // 现有逻辑
  syncFileWorkflowsToDb(fileWorkflows);            // 新：upsert source=file 行

  // (2) 从 DB 读所有 workflows
  const dbRows = listWorkflowsInDb();              // 含 source=file 镜像 + source=db

  // (3) 同名冲突检测（文件层和 DB 不一致）
  detectConflicts(fileWorkflows, dbRows);

  // (4) 解析每个工作流
  for (const row of dbRows) {
    if (row.source === "file") {
      // file workflow：从原 TS 文件加载 phase 函数（现有逻辑）
      const wf = loadFileWorkflow(row.file_path, row.yaml_content);
      result.set(row.name, wf);
    } else {
      // db workflow：从 derives_from 拿 phase 函数表
      const base = result.get(row.derives_from);
      if (!base) throw new Error(`DB workflow ${row.name} derives_from ${row.derives_from} 但后者不存在`);
      const wf = composeDbWorkflow(row.yaml_content, base);
      result.set(row.name, wf);
    }
  }
  return result;
}
```

`composeDbWorkflow(yaml, base)`：
- 解析 yaml 拿 phases 列表
- 校验 phase name 必须在 `base.phaseFunctions` 集合里
- 拷贝 phase 函数引用到新 workflow definition
- 返回 WorkflowDefinition（跟 file workflow 同结构）

### 4.2 同步逻辑：文件 → DB

`syncFileWorkflowsToDb(fileWfs)`：
- 对每个文件工作流计算 yaml_content 的简单 hash（或直接 string compare）
- 如果 DB 里已有同名 source=file 行：updated_at 更新、yaml_content 同步
- 如果 DB 里没有：插入新行
- 如果 DB 里有但文件里没了：删除 DB 行（文件被用户手动删的情况）
- DB 里 source=db 的工作流不受此同步影响

### 4.3 同名冲突处理

启动时检查：
- 如果文件扫描出现 `req_dev`（source=file），DB 里**碰巧**也有同名 source=db 行 → daemon 启动失败、log error 指明冲突点
- DB 工作流必须取不同 name（建议用 `req_dev_v2` / `my_req_dev` 等）

### 4.4 CLI workflow 子命令组

新增 `src/cli/workflow.ts`，注册到 `bin/autopilot.ts`：

```bash
autopilot workflow list                                    # 列表（带 source 列）
autopilot workflow show <name>                             # YAML + 元信息
autopilot workflow create <name> --derives-from req_dev    # 创建，进 EDITOR 编辑
                                                            # 默认初始内容 = derives_from 的 yaml
autopilot workflow create <name> --derives-from req_dev --from ./my.yaml
autopilot workflow edit <name>                             # 改 DB 工作流（file 报错）
autopilot workflow delete <name>                           # 仅 DB 可删（file 报错）
autopilot workflow export <name>                           # 输出 yaml 到 stdout
autopilot workflow import <new-name> --derives-from req_dev --from ./my.yaml
```

CLI 改动直接调 daemon REST：
- 新增 `GET /api/workflows`（已有，返回扩展 source/derives_from）
- 新增 `POST /api/workflows`（创建 DB 工作流）
- `PUT /api/workflows/:name/yaml`（已有，扩展校验：source=file 拒绝；source=db 校验 phase 集合）
- `DELETE /api/workflows/:name`（已有，扩展校验：source=file 拒绝）
- 新增 `GET /api/workflows/:name/export`（同 yaml 端点，纯 yaml 文本响应）

CRUD 后立即触发 `registry.reload()`（已有 `POST /api/reload`）。

### 4.5 chat tools 扩展

在 `src/agents/tools.ts` 加：

```ts
tool(
  "list_phase_functions",
  "列出 file 工作流可复用的 phase 函数。chat 创建 DB 工作流时必须从这里挑。",
  { workflow_name: z.string().describe("file workflow 名（如 req_dev）") },
  async (args) => { ... }
);

tool(
  "create_db_workflow",
  "创建 DB 工作流（必须 derives_from 一个 file workflow）。yaml_content 里 phase name 必须 ⊆ derives_from 的 phase 集合。",
  {
    name: z.string(),
    derives_from: z.string(),
    yaml_content: z.string(),
    description: z.string().optional(),
  },
  async (args) => { ... }
);

tool(
  "update_db_workflow",
  "更新 DB 工作流的 yaml_content。仅 source=db 工作流可改。",
  { name: z.string(), yaml_content: z.string() },
  async (args) => { ... }
);

tool(
  "delete_db_workflow",
  "删除 DB 工作流。仅 source=db 可删。",
  { name: z.string() },
  async (args) => { ... }
);
```

`list_workflows`（现有）扩展返回字段：增加 `source` / `derives_from`。

### 4.6 Web UI 适配

`/workflows` 现有页面改造：
- 列表区分 file / db 源（图标徽章：📁 file / 🗄 db）
- file 行：编辑 / 删除按钮 disabled，hover 提示「文件工作流只读，请改文件」
- db 行：编辑器照旧、可删
- 新增「派生新工作流」按钮（顶部）：弹 dialog 选 base file workflow + 输入新 name + 复制 yaml 到编辑器 → 保存触发 `POST /api/workflows`

### 4.7 删除级联

- 删 file 工作流：file 系统的目录被用户手动删 → 下次 `daemon reload` 同步从 DB 删除该 source=file 行
- 删 DB 工作流：直接 `DELETE FROM workflows WHERE name=? AND source='db'`；如果有派生关系（暂不支持嵌套派生）→ 不需要级联
- 任意工作流被删后，**已运行的 task 不受影响**（task.workflow_snapshot 已有 yaml 副本）

## 5. 关键交互流程示例

### 场景 A：用户在 chat 创建一个 req_dev 的派生（去掉 review 阶段）

```
[用户在 /chat] "我想要一个跟 req_dev 一样但跳过 design review 的工作流，叫 req_dev_fast"
  ↓
[chat agent]
  list_workflows() → 看到 req_dev source=file
  list_phase_functions(req_dev) → ["design", "review", "develop", "code_review", "submit_pr", "await_review", "fix_revision"]
  ↓ 询问用户：跳过哪些 phase？
[用户] "跳过 review，直接 design → develop"
  ↓
[chat agent]
  create_db_workflow(
    name="req_dev_fast",
    derives_from="req_dev",
    yaml_content="...phases: [design, develop, code_review, submit_pr, await_review, fix_revision]..."
  )
  ↓ daemon 加载、注册到 registry
[用户在 /chat] "用 req_dev_fast 提个新需求 ..."
  ↓
[chat agent] create_requirement_draft + ... + enqueue_requirement
  ↓ scheduler 拉走 → 跑 req_dev_fast → 缺 review，design 完直接 develop
```

### 场景 B：用户在 CLI 派生 + 导出

```bash
$ autopilot workflow list
NAME              SOURCE  DERIVES_FROM   DESCRIPTION
req_dev           file    -              需求驱动开发流程
my_quick_review   db      req_dev        快速审查（去掉 develop）

$ autopilot workflow show my_quick_review
# yaml + 元信息

$ autopilot workflow export my_quick_review > backup.yaml

$ autopilot workflow delete my_quick_review
✓ 已删除 DB 工作流 my_quick_review
```

### 场景 C：daemon 启动同名冲突

```
[daemon 启动]
  扫文件：发现 ~/.autopilot/workflows/req_dev_fast/workflow.yaml + workflow.ts
  扫 DB：发现 source=db / name=req_dev_fast 行
  ↓ 冲突检测
[daemon] FATAL: workflow name 冲突
  - file: ~/.autopilot/workflows/req_dev_fast/
  - db:   workflows row source=db
  请删除其一后重启 daemon。
```

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| chat 创建 DB 工作流时 derives_from 不存在 | tool 返回错误：「base workflow X 不存在」 |
| chat 创建时 yaml 包含 base 没有的 phase name | tool 返回错误：「phase X 不在 base req_dev 的函数集合内」 |
| chat 创建时 yaml 解析失败 | 返回 yaml 解析错误 + 行号 |
| 编辑 file 工作流（DB API 调到 source=file） | 返回 403：「文件工作流只读，请改文件后 daemon reload」 |
| 启动时同名冲突（file + db 都有同名） | daemon 启动失败、log error |
| 启动时 DB 工作流 derives_from 已不存在 | log error 跳过该 DB 工作流（其他工作流不受影响） |
| 启动时 DB 工作流 yaml 不合法 | log error 跳过 |
| 删 DB 工作流但有进行中的 task 引用它 | 允许删（task.workflow_snapshot 已有副本，不受影响） |
| daemon 同步文件工作流到 DB 时遇到 yaml 改变 | 自动 update yaml_content + updated_at；不报错 |

## 7. 测试策略

### 7.1 单元测试

- `migration 007`：表创建、约束（CHECK 子句）
- `syncFileWorkflowsToDb`：upsert / update / delete 三路径
- `composeDbWorkflow`：phase name 子集校验、phase 函数引用拷贝、yaml 解析
- `detectConflicts`：同名 file + db 同时存在 → 报错
- CLI 命令：每条 happy path + 错误路径
- chat tools：list / create / update / delete 各错误码

### 7.2 集成测试

- 启动 daemon → 文件镜像到 DB → list 包含所有
- chat 创建 DB 工作流 → 立即 task start 用该工作流 → 跑通
- 删 DB 工作流后 → 已有 task 仍能继续跑（manifest snapshot 起作用）
- 删 DB 工作流后 → 新 task 用该 name 失败

### 7.3 手工 e2e

- 启动 daemon → CLI `workflow create my_test --derives-from req_dev` → 改 yaml 跳掉 review → 跑通需求 → 验证 review 阶段被跳过

## 8. 分阶段交付（W 系列）

P5 类似的拆分，单 PR 闭环：

### W1：DB schema + registry 多源加载（基础）
- migration 007：workflows 表
- `src/core/workflows.ts`：CRUD（listWorkflows / createDbWorkflow / updateDbWorkflow / deleteDbWorkflow / syncFileWorkflowsToDb）
- `src/core/registry.ts` 改造：discover 多源
- 启动时同步 + 同名冲突检测
- 完整单元测试

### W2：CLI workflow 子命令组
- `src/cli/workflow.ts`：list / show / create / edit / delete / export / import
- `src/daemon/routes.ts`：扩展 `/api/workflows` POST + `:name/export`
- bin/autopilot.ts 注册新命令
- CLI 单测

### W3：chat tools + Web UI
- `src/agents/tools.ts`：list_phase_functions / create_db_workflow / update_db_workflow / delete_db_workflow
- `src/web/src/pages/Workflows.tsx`：列表 source 标识 + 「派生新工作流」按钮
- `src/web/src/hooks/useApi.ts`：扩展类型与方法
- E2E：chat 创建 → 立即跑 → 验证

各 sub-phase 独立可发布。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| chat agent 生成的 yaml 不合法 | tool 内做 yaml.parse + 校验 phase 子集；返回明确错误信息让 agent 重试 |
| derives_from 关系隐式断裂（base 文件被删） | startup 时校验，断裂的 DB 工作流跳过加载并 log error，不影响其他工作流 |
| 多个 DB 工作流共享 base，base yaml 改了行为 | 文档明确说明派生关系是「函数引用 + yaml 配置」分离的；base 改了 phase 函数会影响所有派生 |
| 启动时 DB 工作流加载顺序错（base 没先加载） | discover 按 source 排序：先 file 后 db；db 内部按 derives_from 拓扑（一层不需排序，因为禁止嵌套） |
| 用户用 CLI 改 file 工作流 yaml | 拒绝；提示改文件 + daemon reload |
| 用户在 EDITOR 改 yaml 时 daemon 还没跑 | CLI 命令实现里直接读 DB（不依赖 daemon），所以 daemon 没跑也能 list/show；但 create/edit 必须 daemon 跑（要触发 reload） |
| `daemon reload` 失败导致 registry 状态损坏 | reload 失败时回滚到上一份 registry 快照（实现上需要 atomic swap） |

## 10. 后续扩展（不在本次范围）

- chat / Web UI 让 LLM 编辑 phase 函数 TS（需安全沙箱 + 单元测试自动化）
- 工作流版本管理（workflows_history 表 + diff / rollback）
- 跨机器同步 DB 工作流（导出 + 导入到另一台 daemon）
- workflow 模板市场（用户分享派生工作流）
- DB 工作流支持嵌套派生（A derives_from B derives_from req_dev）

## 附录：实现复杂度估计

| Sub-phase | 估时 | 风险 |
|---|---|---|
| W1 DB schema + registry 多源 | 3.5 hr | 中（同步逻辑边界条件） |
| W2 CLI 命令组 | 2.5 hr | 低 |
| W3 chat tools + Web UI | 3 hr | 中（chat agent prompt 调试） |
| **总计** | **~9 hr** | |
