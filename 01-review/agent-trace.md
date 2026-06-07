# Phase: review

共 2 次 agent 调用

## #2 · 2026-06-07T05:37:25.294Z

> review · anthropic/claude-sonnet-4-6 · 97815 ms · input=3 · output=4893 · cost=$0.1574

### Prompt

```
你是一位技术评审专家。请评审以下技术方案是否满足需求。

## 需求
# 新建项目时同步关联工作区

## 背景
当前流程需要两步：先 `autopilot project create <name>`，再 `autopilot workspace create <alias> <path> -p <project-id>`。
用户希望在新建项目时，能一步完成「建项目 + 新建并关联工作区」，减少跳转。

## 已确认设计决策

### 交互模式
新建项目时，用户在同一条命令/操作中填入本地路径（及 alias）来**创建并绑定**一个新 Workspace，不支持从已注册列表中选择。

### 工作区关联：必填
`project create` 时**必须**同时提供工作区路径，不允许建空项目后再补绑。
（后续单独绑定仍可通过 `workspace create -p <id>` 完成，但不是本需求范围。）

### 目标客户端
**CLI + Web UI** 均需支持。

### CLI 参数设计
采用位置参数形式：

    autopilot project create <name> <path> [--alias <alias>]

### Workspace Alias
- 可省略：不填时自动从目录名推导（如 `/code/myapp` → alias `myapp`）
- 显式填写时以用户输入为准
- Alias 冲突由框架静默处理（对用户无感，自动追加后缀或重命名），不向用户暴露 alias 冲突报错

### 原子性策略
- **路径先校验**：执行任何写操作前先检查路径是否存在；路径不存在则报错退出，项目和工作区均不创建
- **不强制 git 仓库**：路径可以是普通目录，无需是 git 仓库
- **Git/GitHub 信息可选**：workspace 的 branch、GitHub remote 均可选，缺省时不填（与现有 `workspace create` 行为一致）

## 数据模型约束
- 每个 Project 最多有一个顶层 Workspace（`UNIQUE(project_id) WHERE parent_workspace_id IS NULL`）
- Workspace 需要 alias + 本地路径，可选 branch / GitHub remote


## 需求澄清记录

**问题 1：** 「选择工作区」这一步，你期望的交互是哪种？

- **A. 从已注册工作区里选**：项目建好后，从现有 workspace 列表里挑一个绑上去
- **B. 填路径新建工作区**：在建项目的同时，输入本地路径（+ alias）创建并绑定一个新 workspace
- **C. 两者都支持**：先看有没有现成的，没有就填路径新建

另外，这个关联步骤是「必填」（没选工作区就不让建项目）还是「可选」（可以先建项目，之后再补）？

**回答：** B：填路径新建 workspace

**问题 2：** 好的，确认是「填路径新建 workspace」一步完成。还有两点需要确认：

**① 关联工作区是必填还是可选？**
- **必填**：`project create` 时不提供 workspace 路径就报错，强制一步到位
- **可选**：允许先建一个空项目，之后再用 `workspace create -p <id>` 补绑

**② 目标客户端范围？**
- 仅 CLI
- CLI + Web UI 都要

**回答：** 必选，都要

**问题 3：** 好，必填 + CLI/Web 都要，已记录。还有两个小细节：

**① CLI 参数设计**（workspace 现在是必填的，命令怎么长？）
- **A. 位置参数**：`autopilot project create <name> <path> [--alias <alias>]`
- **B. 显式 flag**：`autopilot project create <name> --path <path> [--alias <alias>]`
- **C. 你来定**：贴出你期望的命令写法

**② Workspace alias 可否省略？**
- **可省略**：不填时自动从目录名推导（如 `/code/myapp` → alias `myapp`）
- **必填**：不填就报错

**回答：** A + alias 可省略（自动推导）

**问题 4：** 最后一个问题：**原子性处理**。

`autopilot project create myapp /code/myapp` 执行时，如果工作区路径校验失败
（路径不存在、不是 git 仓库、alias 已被占用等），项目这一边怎么处理？

- **A. 全部回滚**：路径有问题 → 项目也不创建，报错退出，用户重试整条命令
- **B. 部分成功**：项目先建好，workspace 失败单独报错，用户再手动 `workspace create -p <id>` 补
- **C. 看错误类型**：路径不存在 → 回滚；alias 冲突 → 仅 workspace 报错，项目保留

**回答：** 我认为要先检查路径，但不一定必须是git仓库，alias对用户无感

## 技术方案
<!-- generated:2026-06-07T05:35:47.450Z -->
计划文档已保存至 `docs/superpowers/plans/2026-06-07-project-create-with-workspace.md`。

---

## 技术方案全文

### 1. 需求分析

**痛点**：当前用户需要两步——`project create <name>` + `workspace create <alias> <path> -p <id>`——才能建起一个可用的项目工作台。工作区是项目真正有意义运转的前提，强制两步操作割裂了用户心智模型。

**已确认决策**：
| 决策点 | 结论 |
|--------|------|
| 工作区关联方式 | 填路径新建（不从已注册列表选） |
| 是否必填 | 必填——`project create` 时必须提供路径 |
| CLI 参数格式 | 位置参数：`project create <name> <path> [--alias]` |
| alias 省略 | 自动取目录名（`/code/myapp` → `myapp`） |
| alias 冲突 | 静默追加数字后缀（对用户不可见） |
| 路径校验 | 先检查是否存在，不要求是 git 仓库 |
| 原子性 | 路径不存在 → 全部回滚（项目和工作区均不创建） |

---

### 2. 技术方案

#### 分层职责

```
CLI / Web UI
  │  ① 收集 name + path + alias?
  │  ② 客户端预校验 path 存在（CLI）
  ▼
