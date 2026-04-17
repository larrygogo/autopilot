# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 兼容性说明

当前处于 `0.x` 阶段，**任何 minor 版本都可能包含破坏性变更**（YAML 格式、CLI 参数、数据库 schema 等）。

升级前请查看对应版本的 **Breaking Changes** 章节，按迁移步骤操作。数据库变更通过 `autopilot upgrade` 自动迁移，YAML/CLI 变更会在此文档中提供手动迁移说明。

`1.0` 发布后将严格遵守语义化版本：patch = bugfix，minor = 向后兼容的新功能，major = 破坏性变更。

## [0.3.0] - 2026-04-17

完整重写为 TypeScript + Bun，新增 daemon 架构、Web UI 和图形化工作流编辑器。Python 版本保留在 `v0.2.0` 标签。

### Added

**运行时与架构**

- 从 Python 完整迁移到 TypeScript + Bun，功能对等
- Daemon + 多客户端架构：核心作为长驻进程，TUI / Web / CLI 通过 HTTP + WebSocket 接入
- 事件总线（懒激活）：daemon 未运行时 emit 为 no-op，对独立 CLI 调用透明
- CLI 薄客户端：`daemon start/stop/run/status`、`task start/status/cancel/logs`、`workflow list`、`tui`、`dashboard`

**Web UI**

- Bun.serve 同源 HTTP + WS 统一服务，自带静态资源托管
- 导航：Dashboard / 任务 / 工作流 / 配置（二级 tab：模型提供商 / 智能体 / 高级 YAML）
- Dashboard：daemon 状态、最近任务、卡住任务预警（30 分钟未更新）
- 任务列表：搜索、状态过滤、工作流过滤；移动端卡片视图
- 任务详情：流水线视图、状态机图、实时日志（粘底自动滚动 / 手动暂停）、取消任务
- 工作流：创建 / 删除、阶段可视化 CRUD、并行块编辑、智能体覆盖
- 全局 Toast（分级 + 错误可展开详情可复制）、组件化 Modal / ConfirmDialog
- 移动端响应式：侧边栏抽屉菜单、全断点适配

**工作流图形化编辑器**

- 阶段：inline 编辑名称 / 超时；驳回目标下拉（只能往回跳）；上下移动；删除
- 并行块：新建 / 删除 / 拆解；`fail_strategy` 下拉；子阶段内移动
- 顶级阶段 ↔ 并行块互迁（移入 / 移出）
- `workflow.ts` 同步：改名自动重命名 `run_<旧>` → `run_<新>`（保留函数体）；新增阶段自动追加脚手架函数；孤儿函数一键清理（字符级 tokenizer + 花括号平衡，跳过字符串 / 注释）
- `workflow.ts` 只读 code viewer（极简语法高亮 + 与 PhaseEditor/ 状态机图的 hover 联动）
- 流水线视图：横向显示阶段流，并行块 fork/join，current state 高亮
- 三方 hover 联动：流水线 ↔ PhaseEditor ↔ 状态机图

**模型提供商与智能体**

- Providers 页：Anthropic / OpenAI / Google 三家 CLI（凭证由 CLI 自身管理）
- 全局智能体 CRUD：name / provider / model / max_turns / permission_mode / system_prompt / extends
- 智能体三层配置：全局 → 工作流覆盖 → 运行时 RunOptions；各级可 partial 覆盖
- 工作流级智能体覆盖 UI（独立于全局智能体管理）
- 引用关系：Providers 卡片显示使用该 provider 的 agent 数；Agents 列表显示被哪些工作流引用；删除时列出影响面

**Agent 运行时**

- 内置三家 Agent 提供商：`@anthropic-ai/claude-agent-sdk`、`@openai/codex`、`@google/gemini-cli-sdk`
- RunOptions 支持运行时覆盖 `system_prompt` / `additional_system` / `model` / `max_turns`
- Agent 缓存：同一工作流内复用同名 agent 实例

**安全与加固**

- CORS 白名单（默认同源）+ 可选 `AUTOPILOT_API_TOKEN` 鉴权
- 静态资源路径穿越防护：`resolve` + 前缀校验、拒绝 NUL 字符
- WebSocket 断线自动重连 + pending 订阅刷新
- Bun.serve `idleTimeout` 提升到 120s（daemon 场景默认 10s 太激进）

