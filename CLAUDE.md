# autopilot

轻量级多阶段任务编排引擎，基于状态机 + Push 模型 + 插件化工作流。

**运行时**：Bun (TypeScript)

## 产品分层定位

> 这是项目的**第一性设计理念**。所有 subagent（pm/designer/architect/qa）在做产品/设计/架构判断时，应先在此对齐再下结论。

**内核（功能最全、语义最底层、最稳定）**

- `src/core/` 引擎层（状态机、runner、registry、db、watcher）
- `src/daemon/` 服务层（HTTP+WS server、RPC、event-bus、routes）
- `src/agents/` Agent 系统（provider 适配、Agent 基础类）
- **WS RPC 协议本身**（method 命名空间是内核对外的契约）

内核掌握"能做什么"的完整集合。一切上层 UI 只是它的不同 affordance，不应私藏业务概念或绕过内核。内核变化先在 core / daemon / agents / 协议上落地，UI 跟上。

**三套客户端 — 面向同一开发者的三种模式，不是三类不同的人**

autopilot 的真实用户是同一个开发者（能跑本地 daemon、配 YAML 工作流、管 Agent 凭证的人）。三套 UI 是他在不同**时刻**切换的 affordance，不是给三种不同人群的产品。不要在画像上虚构"无关技术/非技术的决策者"——服务的始终是同一个开发者，只是他放松到决策模式下的自己。

| 客户端 | 切到此 UI 的时刻 | 设计重心 | 投入级别 |
|--------|----------------|---------|---------|
| **Web** | **决策时刻** — 该批 / 该驳 / 该调方向时 | 可视化决策台，主战场。业务标签（"通过审批"）**叠加**内核名（`review_pass`）而非替换 —— 让放松状态下的自己读得顺，但懂行的自己仍能反向映射回 CLI。状态完整性优先，操作确认到位。 | **一等公民** |
| **CLI** | **自动化时刻** — 写脚本、CI/CD、远程 ssh | 与内核 1:1 暴露面。命令完整、参数显式、退出码可用。保留 `--trigger review_pass` 等原始语义，是内核的最薄壳。 | **一等公民** |
| **TUI** | **持续观察时刻** — tmux 里盯进度、看日志 | observer-only 视图。只保留"低成本盯进度"主线，决策动作跳转到 Web / CLI 完成，**不追功能对等**。 | **二等公民**（观察镜像） |

**落地原则**

- Web / CLI 是一等公民，新功能必须同时覆盖；TUI 只覆盖观察路径，不强求决策路径对等
- **内核不为某个 UI 妥协命名** —— 客户端层负责翻译。Web 上业务标签与内核名**叠加显示**（hover / 详情侧栏 / 操作历史同时露出 trigger 名），不是替换；让懂行用户能反向映射，不懂的人可忽略
- 添加新功能时先问三连：「决策时刻要不要点这个按钮？自动化要不要调这个？观察时要不要看这条信息？」前两个决定它在 Web / CLI 怎么长，第三个决定 TUI 是否补
- 警惕 Web 的业务语言反渗内核：trigger 改名压力必须挡在客户端层，不能让 state-machine 退让
- **工作流自定义的产品支持范围 = PR 交付形态的定制轴**（2026-06-12 定位声明）：澄清 / 按仓库调度 / PR 验收 / fix_revision 修复回路 / CI 自动修复这些增值服务全部长在「需求 → PR」闭环上（bridge 按「有无交付 PR」泛化判断、不认 phase 名——自定义工作流只要最终交付 PR，全套照拿）；「自定义」指定制这条管线（加阶段、换 phase agent、调驳回、并行块），**不是任意流程编排平台**。非 PR 形态示例（doc_gen / data_pipeline / prompt_quick 等）是引擎能力演示（docs/state-machine.md 等的教学 fixture），拿不到增值服务、在 Web 决策台上无对应 affordance——这是有意取舍而非缺口。泛化闸门：dogfood 中出现**反复发生的真实非 PR 场景**再启动，且 P0 先做「交付物抽象」（交付物是什么 / 怎么验收 / 谁签字），之前不动核心不变式

## 架构概要