Daemon RPC: projects.createWithWorkspace
  │  ③ 服务端校验 path 存在（兜底）
  │  ④ detectWorkspaceGit(path) 获取可选 git 信息
  │  ⑤ 传入 alias?（省略则由 core 推导）
  ▼
Core: createProjectWithWorkspace（projects.ts）
  │  ⑥ deriveAlias(path) 推导 alias
  │  ⑦ resolveUniqueAlias(alias) 全局去重
  │  ⑧ db.transaction() { createProject + createWorkspace }
  ▼
SQLite（原子写）
```

**核心设计原则**：
- **path 存在性校验在两处**：CLI 侧做一次（快速失败、减少 daemon 往返），RPC 层做兜底（无论何种客户端调用均有保障）
- **alias 推导在 Core 层**：不在 RPC/CLI 泄漏这个逻辑，保证所有入口行为一致
- **事务原子性在 Core 层**：`db.transaction()` 包裹 `createProject` + `createWorkspace`，任一失败回滚
- **git 探测在 Daemon 层**：`detectWorkspaceGit` 是纯读操作，属于基础设施关注点，不属于 Core 业务

#### 新增接口/函数一览

| 层 | 新增内容 |
|---|---|
| `core/workspaces.ts` | `deriveAlias(dirPath): string` / `resolveUniqueAlias(baseAlias): string` |
| `core/projects.ts` | `CreateProjectWithWorkspaceOpts` 接口 / `createProjectWithWorkspace(opts): { project, workspace }` |
| `daemon/rpc-methods.ts` | `projects.createWithWorkspace` RPC 方法 |
| `client/http.ts` | `createProjectWithWorkspace(body): Promise<{ project, workspace }>` |
| `client/index.ts` | getter `createProjectWithWorkspace` |
| `web/hooks/useApi.ts` | `api.createProjectWithWorkspace(body)` |
| `web/pages/Library.tsx` | 扩展 `ProjectsTab` 对话框（path + alias 字段 + FolderPicker） |

---

### 3. 实现步骤

共 **9 个任务**，见计划文档每个 Task 中的逐步 checkbox：

1. **Task 1**：`deriveAlias` + `resolveUniqueAlias`（workspaces.ts）
2. **Task 2**：`createProjectWithWorkspace` 原子函数（projects.ts）
3. **Task 3**：`projects.createWithWorkspace` RPC（rpc-methods.ts）
4. **Task 4**：Client 包装层（http.ts + index.ts）
5. **Task 5**：CLI 命令签名更新（project.ts）
6. **Task 6**：Web api 对象新增方法（useApi.ts）
7. **Task 7**：Web UI 对话框添加路径字段（Library.tsx）
8. **Task 8**：更新受影响的现有 CLI 测试
9. **Task 9**：新增 CLI 集成测试

---

### 4. 影响范围

| 范围 | 影响 |
|------|------|
| **Breaking Change** | `autopilot project create <name>` 旧签名失效，必须提供 `<path>`。已有脚本/文档需同步更新。 |
| **向后兼容** | `projects.create` RPC 仍保留（用于编辑等其他场景）；`projects.addWorkspace` 不变 |
| **Web UI 编辑流程** | 编辑项目对话框（`editingProject != null`）不受影响，依然只改 name/description |
| **ProjectDetail.tsx 工作区** | 不受影响，仍可在项目详情页单独管理工作区 |
| **数据层** | 无 migration，无 schema 变化；仅使用现有 `projects`/`workspaces` 表 |
| **现有测试** | `tests/cli-project.test.ts` 中 2 个测试需更新（已在 Task 8 覆盖） |

---

### 5. 测试计划

| 场景 | 测试位置 | 类型 |
|------|---------|------|
| 路径不存在 → exit 2 | `cli-project-with-workspace.test.ts` | CLI 集成 |
| name 为空 → exit 2 | `cli-project-with-workspace.test.ts` | CLI 集成 |
| 路径存在但 daemon 未起 → daemon 错误 | `cli-project-with-workspace.test.ts` | CLI 集成 |
| 路径校验错误优先于 daemon 检查 | `cli-project-with-workspace.test.ts` | CLI 集成 |
| 帮助文本含 `<path>` 和 `--alias` | `cli-project-with-workspace.test.ts` | CLI 集成 |
| 旧测试：daemon 未起场景 | `cli-project.test.ts`（更新） | CLI 集成 |
| 旧测试：name 为空 | `cli-project.test.ts`（更新） | CLI 集成 |
| alias 冲突静默去重 | 通过 daemon 端到端验证（需 daemon 运行） | E2E |
| 非 git 目录也可成功创建 | 通过 daemon 端到端验证 | E2E |

---

**计划完整保存至** `docs/superpowers/plans/2026-06-07-project-create-with-workspace.md`。

**两种执行方式：**

**1. 子 Agent 驱动（推荐）** — 每个 Task 派发独立子 Agent，任务间 review，迭代快

**2. 本会话内联执行** — 在此会话中逐 Task 执行，每个 Task 结束后 checkpoint review

请问选择哪种方式开始执行？

请从以下维度评审：完整性、可行性、风险点、测试覆盖。

最后必须输出以下结论之一（独占一行）：
- REVIEW_RESULT: PASS
- REVIEW_RESULT: REJECT

如果驳回，请在 ## 驳回理由 下说明具体问题。
```

