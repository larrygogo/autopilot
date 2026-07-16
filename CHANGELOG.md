# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 兼容性说明

当前处于 `0.x` 阶段，**任何 minor 版本都可能包含破坏性变更**（YAML 格式、CLI 参数、数据库 schema 等）。

升级前请查看对应版本的 **Breaking Changes** 章节，按迁移步骤操作。数据库变更通过 `autopilot upgrade` 自动迁移，YAML/CLI 变更会在此文档中提供手动迁移说明。

`1.0` 发布后将严格遵守语义化版本：patch = bugfix，minor = 向后兼容的新功能，major = 破坏性变更。

## [未发布]

### Added

- **DB 定期维护（P2 长跑健康）**：daemon 每日跑 `maintainDb()`（`VACUUM` 压实主库 + `PRAGMA wal_checkpoint(TRUNCATE)` 回收 WAL）——此前 workflow.db / -wal 只增不缩（删任务 / 通知 prune 后页面不归还 OS）。不在启动时立即跑（VACUUM 重写整库、频繁重启会空跑徒增延迟），与 run-phase 并发写竞争时 busy_timeout 后 SQLITE_BUSY 由 try/catch 跳过本轮。实测：8.6MB 膨胀库 VACUUM 后回收到 303KB。
- **runner 可观测性（P1）**：
  - **`autopilot daemon logs`**：新增查看 daemon 主日志的 CLI（`-n/--tail` 行数、`-f/--follow` 跟踪）——此前 `daemon.log` RPC 已就绪但只有 Web 能看，CLI 看主日志得手动 cat 文件。区别于 `task logs`（状态机转换日志），`daemon logs` 是 daemon 进程自身的运行日志。日志路径打到 stderr、内容打到 stdout（便于管道）；`--follow` 因 `daemon.log` 是 tail 快照 RPC（无专用 WS 流）走末行锚点轮询打增量（无轮转时精确，轮转滚出锚点则回退整段重打）。client 加 `getDaemonLog`。
  - **supervisor 重启历史暴露到 `daemon status`**：supervisor 的重启次数 / 崩因 / 崩溃循环此前全在内存、外部看不到。现落 `runtime/supervisor.state.json`（`daemon_spawns` / `restarts` / `last_exit_code` / `last_crash_at` / `crash_loop`），supervisor 在启动 / 每次 spawn / 每次崩溃时更新（全 try/catch 静默，绝不影响崩溃恢复主循环），`daemon status` 直读展示「daemon 启动次数 · 崩溃重启 · 上次崩溃 code/时间」。真崩溃-重启实机验证通过（强杀 worker → 重启 + restarts+1 + 记录崩因）。
- **开机自启 / 系统服务（子项目 C · runner 无人值守长跑）**：新增 `autopilot service install/uninstall/status`，把 daemon 注册为**用户级、免管理员**的系统自启服务——Linux systemd user unit（+ enable-linger）、macOS launchd LaunchAgent、Windows HKCU Run 注册表键（登录自启，零提权；schtasks ONLOGON 在根任务目录实测非提权 shell 报 Access denied，故改用与 OneDrive 等同款的 Run 键渠道）。模型 = 让 OS 服务管理器成为**最外层看护**，开机时前台跑 `daemon run --supervise`：内部 supervisor 管进程崩溃快恢复，OS 管「机器重启拉起」+「supervisor 自身退出后重启」两件 supervisor 兜不住的事，两层看护正交补上「重启不回来」缺口。托管命令由 `daemonSpawnPlan(supervise:true)` 统一裁决（与 `daemon start` 同一真相源，编译版走 `<exe> daemon run --supervise`、dev 走 `bun run supervisor.ts`）。三平台服务描述文件的生成器抽为纯函数 + 单测（含空格路径引号、XML 转义、Run 键命令值引号）。`install --dry-run` 只打印将写入的 unit/plist 内容与将执行的命令、不改动系统（跨平台预览 / 无提权验证）。Windows 侧实机往返验证通过（reg add → 查回引号完整 → reg delete → 确认清空）。
- **发版交付管道：GitHub Release 附带三平台 exe 资产（子项目 C · 交付第一步）**：`release.yml` 重构为 `guard（版本闸门 + 测试）→ build（三平台原生 build:exe + smoke-exe 冒烟 + 重命名平台资产名）→ release（下载资产 + 抽 CHANGELOG + 建 Release 并 attach files）` 三段串行。此前 `build-exe.yml` 与 `release.yml` 在 tag 推送时是两个互不衔接的 job —— exe 只进 7 天 artifacts，Release 里无二进制，用户下不到；现补齐后 `git push v*` 即产出「一个 Release = 三平台 exe（`autopilot-windows-x64.exe` / `autopilot-linux-x64` / `autopilot-macos-arm64`）+ 发布说明」。`build-exe.yml` 收敛为纯 `workflow_dispatch` 手动多平台冒烟（tag 路径交给 release.yml，避免双份三平台编译）。README 安装章节新增「下载预编译单文件」为首选路径。尚未做：代码签名（Gatekeeper/SmartScreen 拦截）、install 脚本 / 包管理器渠道、macOS x64、编译版更新通知。
- **单文件可执行安装包（子项目 A · 核心单文件化）**：`bun run build:exe` 用 `bun build --compile` 产出真单文件 `dist/autopilot.exe`（前端 web-dist 用 `with { type: "file" }` 嵌入 + 资源清单，迁移与 examples 模板 codegen 成静态注册表，进程 spawn 编译模式哨兵走 `process.execPath` 子命令）。四类「运行时从磁盘读框架自带资源」障碍改为编译期嵌入/静态分析，dev 与编译走同一代码路径（CI 校验生成物一致性防漂移）。含三平台交叉编译 `build:exe:{win,linux,macos}`。多平台实机验收与各平台 installer + 代码签名为后续子项目 B/C。

### Removed

- **移除 TUI 客户端**：observer-only 的 ink 终端界面（`src/tui/`、`autopilot tui` 命令、`ink`/`ink-spinner` 依赖）整体删除。原因：功能不追决策对等、维护价值低，且 ink 依赖树（`react-devtools-core` 等）阻塞单文件 `bun build --compile` 打包。终端里盯进度改用 CLI —— `autopilot task status` / `autopilot task logs --follow` / `autopilot notifications list`。

## [0.1.0] - 2026-06-17

版本号体系重置：此前代码内的 `1.0.0` 是从未随发布变动的占位符，与实际发布节奏脱节。现把版本号收敛为**单一真相源** `package.json`（`src/index.ts` 的 `VERSION`、daemon status、CLI `--version`、MCP serverInfo、WS 握手全部从此取值），并从 `0.1.0` 重新计数。

> 旧的 `v0.3.0` tag 与对应 GitHub Release（Python→TS 重写里程碑）已随本次重置移除——版本号回到 `0.1.0` 后它们不再代表当前发布。下方 `[0.3.0]` 条目仅作**历史内容记录**保留（不再有对应 tag / release）。

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