- **Daemon + 多客户端**：核心引擎作为 daemon 长驻运行，TUI/Web/CLI 通过 HTTP+WebSocket 连接
- **事件总线**：`src/daemon/event-bus.ts` 懒激活模式，daemon 未运行时 emit 是 no-op
- **HTTP REST API**：`/api/tasks`、`/api/workflows`、`/api/status` 等 CRUD 端点
- **WebSocket 实时推送**：频道订阅模式（`task:*`、`log:{taskId}` 等）推送状态变化和日志
- **TUI**：ink (React for CLI) 终端 UI，WebSocket 连接 daemon
- **Web UI**：React + Vite SPA，daemon 自身 serve 静态资源。**视觉风格 = claude.ai 质感**（暖象牙奶油底 / 深色暖炭灰、珊瑚橘 `#D97757` 强调、圆角、柔阴影、去大写去虚线）——token 在 `src/web/src/index.css`。早期的「蓝图工程图纸」风（直角/硬阴影/网格/大写压缩体）**已废弃，勿重新引入**。**布局骨架 = Supabase 控制台式**（2026-06-11）：全宽顶栏（logo + 面包屑页标题在左，搜索 / 快速创建 / 主题 / Now 铃铛在右）、侧栏下沉到顶栏之下、页头是单行中号标题（`PageHero` 已收敛，衬线 4xl hero 已废弃）。**侧栏是上下文导航**：进入项目（`/projects/:id`）或设置（`/settings`）后左侧菜单整体切换为该上下文的分区菜单（顶部「← 返回」回全局），设置分区 = 通用 / 提供商 / 任务调度 / 网络访问 / Daemon（子路由 `/settings/:section`，孤儿 Providers 页已接回「提供商」；旧 `?tab=` 链接有重定向兼容）。**移动端（<lg）= 底部 dock 原地展开抽屉（Supabase 式）**：页面常驻底部居中浮动 dock（搜索 / 现在(红点) / 菜单 三圆形图标，收起时离底边 1rem）；点击图标后展开：**pill 随面板一起从底部连续滑升、抽屉总高约 90vh**（容器锚底 + pill 在面板上方，面板 height 动画时容器顶边上移带着 pill 走；pill 行自身无背景、悬浮在**全屏玻璃遮罩**（bg-background/40 + blur，点击可关）上，激活图标反色高亮 + 旁出 ✕；**圆角卡片轮廓属于下方面板**（rounded-t-2xl + border-t）），不是独立弹层（无 Sheet/portal）。再点激活图标或 ✕ 收起；顶栏右侧菜单按钮（带未读 badge）是第二入口。搜索复用 `CommandPaletteContent`，与桌面 ⌘K dialog 同一内容体。**独立对话页 /chat 与 FloatingChat 已于 2026-06-11 整体删除**（后端 chat/sessions RPC 保留，需求澄清在用）。**左侧彩色亮条已全局移除**（2026-06-11 两轮清扫：选中/悬停态的 accent 条、NowCard 优先级条、错误/警告卡的 destructive/warning 条全部去掉，状态靠文字+底色表达；仅保留中性灰 `border-border` 的结构线——Markdown 引用、树形缩进、时间线轴。`toneToBorderLeftClass` 已删，勿再新增彩色左条）
- **Web 场景组件体系（Pro 层）**（2026-06-12）：shadcn 基础件之上的场景级模板层，**完整体系与使用规范见 `docs/web-components.md`**（分层模型 L0 token→L1 ui/→L2 pro→L3 pages、组件清单、MUST/MUST NOT 条文、防漂移 grep 清单）。要点：L2a 统一从 `@/components/pro` barrel 导入（PageHero/EntityCards/RowCard/ConfirmDialog/EmptyState/DescList/FormField/页宽常量…）；页面禁手写 max-w/h1/空态 div/Label+Input 裸拼；新增 L2 组件须先交 3 处重复证据并同 PR 迁移原手写点
- **执行视图 = 线性时间线**（`TaskRunView`，2026-06-10 重构）：每轮 phase 执行（含驳回重做）按实际发生顺序独立成块往下追加（不在原 section 上 ×N 折叠），日志按本轮时间窗切片（logger 落盘 UTC 字符串，`parseLineTs` 必须按 UTC 解析），agent 调用按时间窗内联到对应轮；未执行 phase 灰色占位垫底；daemon 重启被打断的轮次标 `aborted`（灰圈）。纯逻辑在 `src/web/src/lib/run-view-logic.ts`（buildTimeline / filterLinesToWindow / assignAgentCalls）
- **插件化工作流**：`AUTOPILOT_HOME/workflows/`（用户）工作流自动发现
- **YAML 工作流定义**：`workflow.yaml` 定义结构，`workflow.ts` 只写阶段函数
- **工作流注册中心**：`src/core/registry.ts` 自动发现、注册、查询工作流
- **状态自动推导**：从 phase name 自动生成 pending/running/trigger，支持简写
- **并行阶段支持**：`parallel:` 语法支持 fork/join 并行执行
- **状态机驱动**：`src/core/state-machine.ts` 动态加载转换表，原子性状态转换（乐观锁）
- **Push 模型**：每阶段完成后 `runInBackground()` 非阻塞启动下一阶段
- **并发安全**：文件锁（PID 存活检测 + 僵尸锁清理）防止双重执行
- **Watcher 保底**：定期检测卡死任务，自动恢复
- **Agent 系统**：内置 Anthropic / OpenAI / Google 三大 Agent 提供商（凭证由对应 CLI 自身管理）
- **Phase 内联 Agent**：每个 phase 在 `workflow.yaml` 里内联配置自己的 agent（`agent: {provider, model, system_prompt, max_turns, permission_mode}`）；省略则用 `DEFAULT_AGENT` 兜底。无"全局命名可复用 agent"概念（已于 2026-06 移除）。model 缺省时回退到 `providers.<provider>.default_model`
- **Web UI 工作流编辑器**：阶段 CRUD / 并行块 / 驳回 / **phase 内联 agent 编辑**全图形化，`workflow.ts` 自动同步（改名重命名函数、追加缺失、孤儿清理）
- **项目工作台**：两层数据模型 `Project ⊃ Workspace`，需求挂项目维度，支持 AI 调查 + 评论线程 + 用户审批流。**项目上下文壳层 = Supabase 式**（2026-06-11）：进入 `/projects/:id` 后顶栏面包屑换成项目切换器（`ProjectSwitcher` 下拉换项目/新建），左侧导航换成项目级菜单（需求 / 代码库 / 设置，子路由 `/projects/:id/:section`；**无概览页**，裸 `/projects/:id` 重定向到需求子页），顶部「← 项目列表」返回全局导航
- **流水线（原"看板"）**：Web 的 `/tasks` 页（导航名「流水线」）把**需求 + 任务**合到一处看全生命周期，4 段 tab（全部 / 等待人工 / 运行中 / 归档），列表内按时间分组（今天/昨天/…），行是 Claude Code 风卡片。流水线是默认首页。**「Now 决策收件箱」已整体替换为「通知系统」**（2026-06-11，机制级重构非改名）：旧模型 = 11 个 card-source 从当前状态**派生**内存快照（状态变了卡片消失，aggregator + `now.*` RPC + `now:*` 频道，已全部删除，`/api/now/*` 410）；新模型 = **append-only 事件流**落 `notifications` 表（迁移 035/036，写入收口 `src/core/notifications.ts` 进 single-writer 白名单）。daemon 驻留 `notification-recorder` 订阅 event-bus 把领域事件翻译成通知行（task 终态/await_review、需求 awaiting_approval、agent 提问、clarifier/schedule 错误、watcher 恢复；新增 `requirement:schedule-error` 事件）；**read/dismiss 双状态独立**，RPC = `notifications.list/unreadCount/markRead/markAllRead/dismiss`，WS 频道 `notification:*`；保留策略 30 天/500 行。**持续状态不进通知流**：provider 不健康走面板顶部 `ProviderHealthBanner`（`providers.health` RPC + provider:* 订阅，恢复自动消失），空态走 NowEmptyGuide。badge=未读数（不再是"当前 error+decision 卡数"，状态看板职责归流水线「等待人工」tab）。三端：Web `NotificationsPanel`（右侧面板，optimistic 已读/删除）、CLI `autopilot notifications list/read/dismiss`（`now` 留隐藏 deprecated 别名一版）、TUI `NotificationList`（observer-only 不可操作）。`/now` 路由仍重定向到 `/tasks` 并自动展开面板
- **评论线程**：`requirement_questions` + `requirement_question_replies`，Agent 调查期主动提问，用户回复后继续。**澄清的代码上下文**（2026-06-11，自主探索模型）：①**需求级浅 clone 拉全集代码库**（2026-06-12 主库废除后：`runtime/requirements/<reqId>/workspace/<alias>/` 每库一个子目录、并行 clone、按库降级——失败库走远程快照、全失败纯文本；`src/core/requirement-clone.ts` 的 `ensureRequirementClones`，clarifier 首轮 ensure 幂等复用、`--depth 1 --single-branch`）——**clone 就绪时不预拼接任何文档/结构快照**，prompt 如实告知克隆形态（深度 1/单分支/无历史），探索方式交给 agent 自主（读任意文件、搜索、git 命令、`git fetch --deepen` 加深历史），目标导向 = 了解项目以提出精准问题、代码能答的不问用户；clarifier `permission_mode: bypassPermissions`（default 下 Bash 被拒跑不了 git，信任级同 dev develop 阶段）+ max_turns 15，prompt 明确禁 push/改远程。生命周期 = done/cancelled 或删除需求时清理，failed 保留供重试。② clone 失败降级：本地 path（老工作区）或 `gh api` 远程拉**结构事实 + 自述文档快照**（prompt 声明可能过期、仅作线索）。③ 全失败 = 纯文本模式
- **框架零业务知识**：核心模块不含任何工作流专属常量或逻辑
- **用户空间分离**：`AUTOPILOT_HOME`（默认 `~/.autopilot/`）存放用户配置、工作流和运行时数据