### Result

## 技术方案评审报告

### 一、完整性

#### ✅ 覆盖到位的部分
- 分层职责清晰（CLI → RPC → Core → DB）
- 原子性策略在核心层用事务保障
- Breaking Change 已明确标注
- alias 推导和去重有明确归属层（Core）
- 两处路径校验（CLI + RPC 兜底）是正确的防御性设计

#### ❌ 遗漏或模糊的部分

**[Critical] Web UI 的路径输入方式存在根本性缺陷**

方案中写了「FolderPicker」组件，但 autopilot 的 Web UI 是浏览器运行的 React SPA（非 Electron）。浏览器安全沙箱下：
- `<input type="file" webkitdirectory>` 返回 `File` 对象，但**浏览器会故意隐藏真实路径**（`file.path` 在 Chromium 上为空或被截断），不能还原为服务器本地的完整绝对路径
- File System Access API 可拿到句柄但同样无法获得本地 POSIX/Windows 路径字符串

Web 端的正确做法只有两种：
1. **纯文本输入框**（用户手动输入路径字符串），不叫「FolderPicker」
2. **服务端目录浏览 RPC**（daemon 提供 `/api/fs/browse` 接口，Web UI 展示服务器侧目录树）

方案中未说明选择哪种，直接写 `FolderPicker` 将误导实现者走入不可行的方向。

