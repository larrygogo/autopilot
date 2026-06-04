# codebase → workspace 全量重命名 + 项目:工作区 1:1 实现计划

> 日期：2026-06-04
> 范围：core / daemon / cli / web / migrations / config / workflow.yaml + 用户磁盘文件迁移
> 状态：设计已定（方案 A），待执行

## 决策（用户已拍板）

1. **方案 A 全量 rename**：内核 `codebase` 概念 → `workspace`（表/RPC/id 前缀/类型/列全改）。
2. **腾名**：现有的「任务运行工作区」（每 task 的 git worktree 运行目录）→ **`sandbox`**。
3. **硬切 + 自动迁移**：CLI/TUI/Web 同步改，无外部消费者；迁移/upgrade 时自动把用户 `~/.autopilot/config.yaml`、`workflow.yaml` 旧名改新名。不留别名 cruft。
4. **项目:工作区 1:1**：每个 project ≤1 个顶层工作区（`parent_workspace_id IS NULL`），submodule 不计入。迁移先扫冲突，**有违例则中止报错**让用户手动整理。

## 必须的执行顺序

`workspace` 这个名当前被任务沙盒占用，所以：
**Phase 1（腾名 sandbox） → Phase 2（codebase→workspace） → Phase 3（1:1 约束）**。顺序不可颠倒。

## 现状量级（architect 盘点）

- codebase 概念：~673 处 / 35 文件。表 `codebases`/`requirement_codebases`/`requirements.codebase_id`/`requirement_sub_prs.child_codebase_id`；id 前缀 `cb-`；RPC `codebases.*` + `projects.codebases`/`addCodebase` + `setup.saveCodebases`；CLI `codebase` 命令；类型 `Codebase`/`CodebaseRef`/`CreateCodebaseOpts`/...；迁移 006/008/009/023；UI 多页。
- workspace（沙盒）概念：~259 处 / 23 文件。`core/workspace.ts`（70 处）；类型 `WorkspaceConfig`/`WorktreeMeta`/...；RPC `workspaces.*`；config `workspace_retention`；workflow.yaml `workspace:` 段；UI `WorkspaceBrowser` + TaskDetail tab；HTTP `/api/tasks/:id/ws/*`。

## 回归红线（architect 标出，最危险）

1. `requirement-scheduler.ts` 的 parent+submodule 调度组（`tickRepo`，`groupId = parent_codebase_id ?? id`，组内串行）——rename + 1:1 不能破坏 submodule parent 链。
2. `deleteCodebase` 级联事务（删顶层级联 submodule + 清 requirement 外键 + 删多对多）。
3. `task-factory.ts` 的 codebase_id 透传 → `CodebaseRef` → `ensureTaskWorkspace`——这是 codebase↔sandbox **唯一交汇点**；存量 `.worktree.json` 里的 `codebase_id`/`codebase_path` 字段要兼容。
4. `requirement_codebases` 多对多：1:1 后语义收窄但**不删表**（requirement 可碰主仓+部分 submodule）。
5. `useApi.ts:126-135` 的 `/api/codebases/*` SSR 白名单残留——清理。
6. SQLite 表/列改名：`ALTER TABLE codebases RENAME TO workspaces`、`ALTER TABLE ... RENAME COLUMN codebase_id TO workspace_id`（SQLite 3.25+ 支持）；id 前缀 `cb-→ws-` 用 UPDATE REPLACE，连同所有外键列。

---

## Phase 1：任务工作区 → sandbox（腾名）

不动 DB（沙盒是文件系统概念）。重命名标识符 + RPC + config 段 + workflow.yaml 段 + UI + HTTP，并自动迁移用户文件。