## AUTOPILOT_HOME

用户数据与框架代码分离，统一存放在 `AUTOPILOT_HOME`（默认 `~/.autopilot/`，可通过环境变量覆盖）：

```
~/.autopilot/                    # AUTOPILOT_HOME
├── config.yaml                  # 用户配置
├── workflows/                   # 用户自定义工作流
│   └── dev/                     # YAML 工作流（推荐）
│       ├── workflow.yaml
│       └── workflow.ts
├── prompts/                     # 用户提示词模板
└── runtime/
    ├── workflow.db              # SQLite 数据库
    ├── daemon.pid               # Daemon PID 文件
    └── locks/                   # 文件锁目录
```

初始化：`autopilot init`（会自动从 repo 内 examples 装 `dev` + `ad-hoc` 两个产品工作流到 `~/.autopilot/workflows/`；其余示例是模板，按需 `workflow create` 克隆）
升级：`autopilot upgrade`
启动 daemon：`autopilot daemon run`
启动 TUI：`autopilot tui`
打开 Web UI：`autopilot dashboard`（浏览器访问 `http://127.0.0.1:6180`）

**老用户拉 repo 内最新 workflow fix**：`autopilot workflow sync dev`（dry-run 看 diff，加 `--apply` 真覆盖）。examples 改了 bug fix 后老用户家目录里的副本是冻结快照拿不到，用此命令同步。

## 目录结构