### Changed

- 项目名称从 `claude-code-workflow` 统一为 `autopilot`
- YAML 工作流函数签名：`run_<phase>(taskId: string): Promise<void>`（此前脚手架错误生成 `ctx: {task, log}` 签名）
- 配置存放约定：全局 `config.yaml` 仅放共享基础设施（providers / agents），工作流专属字段放各自目录

### Fixed

- Bun 动态 `import()` 模块缓存导致 `syncWorkflowTs` 追加的新 `run_` 函数永远不被加载：`import(path?t=<mtime>)` bust
- `Modal` useEffect 依赖内联 `onClose` 导致输入框每次按键失焦：拆分 effect + 用 ref 读最新回调
- `Drawer` 内 `<nav>` 继承外层 `<nav>` 全局样式挤压布局：顶部 nav 加 `.topbar` 作用域
- `providers.api_key_env` 误导：CLI 自身管理凭证，字段从未被消费，移除
- 移动端全局 `overflow-x`、输入控件字号 ≥ 16px 防 iOS 自动放大
- 以及若干 CI / typecheck / 移动端兼容性修复

### Breaking Changes

- **重写为 Bun 运行时**：Python 版本不再维护，`pip install` 不再可用；需使用 `bun install`
- **CLI 入口重命名**：`workflow` → `autopilot`
- **工作流函数签名**：阶段函数接收 `taskId: string`（不是 context 对象），从旧版迁移需改签名 + 自行 `getTask(taskId)`
- **全局配置结构**：`providers.*` 与 `agents.*` 成为框架识别的命名段；工作流专属字段请迁出
- **最小 Bun 版本**：`^1.3`

### Migration

从 0.2.0（Python）升级：

1. 安装 Bun 1.3+
2. `git clone` 新版 → `bun install`
3. `bun run dev init`（创建 `~/.autopilot/`）→ `bun run dev upgrade`（数据库迁移）
4. 工作流迁移：
   - `.py` 阶段函数改写为 `.ts`，签名 `(taskId: string): Promise<void>`
   - `workflow.yaml` 格式不变，但放在 `AUTOPILOT_HOME/workflows/<name>/` 下（与 `workflow.ts` 配对）
5. CLI 命令从 `workflow ...` 改为 `autopilot ...`

## [0.2.0] - 2026-03-17

### Added

- 第三方插件系统：通过 `entry_points` 自动发现和注册扩展（通知后端 / CLI 命令 / 全局钩子）
- 示例工作流添加 `[AI]` 标签标识 AI 驱动的工作流

### Changed

- 简化 `dev` 示例工作流，移除特定集成依赖
- 简化 `req_review` 示例工作流，移除特定集成依赖
- 移除框架核心中的 `default_branch` 硬编码

## [0.1.0] - 2026-03-15

### Added

- 核心状态机引擎，支持原子性状态转换
- YAML 声明式工作流定义，状态自动推导
- Push 模型：阶段完成后非阻塞启动下一阶段
- 并行阶段支持：`parallel:` 语法 + fork/join + 失败策略
- 跳转机制（驳回/前向跳转）：`reject` 语法糖 + `jump_trigger`/`jump_target`
- SQLite 持久化 + 数据库迁移引擎
- 文件锁并发安全保护
- Watcher 卡死任务检测与自动恢复
- 插件化工作流自动发现（`AUTOPILOT_HOME/workflows/`）
- 多后端通知系统（webhook / command）
- 统一 CLI（start / list / show / cancel / stats / workflows / validate / init / upgrade / watch）
- 用户空间分离（`AUTOPILOT_HOME`）
- 5 个示例工作流：dev / req_review / doc_gen / parallel_build / data_pipeline
- 完整双语文档（中文 + English）
- CI/CD：ruff lint + pytest 多版本矩阵测试

### Changed

- `reject_trigger`/`retry_target` 统一重命名为 `jump_trigger`/`jump_target`
- `knowledge/` 目录重命名为 `docs/`
- git 操作和 `run_claude()` 从框架核心移至示例工作流
- 移除框架核心中的工作流专属默认值

[0.3.0]: https://github.com/larrygogo/autopilot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/larrygogo/autopilot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/larrygogo/autopilot/releases/tag/v0.1.0