---

**[Important] 成功响应格式未定义**

alias 冲突时会「静默追加数字后缀」，但方案未定义成功输出包含什么。用户无法知道实际生效的 alias 是什么（可能已变为 `myapp-2`）。CLI 和 Web UI 都应在成功后展示：
- project id
- workspace id
- **实际使用的 alias**（重点）

---

**[Important] `resolveUniqueAlias` 的去重范围未明确**

是「全局所有 workspace 中唯一」还是「同一 project 内唯一」？两种语义不同，实现也不同。当前 workspaces 表结构下 alias 是全局唯一键，应明确说清楚，否则实现者可能写错作用域。

---

**[Important] `createProjectWithWorkspace` 核心函数缺乏单元测试**

测试计划里，alias 冲突静默去重和「非 git 目录也可创建」两个场景都标注为「需 daemon 运行的 E2E 测试」。这两个场景实际上是 Core 层的业务逻辑，应当有独立的 `bun:test` 单元测试，不应全部依赖 E2E 才能覆盖。

---

### 二、可行性

| 子方案 | 结论 |
|--------|------|
| CLI 实现 | ✅ 可行，位置参数 + Commander 的常规做法 |
| Core 层事务原子性 | ✅ 可行，SQLite `db.transaction()` 够用；workspace 注册是纯 DB 操作，无 FS 副作用需要回滚 |
| RPC 层新增 | ✅ 可行，模式与现有 RPC 一致 |
| Web UI FolderPicker | ❌ **不可行**，需要改为文本输入或服务端目录浏览 |
| alias 去重 | ✅ 可行，但需明确去重范围 |

---

### 三、风险点

| 级别 | 风险 | 说明 |
|------|------|------|
| Critical | Web UI 路径输入实现路径错误 | FolderPicker 在纯 SPA 下无法获得本地路径，必须澄清实现方式再开始 Web UI 部分 |
| Important | Breaking Change 无过渡方案 | 旧命令 `project create <name>`（无 `<path>`）直接失效，无警告提示。对于有 CI 脚本的用户影响较大；建议至少给出明确的错误提示文案 |
| Important | 成功后 alias 对用户不透明 | 静默去重后用户不知道实际 alias，后续 `workspace list` 才能找到，体验差 |
| Minor | 路径不存在的错误文案缺失 | 方案说「报错退出」但未定义具体错误信息格式，容易各处实现不一致 |
| Minor | git 探测时机与顺序 | `detectWorkspaceGit` 在 RPC 层，CLI 侧路径校验通过后 daemon 才探测；如果探测本身慢（大仓库），用户感知延迟，可考虑是否需要超时 |

---

### 四、测试覆盖

| 评估维度 | 结论 |
|----------|------|
| 负向路径（路径不存在、name 空）| ✅ 有覆盖 |
| alias 自动推导正确性 | ❌ 缺少单元测试 |
| alias 冲突去重后返回正确 alias | ❌ 仅 E2E，无单元测试 |
| 非 git 目录成功创建 | ❌ 仅 E2E |
| 事务回滚（模拟 createWorkspace 失败）| ❌ 未覆盖 |
| Web UI 路径校验错误回显 | ❌ 完全缺失 |

---

REVIEW_RESULT: REJECT

## 驳回理由

1. **[Critical] Web UI FolderPicker 实现路径不可行**：浏览器无法获取本地路径字符串，必须在方案中明确替代方案（文本输入框 or 服务端目录浏览 RPC），否则实现阶段必然返工。