```
autopilot/
├── src/                           # TypeScript 源码
│   ├── index.ts                   # VERSION + AUTOPILOT_HOME
│   ├── core/                      # 框架核心（通用引擎 + 事件发射）
│   │   ├── db.ts                  # SQLite 数据库 + emit task:created/updated
│   │   ├── state-machine.ts       # 状态机 + emit task:transition
│   │   ├── runner.ts              # 执行引擎 + emit phase:started/completed/error
│   │   ├── registry.ts            # 工作流插件注册 & 发现 & YAML 加载
│   │   ├── infra.ts               # 文件锁（PID 存活检测 + 僵尸锁清理）
│   │   ├── notify.ts              # 通知系统
│   │   ├── logger.ts              # 阶段标签日志 + emit log:entry
│   │   ├── watcher.ts             # 卡死任务检测 + emit watcher:recovery
│   │   ├── migrate.ts             # 数据库迁移引擎
│   │   ├── config.ts              # 配置加载 & 校验
│   │   ├── projects.ts            # Project CRUD（id: proj-NNN）
│   │   ├── workspaces.ts          # Workspace CRUD（id: ws-NNN，原 codebases.ts→repos.ts）
│   │   ├── workspace-health.ts    # Workspace 健康检查（原 codebase-health.ts）
│   │   ├── requirements.ts        # Requirement CRUD（含 project_id + workspace_id）
│   │   └── requirement-questions.ts # 评论线程 CRUD（id: qst-NNN）
│   ├── daemon/                    # Daemon 进程
│   │   ├── index.ts               # Daemon 入口（init→server→watcher→signal）
│   │   ├── server.ts              # Bun.serve() HTTP+WS 统一服务
│   │   ├── routes.ts              # REST API 路由
│   │   ├── ws.ts                  # WebSocket 连接管理 + 订阅分发
│   │   ├── event-bus.ts           # 事件总线（enableBus 懒激活）
│   │   ├── protocol.ts            # JSON 协议类型定义
│   │   └── pid.ts                 # PID 文件管理
│   ├── client/                    # 薄客户端库（CLI/TUI/Web 共用）
│   │   ├── index.ts               # AutopilotClient (HTTP+WS)
│   │   ├── http.ts                # HTTP REST 方法
│   │   └── ws.ts                  # WebSocket + 自动重连
│   ├── cli/                       # CLI 薄客户端
│   │   └── index.ts               # Commander CLI（daemon/task/workflow 命令组）
│   ├── tui/                       # 终端 UI (ink/React)
│   │   ├── index.ts               # ink render 入口
│   │   ├── app.tsx                # 根组件（Tab 导航）
│   │   ├── components/            # Header, TaskList, TaskDetail, StatusBar, WorkflowList
│   │   └── hooks/                 # useClient, useTasks, useConnection
│   ├── web/                       # Web UI (React+Vite SPA)
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/                   # pages/, components/, hooks/
│   ├── agents/                    # Agent 系统
│   │   ├── agent.ts               # Agent 基础类
│   │   ├── types.ts               # Agent 类型定义
│   │   ├── registry.ts            # Agent 缓存管理
│   │   └── providers/             # Anthropic / OpenAI / Google
│   ├── migrations/                # 迁移脚本
│   └── types/                     # 类型声明
├── web-dist/                      # Web UI 构建产物（gitignore）
├── bin/                           # CLI 入口脚本
│   ├── autopilot.ts
│   └── run-phase.ts
├── examples/                      # 示例工作流
├── docs/                          # 架构文档
└── tests/                         # 单元测试（bun:test）
```

## 数据模型（P1+）

两层结构：`Project ⊃ Workspace(1:N) ⊃ Submodule`（**2026-06-11 起项目:代码库放开为 1:N**：迁移 037 删 025 的唯一索引 + 三处 RPC 守卫移除，`projectHasTopWorkspace` 已删；`getTopWorkspaceForProject` 语义从「唯一」变「默认 = created_at 最早」——但 **Web 新建需求已改为显式必选代码库**（Start 页 + 项目页弹窗，唯一时自动选中），自动派生只剩 CLI 快捷路径的兜底）。**Web UI 标签「代码库」= 内核 `workspace`**（纯展示层翻译，内核/CLI/RPC/DB 命名不动——勿借机翻回 codebase，迁移 024 不可逆）