- `src/core/workspace.ts → sandbox.ts`：`ensureTaskWorkspace→ensureTaskSandbox`、`getTaskWorkspace→getTaskSandbox`、`deleteTaskWorkspace→deleteTaskSandbox`、`WorkspaceConfig→SandboxConfig`、`WorktreeMeta` 字段保持但文件名 `.worktree.json` 可留（git worktree 仍叫 worktree）。
- RPC `workspaces.* → sandboxes.*`（tree/file/delete/usage）。web client + WorkspaceBrowser + TaskDetail tab 同步。
- config `workspace_retention → sandbox_retention`（`config.ts` 读取改新名；**upgrade/migrate 自动改写用户 config.yaml**）。
- workflow.yaml `workspace:` 段 → `sandbox:`（registry/yaml 解析改新名；**`workflow sync`/upgrade 自动改写用户 workflow.yaml**，或解析层暂兼容读旧名并提示）。
- HTTP `/api/tasks/:id/ws/* → /sandbox/*`。
- UI：`WorkspaceBrowser.tsx → SandboxBrowser.tsx`，TaskDetail tab label「工作区」此处暂不动（Phase 2 再定，因为 Phase 2 后"工作区"=codebase）。
- 验证：`bun test` + `bun run typecheck` + `bun run build:web` + `smoke-test` 全绿；起一个任务确认 sandbox 目录照常建。
- 多个 commit（feat(core)/feat(daemon)/feat(web)/feat(migrate)）。

## Phase 2：codebase → workspace（占名）

- DB 迁移（新文件，参考 008 范式，表重建或 ALTER RENAME）：
  - `codebases → workspaces` 表；`requirement_codebases → requirement_workspaces`（列 `codebase_id→workspace_id`）；`requirements.codebase_id → workspace_id`；`requirement_sub_prs.child_codebase_id → child_workspace_id`；`codebases.parent_codebase_id → parent_workspace_id`。
  - id 前缀 `cb- → ws-`：UPDATE REPLACE 所有 id 及引用它的外键列。
  - 索引同步改名。
- 代码：`core/codebases.ts → workspaces.ts`、`nextCodebaseId→nextWorkspaceId`、类型 `Codebase→Workspace`/`CodebaseRef→WorkspaceRef`/`CreateCodebaseOpts→...`、`codebase-health.ts→workspace-health.ts`、`submodules.ts` 内部旧变量名一并清。
- RPC `codebases.* → workspaces.*`、`projects.codebases→projects.workspaces`、`projects.addCodebase→addWorkspace`、`setup.saveCodebases→saveWorkspaces`。
- CLI `codebase` 命令 → `workspace`（`src/cli/codebase.ts → workspace.ts`），`task start --repo` 含义不变（仍指 workspace alias）。
- web：`useApi.ts` 类型 + 方法名、所有页面（ProjectDetail/Start/Setup/RequirementDetail），中文「工作区」已就位（上一提交），英文 eyebrow `CODEBASES→WORKSPACES`、变量改名。清 `/api/codebases` 白名单残留。
- 验证全绿 + 起任务 + 建工作区端到端。
- 多 commit。

## Phase 3：项目:工作区 1:1 约束

- 迁移：先扫 `SELECT project_id,COUNT(*) FROM workspaces WHERE parent_workspace_id IS NULL GROUP BY project_id HAVING COUNT(*)>1`；**有冲突 → 迁移 throw 报错并列出违例 project**，让用户手动整理后重跑。无冲突 → 建部分唯一索引 `UNIQUE(project_id) WHERE parent_workspace_id IS NULL`。
- 应用层守卫：`createWorkspace`/`projects.addWorkspace` 前查 project 是否已有顶层工作区，有则拒（友好错误）。
- web：ProjectDetail「添加工作区」在已有工作区时禁用/隐藏，提示"每个项目仅一个工作区"。
- 验证全绿。

---

## 收尾

- 更新 CLAUDE.md 数据模型：`Project ⊃ Workspace(1:1) ⊃ Submodule`；workspace=用户代码库（ws-NNN），sandbox=任务运行沙盒；明确两概念区分。
- 更新 docs/ 相关。

## 回退

- Phase 1/2 含 DB 迁移（表/列改名、id 前缀转换），**不是纯可回退**——属"方案 A 必然代价"，用户已知情接受。每 Phase 独立 commit，必要时可 `git revert` 代码 + 写反向迁移。
- 建议每 Phase 跑完先 dogfood 验证再进下一 Phase。
