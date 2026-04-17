# autopilot

轻量级多阶段任务编排引擎，基于状态机 + Push 模型 + 插件化工作流。

**运行时**：Bun (TypeScript)

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

初始化：`autopilot init`
升级：`autopilot upgrade`
启动 daemon：`autopilot daemon run`
启动 TUI：`autopilot tui`
打开 Web UI：`autopilot dashboard`（浏览器访问 `http://127.0.0.1:6180`）

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
│   │   └── config.ts              # 配置加载 & 校验
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

## 开发规范

- TypeScript strict 模式，Bun 运行时
- 核心函数必须有类型提示
- 框架核心（src/core/）不得引入任何工作流专属的常量、配置或逻辑
- 工作流模块必须自包含：业务常量、辅助函数、通知实现均在模块内部
- `TABLE_COLUMNS` 和 `PROTECTED_COLUMNS` 统一从 `src/core/db.ts` 导出，其他模块导入使用
- catch 块使用 `catch (e: unknown)` 而非 `catch (e: any)`

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
bun run dev init                 # 初始化 ~/.autopilot/
bun run dev upgrade              # 执行迁移

# 日常升级
git pull                         # 更新框架代码（不影响用户数据）
bun run dev upgrade              # 执行新迁移（如有）
```

## 启动和使用

```bash
# 启动 daemon（前台）
autopilot daemon run

# 启动 daemon（后台）
autopilot daemon start
autopilot daemon status
autopilot daemon stop

# 任务管理（通过 daemon API）
autopilot task start <req-id> [-w workflow]
autopilot task status [task-id]
autopilot task cancel <task-id>
autopilot task logs <task-id> [--follow]

# 工作流
autopilot workflow list

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