> **命名说明（2026-06 Phase 2 改名）**：内核「用户代码库」概念全量改名 **Workspace**（表 `workspaces`、id `ws-NNN`、列 `workspace_id`/`parent_workspace_id`、RPC `workspaces.*`、CLI `autopilot workspace`）。注意与**任务运行沙盒** `sandbox`（每 task 的独立运行目录，Phase 1 由旧 `workspace` 改名而来）区分：**workspace = 用户的源码仓库，sandbox = 任务的临时执行目录**，互不相干。`.worktree.json` 里历史字段名保持兼容旧 `codebase_*` 读取。
>
> **sandbox = 任务级共用 clone（原则：用户仓库零痕迹）**：`sandbox.git=true` 时 task 启动（`ensureTaskSandbox`）把需求集合内每个 workspace 的 `remote_url` 远程 `git clone` 到 `<taskRoot>/workspace/<alias>/` 子目录（taskRoot 经 `getTaskRoot` 双根解析：新任务 = `runtime/requirements/<reqId>/runs/<taskId>/`，存量 = `runtime/tasks/<id>/`，见下方 v2 R2 条目；**2026-06-12 统一 multi-clone 布局：单库也是子目录，主库概念已废除**，repos[0] 只是「集合第一个」位置语义；完整克隆非浅克隆；2026-06 起 workspace 仅凭远程 URL 注册、无本地 path，早期 `git clone --local` 硬链接模式已随之移除）。**一个任务的所有 phase 共用这套 clone**——各 phase 直接在工作树改文件、跨 phase 可见，`submit_pr` 才 `git add -A && commit && push`；重跑 = 新 run 全新 clone（旧 run 历史保留，仅其 workspace/ 被清）。**源仓库全程零痕迹**（不在源仓库 .git 留 worktree 注册/临时分支，删除纯 rmSync），交付 push 规范分支 `feat/<需求>` + PR。`.worktree.json` 记 `mode:"multi-clone"`（repos[] 是真相、单库=长度 1，顶层字段镜像 repos[0] 防御历史 reader）；旧 `mode:"clone"`（根即仓库）reader 全保留，历史任务可浏览/清理/删分支。`listTaskRepos(taskId)` 是消费布局的唯一接口。⚠ 老用户 dev workflow 副本默认把 workspace 根当仓库根，新框架下**所有 git 任务都会坏**，必须 `autopilot workflow sync dev --apply`。
>
> **历史**：早期用 git worktree（污染源仓库，已废弃）；2026-06 曾试「agent 级即用即焚副本 + cumulative.patch 全量 patch」模型，因复杂度高、bug 多（深度审计 EPH-01~08），2026-06-09 **revert 回任务级共用 clone**（见 `docs/superpowers/specs/2026-06-09-shared-task-sandbox-design.md`）。**并行块在共用沙盒下不隔离子阶段工作树，暂不支持并行写（YAGNI）**。

| 实体 | 表 | ID 前缀 | 说明 |
|------|-----|---------|------|
| Project | `projects` | `proj-NNN` | 顶层工作空间。`proj-default` 是兜底项目（无归属的快捷任务挂这里） |
| Workspace | `workspaces` | `ws-NNN` | 用户源码仓库（凭 `remote_url` 注册，任务执行时远程 clone），归属某 Project |
| Requirement | `requirements` | `req-NNN` | 挂 project_id + workspace_id（**主库**）；**代码库集合存 `requirement_workspaces`**（不变式：主库 ∈ 集合），**澄清前用户经 `requirements.setWorkspaces` 确认**（多选项目代码库 + 自定义新建 + 未用库可就地删；**开始澄清即冻结**——澄清基于已选库的浅 clone 做、中途换库会使澄清失效，闸门=drafting/failed，2026-06-11 收紧）。**多库需求 = 全库可写、各自交付 PR**（2026-06-11 Phase 2）：沙盒把每库 clone 到 `workspace/<alias>/` 子目录（`.worktree.json` mode=multi-clone，顶层镜像 repos[0] 兼容旧 reader；**2026-06-12 起单库同布局**——单/多库双形态已消除）、`listTaskRepos(taskId)` 是 workflow 消费布局的唯一接口、submit_pr 遍历有 diff 的库各开 PR（全集落 `requirement_sub_prs`，**单库也落**——新任务全部走 poller 聚合验收；部分失败=已开 PR 保留+phase 失败停下报人）、pr-poller 聚合判定（**全部 PR merged 才 done**、任一新 CHANGES_REQUESTED 转 fix_revision、per-PR 水位在 sub_prs.last_reviewed_event_id 迁移 038）、重跑逐库删远程 feat/ 分支。**CI 自动修复回路**（2026-06-11，迁移 039）：poller 同时拉 `statusCheckRollup`+`headRefOid`，PR OPEN + checks 全完成 + 有 FAILURE/TIMED_OUT/STARTUP_FAILURE → 注入失败清单反馈转 fix_revision（与 review 反馈合并一条、同周期只转一次）；per-PR 按 head SHA 去重（修复 push 新 commit 才再触发，水位 sub_prs.ci_failed_head_sha）+ 护栏 CI_FIX_LIMIT=2 次触顶停下报人（`requirement:ci-fix-limit` 事件 → 通知 `ci_fix_limit`）；仅对 sub_prs 跟踪的 PR 生效（旧 main-scope 兼容路径跳过）。**fix_revision 的执行者 = `src/daemon/fix-revision-runner.ts`**（2026-06-12，方案 B）：旧「workflow 内 await_review/fix_revision phase 长驻」机制已拆，task 在 submit_pr 后即 done（bridge 在有交付 PR 时把需求转 awaiting_review 而非 done）；需求转 fix_revision（注入反馈 / PR CHANGES_REQUESTED / CI 失败）由 runner 监听，在**保留的任务沙盒**（clone+交付分支工作树）上一次性起修复 agent（FIXER_DEFAULTS 内置：bypassPermissions、max_turns 40，prompt=最近 5 条反馈+仓库布局+PR 号，commit&push 同分支）→ 成功转回 awaiting_review、失败转 failed 停下报人（status_reason）；沙盒被保留策略清走则 failed 提示整轮重跑。进度 = `fix-progress` 内存态 + `requirement:fix-round-update` 事件 + RPC `requirements.fixRound`，Web 在 fix_revision 显示实时进度卡。daemon 重启时扫描存量 fix_revision 需求补跑。⚠ 老用户 dev workflow 副本需 `autopilot workflow sync dev --apply`（统一子目录布局后老副本**所有 git 任务**都会在根上 git fatal，不止多库）。**是每个 Task 的前置** |
| Task | `tasks` | 8 位短 id | 执行单元。**必有 `requirement_id`（非空）**，由某需求衍生 |
| Question | `requirement_questions` | `qst-NNN` | Agent 调查期提问，含多轮回复 |

