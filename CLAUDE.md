# autopilot

轻量级多阶段任务编排引擎，基于状态机 + Push 模型 + 插件化工作流。

**运行时**：Bun (TypeScript)

## 架构概要

- **插件化工作流**：`AUTOPILOT_HOME/workflows/`（用户）工作流自动发现
- **YAML 工作流定义**：`workflow.yaml` 定义结构，`workflow.ts` 只写阶段函数
- **工作流注册中心**：`src/core/registry.ts` 自动发现、注册、查询工作流
- **状态自动推导**：从 phase name 自动生成 pending/running/trigger，支持简写
- **并行阶段支持**：`parallel:` 语法支持 fork/join 并行执行
- **状态机驱动**：`src/core/state-machine.ts` 动态加载转换表，原子性状态转换（乐观锁）
- **Push 模型**：每阶段完成后 `runInBackground()` 非阻塞启动下一阶段
- **并发安全**：文件锁（PID 存活检测 + 僵尸锁清理）防止双重执行
- **Watcher 保底**：定期检测卡死任务，自动恢复
- **Agent 系统**：内置 Anthropic / OpenAI / Google 三大 Agent 提供商
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
    └── locks/                   # 文件锁目录
```

初始化：`autopilot init`
升级：`autopilot upgrade`

## 目录结构

```
autopilot/
├── src/                           # TypeScript 源码
│   ├── index.ts                   # VERSION + AUTOPILOT_HOME
│   ├── cli.ts                     # 统一 CLI 入口（commander）
│   ├── core/                      # 框架核心（通用引擎）
│   │   ├── db.ts                  # SQLite 数据库（含子任务支持）+ TABLE_COLUMNS / PROTECTED_COLUMNS
│   │   ├── state-machine.ts       # 纯状态机，原子转换（乐观锁），转换表由注册表提供
│   │   ├── runner.ts              # 执行引擎 & Push 模型 & 并行 fork/join
│   │   ├── registry.ts            # 工作流插件注册 & 发现 & YAML 加载
│   │   ├── infra.ts               # 文件锁（PID 存活检测 + 僵尸锁清理）
│   │   ├── notify.ts              # 通知系统
│   │   ├── logger.ts              # 阶段标签日志（含 logger name）
│   │   ├── watcher.ts             # 卡死任务检测 & 恢复（含并行子任务）
│   │   ├── migrate.ts             # 数据库迁移引擎
│   │   └── config.ts              # 配置加载 & 校验（解析失败抛异常）
│   ├── agents/                    # Agent 系统
│   │   ├── agent.ts               # Agent 基础类
│   │   ├── types.ts               # Agent 类型定义
│   │   ├── registry.ts            # Agent 缓存管理
│   │   └── providers/             # Agent 提供商
│   │       ├── base.ts            # BaseProvider（含 buildRunOptions）
│   │       ├── anthropic.ts       # Anthropic Claude Agent
│   │       ├── openai.ts          # OpenAI Codex Agent
│   │       └── google.ts          # Google Gemini Agent
│   ├── migrations/                # 迁移脚本
│   │   └── 001-baseline.ts        # 基线迁移
│   └── types/                     # 类型声明
│       └── optional-sdks.d.ts     # 可选 SDK 类型声明
├── bin/                           # CLI 入口脚本
│   ├── autopilot.ts
│   └── run-phase.ts
├── examples/                      # 示例工作流
│   └── workflows/
│       └── dev/                   # 完整开发流程示例（TypeScript + Agent）
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

## 运行测试

```bash
bun test
bun run typecheck
```

## 配置

框架本身无内置配置项，所有字段由工作流自行读取。

工作流专属配置详见 `examples/` 下各工作流的 `config.example.yaml`。

## 知识库

详细架构文档见 `docs/` 目录（中文版）和 `docs/en/` 目录（英文版）：
- `quickstart.md`：5 分钟快速入门教程，从安装到跑通第一个 demo
- `architecture.md`：整体架构、模块职责、数据流、设计决策
- `workflow-development.md`：自定义工作流开发指南、YAML 工作流完整字段说明
- `state-machine.md`：状态转换表、驳回机制、各工作流完整状态图（含 Mermaid 图表）
- `faq.md`：常见问题与故障排查

English documentation is available under `docs/en/`.
