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

## 架构概要

- **Daemon + 多客户端**：核心引擎作为 daemon 长驻运行，TUI/Web/CLI 通过 HTTP+WebSocket 连接
- **事件总线**：`src/daemon/event-bus.ts` 懒激活模式，daemon 未运行时 emit 是 no-op
- **HTTP REST API**：`/api/tasks`、`/api/workflows`、`/api/status` 等 CRUD 端点
- **WebSocket 实时推送**：频道订阅模式（`task:*`、`log:{taskId}` 等）推送状态变化和日志
- **TUI**：ink (React for CLI) 终端 UI，WebSocket 连接 daemon
- **Web UI**：React + Vite SPA，daemon 自身 serve 静态资源
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
- **Agent 三层配置**：全局 `config.yaml.agents` → 工作流 `agents[]` 覆盖 → 运行时 `RunOptions` 覆盖
- **Web UI 工作流编辑器**：阶段 CRUD / 并行块 / 驳回 / 智能体覆盖全图形化，`workflow.ts` 自动同步（改名重命名函数、追加缺失、孤儿清理）
- **项目工作台**：两层数据模型 `Project ⊃ Codebase`，需求挂项目维度，支持 AI 调查 + 评论线程 + 用户审批流
- **评论线程**：`requirement_questions` + `requirement_question_replies`，Agent 调查期主动提问，用户回复后继续
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

初始化：`autopilot init`（会自动从 repo 内 `examples/workflows/dev` 装一份默认 dev 工作流到 `~/.autopilot/workflows/dev/`）
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
│   │   ├── codebases.ts           # Codebase CRUD（id: cb-NNN，原 repos.ts）
│   │   ├── codebase-health.ts     # Codebase 健康检查（原 repo-health.ts）
│   │   ├── requirements.ts        # Requirement CRUD（含 project_id + codebase_id）
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

两层结构：`Project ⊃ Codebase ⊃ Submodule`

| 实体 | 表 | ID 前缀 | 说明 |
|------|-----|---------|------|
| Project | `projects` | `proj-NNN` | 顶层工作空间 |
| Codebase | `codebases` | `cb-NNN` | 物理 Git 目录，归属某 Project |
| Requirement | `requirements` | — | 挂 project_id + codebase_id（多对多 via requirement_codebases） |
| Question | `requirement_questions` | `qst-NNN` | Agent 调查期提问，含多轮回复 |

状态流：`draft` → `investigating` → `awaiting_approval` → `queued` → `running` → `done`/`failed`

向后兼容：`/api/repos` 路由别名保留至 P6 清理（≈90 天）；`Requirement.repo_id` 已于 P1 正式改名 `codebase_id`。

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

## 升级流程

```bash
# 首次安装
git clone ... && cd autopilot
bun install
bun run dev init                 # 初始化 ~/.autopilot/ + 跑全部迁移 + 装默认 dev workflow

# 日常升级
git pull                         # 更新框架代码（不影响用户数据）
bun run dev upgrade              # 执行新迁移（如有；init 已跑全部时 no-op）
```

## 启动和使用

```bash
# 启动 daemon（前台）
autopilot daemon run

# 启动 daemon（后台）
autopilot daemon start
autopilot daemon status
autopilot daemon stop

# Project / Codebase / Requirement（纯 CLI 路径，不必开浏览器；dogfood-bug20/21）
autopilot project create <name> [-d desc]
autopilot project list / delete <id>
autopilot codebase create <alias> <path> [-b branch] [-p project-id] [--github owner/repo]
autopilot codebase list / delete <id> / health <id>
autopilot req new --from-prompt "<需求>" [--no-extract] [-p project-id] [-c codebase-id]

# 任务管理（通过 daemon API）
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

agents:                # 命名 agent 定义，工作流可同名引用或 extends
  coder:
    provider: anthropic
    model: claude-sonnet-4-6
    max_turns: 10
    permission_mode: auto
    system_prompt: |
      你是通用编码助手。

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