**核心不变式：每个 Task 必有一个 Requirement 作为前置**（不存在游离任务）。需求+任务是「一件工作」的前后两段。
- Requirement 真实状态机（见 `src/core/requirements.ts` ALLOWED_TRANSITIONS）：
  `drafting → clarifying → ready → (awaiting_approval) → queued → running → awaiting_review ⇄ fix_revision → done`，另有 `cancelled` / `failed`（failed 可回 queued/awaiting_approval 重试）。
  **创建后停 drafting，确认代码库是进入澄清的前置**（2026-06-11）：澄清依赖代码库浅 clone，`requirements.create` 不再自动转 clarifying；Web 需求页 drafting 态显示代码库确认卡（自动派生主库为预选）+「开始 AI 澄清」按钮，CLI `req new -c`/cwd 推断成功时自动开始、否则提示 `req clarify <id>`；`requirements.transition → clarifying` 在 RPC 层守卫主库非空（core 原语不限以便测试夹具）。
  ⚠️ 不是早期文档写的 `draft/investigating` —— 那是过期简化，别照它写过滤逻辑。
- Task 状态机：`pending_* → running_* → running_await_review → done/failed/cancelled`（phase 名内联在 status 里）。
- **失败可见性与防「撞墙-失忆-重撞」（2026-06-10 dogfood 落地）**：
  - 需求终态原因三列（migration 028/029）：`status_reason`（短摘要）+ `status_reason_source`（user/task/system）+ `status_before_terminal`（步骤条把 ✗ 画在死亡步）；failed 重试时三列自动清空
  - 需求级状态转移日志 `requirement_status_logs`（migration 030，与 task_logs 对称）：审批/排队时间点、审计
  - workflow 驳回触顶 = **停下报人**：转 `failed`（可重试）而非 cancel 死终态（examples/workflows/dev/workflow.ts 两处触顶分支用 forceTransition）
  - **评审知识沉淀**：bridge 在任务终态时把 `rejection_reason` 写成需求评论（kind=feedback, from_role=agent）；scheduler 重跑拼「历史执行评审遗留」（最近 3 条）进需求文本 → design v1 即带上轮架构约束
  - 任务终态概览 `tasks.outcome`：`terminal_reason`（failed/cancelled 都取）+ `rejection_reason/rejection_counts`
- **审批后内容冻结**：title/spec/workspace/workflow 在 queued 及之后不可编辑（RPC requirements.update 闸门 + chat 工具守卫 + Web 按钮显隐）；**failed 例外**（补约束重试是设计用途）。审批=对 spec 签字，执行内容以入队快照为准。
- **需求级工作流选择**（migration 031）：`requirements.workflow` 列（NULL=默认 dev），调度器消费；failed 后可换工作流重试（新 run 全新状态机 + 全新 clone，换流程天然干净）。
- **run 多历史（需求中心架构 v2 R2，2026-06-12，迁移 044）**：tasks 表语义演进为「需求的执行历史项（run）」——加列 `kind`（execution/fix，fix 留 R3）+ `seq`（需求内序号，MAX(seq)+1 递增）。**需求级重跑 = 追加新 run**（`task-factory.startNewRunForRequirement`，scheduler 重试分支消费），旧 run 的 DB 行 / phase events / logs / artifacts / manifest **全保留**（历史不再清空），只善后：删旧远程 feat/ 分支（新 run 复用同名分支必须先删）→ 清旧 run workspace/ → 关残留 open phase events → 建新 task 行并把 requirement.task_id 指向新 run。`resetTaskForRerun`（清史复用同 id）已删除；startTaskFromTemplate 的 409 守卫从「已有 task」改为「已有**活跃**（非终态）run」。**文件双根**：新任务落 `runtime/requirements/<reqId>/runs/<taskId>/`（不带 seq 前缀），存量 `runtime/tasks/<id>/` 原地只读零迁移——`getTaskRoot` 双根解析（legacy 目录优先 + DB 反查 requirement_id + 进程内缓存；clone 先于 createTask 的窗口由 `bindTaskRunRoot` 显式种子归属），manifest 扫描 / retention / sandbox 扫描均双根遍历。`deleteRequirementClone` 收窄为只清 workspace/ 浅 clone（done/cancelled 不再整删需求目录——runs/ 历史在里面）；删需求才走 `deleteRequirementRuntimeDir` 整树删。`tasks.restart`（run 内 phase 级重启）语义不变。流水线页每需求只显示 task_id 指向的最新 run（`src/web/src/lib/pipeline-logic.ts` filterLatestRunTasks；run 历史列表 UI 留 R6）。
- 快捷起任务（`task start "<描述>"` / 一句话发包 `startAdHoc`）也**先建真需求**：`runClarifierExtract` 把描述抽成 title+spec → 建需求（进需求池）→ 有 workspace 走调度器（`requirement-scheduler`，同仓库串行）、纯 adhoc 直接起。CLI 参数/退出码不变。helper 在 `src/daemon/start-from-prompt.ts`。
- 当前为 Phase 1（应用层强制 `requirement_id` 非空 + 迁移 023 回填历史游离任务，可回退）。**Phase 2 未做**：DB 列改 NOT NULL + FK（表重建、不可逆），dogfood 确认无新游离任务再单独上。