2. **[Important] 成功输出未定义**：alias 会被静默修改，方案必须规定 CLI 和 Web 在成功后展示实际生效的 alias，否则用户体验有明显缺陷。

3. **[Important] `resolveUniqueAlias` 去重范围不明确**：全局 vs 项目内——语义不同，实现不同，必须在方案中显式声明。

4. **[Important] 核心逻辑缺少单元测试**：alias 推导、去重、事务回滚均属于 Core 层业务逻辑，应有可独立运行的 `bun:test` 单元测试，不应全依赖 daemon 启动后的 E2E 验证。

---

## #4 · 2026-06-07T05:48:36.868Z

> review · anthropic/claude-sonnet-4-6 · 56136 ms · input=3 · output=2885 · cost=$0.0866

### Prompt

```
你是一位技术评审专家。请评审以下技术方案是否满足需求。

## 需求
# 新建项目时同步关联工作区

## 背景
当前流程需要两步：先 `autopilot project create <name>`，再 `autopilot workspace create <alias> <path> -p <project-id>`。
用户希望在新建项目时，能一步完成「建项目 + 新建并关联工作区」，减少跳转。

## 已确认设计决策

### 交互模式
新建项目时，用户在同一条命令/操作中填入本地路径（及 alias）来**创建并绑定**一个新 Workspace，不支持从已注册列表中选择。

### 工作区关联：必填
`project create` 时**必须**同时提供工作区路径，不允许建空项目后再补绑。
（后续单独绑定仍可通过 `workspace create -p <id>` 完成，但不是本需求范围。）

### 目标客户端
**CLI + Web UI** 均需支持。

### CLI 参数设计
采用位置参数形式：

    autopilot project create <name> <path> [--alias <alias>]

### Workspace Alias
- 可省略：不填时自动从目录名推导（如 `/code/myapp` → alias `myapp`）
- 显式填写时以用户输入为准
- Alias 冲突由框架静默处理（对用户无感，自动追加后缀或重命名），不向用户暴露 alias 冲突报错

### 原子性策略
- **路径先校验**：执行任何写操作前先检查路径是否存在；路径不存在则报错退出，项目和工作区均不创建
- **不强制 git 仓库**：路径可以是普通目录，无需是 git 仓库
- **Git/GitHub 信息可选**：workspace 的 branch、GitHub remote 均可选，缺省时不填（与现有 `workspace create` 行为一致）

## 数据模型约束
- 每个 Project 最多有一个顶层 Workspace（`UNIQUE(project_id) WHERE parent_workspace_id IS NULL`）
- Workspace 需要 alias + 本地路径，可选 branch / GitHub remote


## 需求澄清记录

**问题 1：** 「选择工作区」这一步，你期望的交互是哪种？

- **A. 从已注册工作区里选**：项目建好后，从现有 workspace 列表里挑一个绑上去
- **B. 填路径新建工作区**：在建项目的同时，输入本地路径（+ alias）创建并绑定一个新 workspace
- **C. 两者都支持**：先看有没有现成的，没有就填路径新建

另外，这个关联步骤是「必填」（没选工作区就不让建项目）还是「可选」（可以先建项目，之后再补）？

**回答：** B：填路径新建 workspace

**问题 2：** 好的，确认是「填路径新建 workspace」一步完成。还有两点需要确认：

**① 关联工作区是必填还是可选？**
- **必填**：`project create` 时不提供 workspace 路径就报错，强制一步到位
- **可选**：允许先建一个空项目，之后再用 `workspace create -p <id>` 补绑

**② 目标客户端范围？**
- 仅 CLI
- CLI + Web UI 都要

**回答：** 必选，都要

**问题 3：** 好，必填 + CLI/Web 都要，已记录。还有两个小细节：

**① CLI 参数设计**（workspace 现在是必填的，命令怎么长？）
- **A. 位置参数**：`autopilot project create <name> <path> [--alias <alias>]`
- **B. 显式 flag**：`autopilot project create <name> --path <path> [--alias <alias>]`
- **C. 你来定**：贴出你期望的命令写法

**② Workspace alias 可否省略？**
- **可省略**：不填时自动从目录名推导（如 `/code/myapp` → alias `myapp`）
- **必填**：不填就报错

**回答：** A + alias 可省略（自动推导）

**问题 4：** 最后一个问题：**原子性处理**。

`autopilot project create myapp /code/myapp` 执行时，如果工作区路径校验失败
（路径不存在、不是 git 仓库、alias 已被占用等），项目这一边怎么处理？

- **A. 全部回滚**：路径有问题 → 项目也不创建，报错退出，用户重试整条命令
- **B. 部分成功**：项目先建好，workspace 失败单独报错，用户再手动 `workspace create -p <id>` 补
- **C. 看错误类型**：路径不存在 → 回滚；alias 冲突 → 仅 workspace 报错，项目保留

**回答：** 我认为要先检查路径，但不一定必须是git仓库，alias对用户无感

## 技术方案
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

请从以下维度评审：完整性、可行性、风险点、测试覆盖。

最后必须输出以下结论之一（独占一行）：
- REVIEW_RESULT: PASS
- REVIEW_RESULT: REJECT

如果驳回，请在 ## 驳回理由 下说明具体问题。
```

### Result

## 技术方案评审报告（第二轮）

### 针对驳回点的逐条核查

#### [Critical] FolderPicker → daemon 服务端目录 RPC ✅

方案改为通过 `api.browseFs()` 调用 daemon 侧接口，绕开浏览器 File API 的安全限制，并声称 `ProjectDetail.tsx` 已有先例。这是正确的技术路径。

**一个前提风险**：方案断言 `browseFs()` 已存在，但未在任务列表中列出「新增 browseFs RPC」。如果这个接口实际上不存在，Task 8（Web UI）会在实现时才发现缺口，导致返工。建议在执行 Task 8 前先确认该接口确实已落地。

#### [Important] 成功输出格式 ✅

方案现在定义了精确文案，CLI 输出实际生效的 alias（含后缀追加结果），Web toast 同步展示。问题已解决。

#### [Important] resolveUniqueAlias 去重范围 ✅

明确「全局跨所有 project_id」，Task 2 SQL 无 `project_id` 过滤条件。问题已解决。

#### [Important] Core 单元测试 ✅

Task 1 新增 16 个测试（TDD 红灯先行），使用 `_setDbForTest` + 内存 DB，不依赖 daemon。覆盖纯函数、DB 写入、集成场景。问题已解决。

---

### 本轮新发现的问题

#### [Minor] 事务回滚场景是否在 4 个 DB 测试中？

摘要未明确说明 4 个 DB 测试的具体内容。「createWorkspace 在事务中失败 → project 回滚」是最关键的原子性验证，应确保 16 个测试里有这一条。

#### [Minor] `<path>` 省略时的报错文案

旧命令 `autopilot project create <name>`（不带 path）变为非法。Commander.js 会抛出默认的参数错误，但默认提示不够友好。建议补一行自定义错误文案，引导用户补充 `<path>`。

#### [Minor] Web UI 路径输入的 inline 错误提示

用户通过 browseFs 选好路径后提交，若 daemon 在写库时发现路径校验失败（例如并发删除），错误应以 inline 形式展示在路径字段旁，而非只有全局 toast。方案中未涉及此细节，留给实现阶段决策即可，但要确保不被遗漏。

---

### 综合评估

| 维度 | 结论 |
|------|------|
| **完整性** | ✅ 四条驳回均已设计覆盖；browseFs 前提需实现前验证 |
| **可行性** | ✅ daemon RPC + 内存 DB 测试方案均可行 |
| **风险点** | 仅剩 `browseFs()` 是否真实存在这一个待确认项，其余风险已收敛 |
| **测试覆盖** | ✅ 16 个单元测试 + 现有 CLI 集成测试更新；建议确认事务回滚场景已包含 |

---

REVIEW_RESULT: PASS

---