向后兼容：`/api/repos`/`/api/workspaces` 等 HTTP 路由已于 Phase 1 全量迁至 WS RPC（`workspaces.*`），不再保留 HTTP 别名；`Requirement.repo_id` 已于 P1 改名 `codebase_id`、Phase 2（2026-06）再改名 `workspace_id`。RPC 层对旧 `codebase_id`/`codebase_alias` 入参仍做读时兼容（迁移期防御）。

## Claude Code 协作角色（`.claude/agents/`）

本项目为 claude code 配了 4 个项目级 subagent，按职能分工。主 agent（claude code 本体）遇到对应类型问题时，应通过 Agent 工具调用相应 subagent 而不是自己硬扛。

| Subagent | 用途 | 何时调用 |
|----------|------|---------|
| `pm` | 产品决策、用户旅程、优先级 | 讨论"该不该做"、"用户怎么用"、信息架构问题 |
| `designer` | UI 交互、视觉一致性、状态完整性 | 新做 UI 功能、状态覆盖不清楚、视觉决策影响可用性 |
| `architect` | 模块边界、数据模型、API 设计、回归风险 | 改动涉及数据层、多模块重构、多个实现方案需要选 |
| `qa` | 测试场景、回归影响、错误路径 | 合 PR 前、改动涉及 state machine、错误处理复杂 |

### 防 agent rot 三原则

subagent 是独立 fresh context，硬编码项目细节容易过期。三道防线：

1. **subagent system prompt 只写稳定原则**（设计 token、红线、输出风格）。具体文件路径 / schema / 组件名 → 用"指针"指向 CLAUDE.md / 实际代码
2. **subagent 强制 Step 0**：每次启动先 `Read CLAUDE.md` + 任务相关核心文件 grok 当前现状
3. **CLAUDE.md 是单一真理来源**：项目演进时只更新这里，subagent 永远从这取最新事实

### 主 agent 调用流程

```
用户提问
  ↓
主 agent 判断问题层次
  ↓
是产品决策 → 调 pm subagent
是 UI 设计 → 调 designer subagent
是技术架构 → 调 architect subagent
是测试覆盖 → 调 qa subagent
是直接写代码 → 主 agent 自己干（用 coder 风格）
  ↓
subagent 返回意见 → 主 agent 决策 → 执行
```

调用前在 prompt 里塞当前任务的关键上下文（哪个 PR / 改了哪些文件 / 用户问的具体问题），让 subagent 不必从零探索。

## 开发规范

- TypeScript strict 模式，Bun 运行时
- 核心函数必须有类型提示
- 框架核心（src/core/）不得引入任何工作流专属的常量、配置或逻辑
- 工作流模块必须自包含：业务常量、辅助函数、通知实现均在模块内部
- `TABLE_COLUMNS` 和 `PROTECTED_COLUMNS` 统一从 `src/core/db.ts` 导出，其他模块导入使用
- catch 块使用 `catch (e: unknown)` 而非 `catch (e: any)`
- 迁移中涉及 DROP TABLE / 表重建时，`migrate.ts` 已自动在事务外切 `PRAGMA foreign_keys=OFF`，无需在迁移文件内处理

## 新增工作流

**推荐：YAML 工作流**（目录配对格式）

创建目录 `AUTOPILOT_HOME/workflows/<name>/`，包含：
- `workflow.yaml` — 工作流结构定义（阶段、状态、转换）
- `workflow.ts` — 阶段函数实现

YAML 最简写法（状态自动推导）：
```yaml
name: my_workflow
phases:
  - name: step1
    timeout: 900
  - name: step2
    timeout: 600
    reject: step1      # 语法糖：自动生成 jump_trigger + jump_target（只能往回跳）
```

并行阶段：
```yaml
phases:
  - name: design
    timeout: 900
  - parallel:
      name: development
      fail_strategy: cancel_all  # 或 continue
      phases:
        - name: frontend
          timeout: 1800
        - name: backend
          timeout: 1800
  - name: code_review
    timeout: 1200
```

Phase 内联 agent（省略 `agent:` 则用框架内置 `DEFAULT_AGENT`）：
```yaml
phases:
  - name: develop
    timeout: 1800
    agent:                         # 仅本 phase 生效，不被复用
      provider: anthropic
      model: claude-opus-4-6       # 省略则回退 providers.anthropic.default_model
      permission_mode: bypassPermissions
      system_prompt: 你是资深工程师，实现需求并自查。
  - name: review
    timeout: 1200                  # 不写 agent → 走 DEFAULT_AGENT
```

`workflow.ts` 阶段函数里按 phase 取 agent：`agentForPhase(workflowName, phaseName)`（零代码 `prompt:` 模式下框架自动调用，无需手写）。

## 升级流程

```bash
# 首次安装
git clone ... && cd autopilot
bun install
bun run dev init                 # 初始化 ~/.autopilot/ + 跑全部迁移 + 装默认 dev workflow

# 日常升级
git pull                         # 更新框架代码（不影响用户数据）
bun run dev upgrade              # 执行新迁移（如有；init 已跑全部时 no-op）
bun run dev workflow sync dev --apply   # 同步 dev workflow 副本（2026-06-12 统一子目录布局后必跑，老副本会在新布局下 git fatal）
```

## 启动和使用

```bash
# 启动 daemon（前台）
autopilot daemon run

# 启动 daemon（后台）
autopilot daemon start
autopilot daemon status
autopilot daemon stop    # 优先走 daemon.shutdown RPC 优雅停机（daemon 自己关 socket 后 exit 0），
                         # 失联才回落 SIGTERM——Windows 硬杀会留 zombie LISTEN socket（已根治 e7cf6a4）

# Project / Workspace / Requirement（纯 CLI 路径，不必开浏览器；dogfood-bug20/21）
autopilot project create <name> [-d desc]
autopilot project list / delete <id>
autopilot workspace create <alias> --remote <url> [-b branch] [-p project-id]   # 或 --github owner/repo
# 仅凭远程 URL 注册（无需本地预先 clone）；写 DB 前 probeRemote 验证可达性，缺省 -b 时自动探测远程 HEAD 默认分支
autopilot workspace update <id> [--remote <url>] [--branch <branch>] [--alias <alias>]
autopilot workspace list / delete <id> / health <id>
autopilot req new --from-prompt "<需求>" [--no-extract] [-p project-id] [-c workspace-id]
autopilot req show <id>                  # 详情（状态/终态原因/关联任务/工作流）
autopilot req set-workflow <id> <name>   # 设置执行工作流（审批后冻结；failed 可改后重试）
autopilot req set-title <id> <title>

# 任务管理（通过 daemon API）
# 注：每个任务必有需求。task start 只给 title 时会自动抽成一条真需求再起任务（无游离任务）
autopilot task start <title> [-w workflow] [-r "<需求>"] [--repo alias]
autopilot task status [task-id] [--json]
autopilot task cancel <task-id>
autopilot task logs <task-id> [--follow]

# 工作流
autopilot workflow list                          # 列出已注册
autopilot workflow show <name>                   # 看 yaml
autopilot workflow sync <name> [--apply]         # 老用户拉 repo 最新模板（先 dry-run，再 --apply）
autopilot workflow create <name>                 # 从模板派生新工作流（交互）
autopilot workflow delete <name>                 # 删工作流
autopilot workflow export <name> [-o file]       # 导出 yaml
autopilot workflow import <name> --from <yaml> --derives-from <base>  # 导入 yaml

# UI
autopilot tui                    # 终端 UI
autopilot dashboard              # 浏览器打开 Web UI

# 构建 Web UI（开发后需重新构建）
bun run build:web
```

## 运行测试

```bash
bun test
bun run typecheck
bun run smoke-test       # 客户 onboarding CLI 完整路径烟雾测试（12 步）
bun run coverage:rpc     # RPC × {web/tui/cli} 覆盖矩阵（发现死代码 / 反渗内核命名候选）
```

## 配置

全局 `config.yaml`（位于 `AUTOPILOT_HOME/config.yaml`）只承载**跨工作流共享的基础设施**，两个框架识别段：

```yaml
providers:             # LLM 提供商默认值（凭证由 CLI 管理）
  anthropic:
    default_model: claude-sonnet-4-6
    base_url: ""       # 可选，自建代理时用
    enabled: true
  openai: { ... }
  google: { ... }

# 注：已无全局 `agents:` 段。agent 现按 phase 内联配置在各工作流的
# workflow.yaml 里（省略则走框架内置 DEFAULT_AGENT）。详见「新增工作流」一节。

daemon:                # 可选：daemon 监听配置（改后 `autopilot daemon restart` 生效）
  host: 127.0.0.1      # 默认 127.0.0.1；设 0.0.0.0 暴露到局域网
  port: 6180

workspace_retention:   # 可选：任务 workspace 自动清理策略
  days: 30             # 终态任务超过 30 天自动清 workspace（仅 workspace 目录，日志/记录保留）
  max_total_mb: 5120   # 所有 workspace 总占用超 5 GB 时按旧→新清理终态任务
```

工作流专属字段请写在该工作流目录下的 `workflow.yaml`（或其独立配置文件），不要放全局。

工作流专属示例详见 `examples/` 下各工作流的 `config.example.yaml`。

## 知识库

详细架构文档见 `docs/` 目录（中文版）和 `docs/en/` 目录（英文版）：
- `quickstart.md`：5 分钟快速入门教程，从安装到跑通第一个 demo
- `architecture.md`：整体架构、模块职责、数据流、设计决策
- `workflow-development.md`：自定义工作流开发指南、YAML 工作流完整字段说明
- `state-machine.md`：状态转换表、驳回机制、各工作流完整状态图（含 Mermaid 图表）
- `faq.md`：常见问题与故障排查

English documentation is available under `docs/en/`.
