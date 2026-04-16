# Autopilot Node.js 重写设计

## 背景

autopilot 当前基于 Python 实现。随着 AI agent 生态发展，三大 CLI agent（Claude Code、Codex、Gemini CLI）都提供了官方 Node.js SDK，但只有 Claude 有官方 Python SDK。为统一 provider 支持并利用更好的生态，决定将 autopilot 重写为 TypeScript + Bun。

## 决策记录

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 运行时 | TypeScript + Bun | 原生 TS、内置 SQLite、极快包管理 |
| 架构策略 | 保留核心理念，重构不合理部分 | 状态机 + Push + YAML 工作流 + 插件不变；修复全局配置、agent 抽象、异步模型 |
| 工作流格式 | YAML + TS 配对（去掉单文件模式） | 声明与逻辑分离，简化 registry |
| 数据库 | `bun:sqlite` | 零依赖、内置、性能最好 |
| Agent 模式 | 对象式（Agent 实例） | 支持持有状态（session）、多轮对话扩展 |
| Provider 注册 | 内置实现 + workflow.yaml 内联配置 | 先不做 entry_points 插件发现，保持简单 |

## 架构概览

```
autopilot/                          # 项目根目录
├── src/                            # 源码
│   ├── index.ts                    # 入口，导出 version + AUTOPILOT_HOME
│   ├── cli.ts                      # CLI 入口（基于 commander）
│   ├── core/                       # 框架核心
│   │   ├── db.ts                   # SQLite 数据库（bun:sqlite）
│   │   ├── state-machine.ts        # 状态机：转换表 + 原子转换
│   │   ├── runner.ts               # 执行引擎：async 阶段执行 + Push 模型
│   │   ├── registry.ts             # 工作流注册表：发现、加载、校验
│   │   ├── config.ts               # 配置加载
│   │   ├── infra.ts                # 文件锁 / 通知分发 / 任务目录
│   │   ├── logger.ts               # 日志（阶段标签）
│   │   ├── notify.ts               # 多后端通知（webhook / command / 插件）
│   │   ├── watcher.ts              # 卡死任务检测与恢复
│   │   ├── migrate.ts              # 数据库迁移引擎
│   │   └── plugin.ts               # 第三方插件发现（保留设计，后续实现）
│   ├── agents/                     # Agent 系统（新增）
│   │   ├── types.ts                # Agent / Provider 类型定义
│   │   ├── agent.ts                # Agent 类
│   │   ├── registry.ts             # Agent 注册表：从 workflow 配置创建实例
│   │   └── providers/              # Provider 实现
│   │       ├── base.ts             # BaseProvider 抽象类
│   │       ├── anthropic.ts        # Claude Code（claude-agent-sdk）
│   │       ├── openai.ts           # Codex CLI（@openai/codex）
│   │       └── google.ts           # Gemini CLI（@google/gemini-cli-sdk）
│   └── migrations/                 # 数据库迁移脚本
│       └── 001-baseline.ts
├── examples/                       # 示例工作流
│   └── workflows/
│       └── dev/
│           ├── workflow.yaml
│           └── workflow.ts
├── tests/                          # 测试
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## 模块设计

### 1. Agent 系统

Agent 系统是本次重写的核心新增模块。

#### 1.1 类型定义 — `src/agents/types.ts`

```typescript
/** workflow.yaml 中 agents 配置的原始格式 */
interface AgentConfig {
  name: string;
  provider: "anthropic" | "openai" | "google";
  model: string;
  permission_mode?: string;
  max_turns?: number;
  max_budget_usd?: number;
  // provider 特有的配置透传
  [key: string]: unknown;
}

/** Provider 运行结果 */
interface AgentResult {
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_cost_usd?: number;
  };
}

/** Provider 运行选项 */
interface RunOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}
```

#### 1.2 BaseProvider — `src/agents/providers/base.ts`

```typescript
abstract class BaseProvider {
  constructor(protected config: Record<string, unknown>) {}

  /** 执行一次 AI 调用 */
  abstract run(prompt: string, options?: RunOptions): Promise<AgentResult>;

  /** 释放资源（关闭 session 等） */
  abstract close(): Promise<void>;
}
```

#### 1.3 AnthropicProvider — `src/agents/providers/anthropic.ts`

基于官方 `@anthropic-ai/claude-agent-sdk`：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

class AnthropicProvider extends BaseProvider {
  private sessionId?: string;

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const sdkOptions = {
      model: this.config.model as string,
      permissionMode: this.config.permission_mode ?? "bypassPermissions",
      cwd: options?.cwd,
      persistSession: true,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };

    let resultText = "";
    for await (const msg of query({ prompt, options: sdkOptions })) {
      if (msg.type === "result") {
        resultText = msg.result ?? "";
        this.sessionId = msg.session_id;
      }
    }
    return { text: resultText };
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}
```

#### 1.4 OpenAIProvider — `src/agents/providers/openai.ts`

基于官方 `@openai/codex`：

```typescript
import Codex from "@openai/codex";

class OpenAIProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const codex = new Codex({
      model: this.config.model as string,
      cwd: options?.cwd,
    });

    const result = await codex.query(prompt);
    return { text: result.text };
  }

  async close(): Promise<void> {}
}
```

#### 1.5 GoogleProvider — `src/agents/providers/google.ts`

基于官方 `@google/gemini-cli-sdk`：

```typescript
import { GeminiCliAgent } from "@google/gemini-cli-sdk";

class GoogleProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const agent = new GeminiCliAgent({
      model: this.config.model as string,
      cwd: options?.cwd,
    });

    const result = await agent.run(prompt);
    return { text: result.text };
  }

  async close(): Promise<void> {}
}
```

> 注：OpenAI 和 Google 的 SDK API 细节需要在实现时根据实际文档确认，以上为设计意图。

#### 1.6 Agent 类 — `src/agents/agent.ts`

```typescript
class Agent {
  constructor(
    readonly name: string,
    private provider: BaseProvider,
    readonly config: AgentConfig,
  ) {}

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    return this.provider.run(prompt, options);
  }

  async close(): Promise<void> {
    return this.provider.close();
  }
}
```

#### 1.7 Agent 注册表 — `src/agents/registry.ts`

```typescript
const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

/** 从 agent 配置创建 Agent 实例 */
function createAgent(config: AgentConfig): Agent {
  const ProviderClass = PROVIDERS[config.provider];
  if (!ProviderClass) {
    throw new Error(`未知 provider: ${config.provider}`);
  }
  const provider = new ProviderClass(config);
  return new Agent(config.name, provider, config);
}

/** 从 workflow 定义中查找并获取 Agent（同名同 workflow 复用实例） */
function getAgent(agentName: string, workflowName: string): Agent {
  // 缓存 key = `${workflowName}:${agentName}`
  // 命中缓存 → 返回已有实例（支持 session 复用）
  // 未命中 → 查 workflow.agents → createAgent → 缓存
}

/** 释放指定 workflow 的所有 Agent 实例 */
async function closeAgents(workflowName: string): Promise<void> {
  // runner 在任务完成/失败时调用，释放 provider 资源
}
```

**Agent 实例生命周期**：
- **创建**：首次 `getAgent()` 调用时按需创建，同 workflow 同名 agent 复用实例
- **释放**：runner 在任务结束（完成/失败/取消）时调用 `closeAgents()` 释放资源
- **缓存**：按 `workflowName:agentName` 缓存，支持同一 agent 跨阶段复用 session

### 2. workflow.yaml 配置格式

```yaml
name: dev
description: "完整开发流程"

# 工作流级配置（替代全局 config.yaml）
config:
  repo_path: ~/repos/my-project
  default_branch: main

# Agent 定义
agents:
  - name: architect
    provider: anthropic
    model: claude-sonnet-4-6
    permission_mode: bypassPermissions
  - name: developer
    provider: anthropic
    model: claude-opus-4-6
    permission_mode: bypassPermissions
  - name: reviewer
    provider: google
    model: gemini-2.5-pro
  - name: coder
    provider: openai
    model: o3

# 阶段定义
phases:
  - name: design
    agent: architect
    timeout: 900
  - name: review
    agent: reviewer
    timeout: 900
    reject: design
    max_rejections: 10
  - name: develop
    agent: developer
    timeout: 1800
  - name: code_review
    agent: reviewer
    timeout: 1200
    reject: develop
    max_rejections: 10
  - name: submit_pr
    timeout: 300
```

**变化点：**
- 新增 `agents` 顶级字段
- 新增 `config` 顶级字段（替代全局 config.yaml）
- 阶段新增 `agent` 字段引用 agent 名称
- 无 `agent` 的阶段（如 submit_pr）为纯脚本阶段

### 3. 核心模块移植

#### 3.1 数据库 — `src/core/db.ts`

- 使用 `bun:sqlite` 替代 Python `sqlite3`
- Schema 保持一致（tasks + task_logs 两张表）
- `bun:sqlite` 是同步 API，比 Python 的线程本地连接更简单
- 移除 `threading.local()`，Bun 单线程模型天然避免并发问题

#### 3.2 状态机 — `src/core/state-machine.ts`

- 逻辑完全移植：转换表查询 → 原子转换 → 日志记录
- `bun:sqlite` 支持 `BEGIN IMMEDIATE`，事务语义不变
- 导出 `transition()`、`canTransition()`、`getAvailableTriggers()`

#### 3.3 Runner — `src/core/runner.ts`

**核心变化：全面 async 化 + 不再用子进程 push**

Python 版的 Push 模型通过 `subprocess.Popen` 启动新 Python 进程跑下一阶段，进程开销大。Node.js 版改为：

```typescript
/** 后台启动下一阶段（非阻塞） */
function runInBackground(taskId: string, phase: string): void {
  // 用 setTimeout(0) + async 调用替代 subprocess
  // 在同一进程中异步执行，无需启动新进程
  setImmediate(() => {
    executePhase(taskId, phase).catch((err) => {
      logger.error(`后台启动阶段 ${phase} 失败：${err}`);
    });
  });
}

/** 执行阶段（async） */
async function executePhase(taskId: string, phase: string): Promise<void> {
  const lock = acquireLock(taskId);
  if (!lock) return;
  try {
    // ... 状态转换 + 调用阶段函数
    const phaseFn = getPhaseFunc(workflowName, phase);
    await phaseFn(taskId);  // 阶段函数是 async
    // ...
  } finally {
    releaseLock(taskId);
  }
}
```

> `bin/run_phase.py` 入口脚本保留为 `bin/run-phase.ts`，供 watcher 等外部场景调用。

#### 3.4 Registry — `src/core/registry.ts`

- YAML 加载用 `yaml` npm 包（和 Python 版的 `pyyaml` 对应）
- 去掉单文件 Python 工作流支持，只保留 YAML + TS 目录配对
- 新增 agents 字段解析：加载时校验 agent 配置、绑定到阶段
- TS 工作流模块用 `import()` 动态加载

```typescript
// 加载 workflow.ts 获取阶段函数
const mod = await import(path.join(wfDir, "workflow.ts"));
// 自动约定：run_{phase_name}
const func = mod[`run_${phaseName}`];
```

#### 3.5 CLI — `src/cli.ts`

- 使用 `commander` 替代 Python `click`
- 命令保持一致：`start`、`status`、`cancel`、`list`、`init`、`upgrade`
- 入口 `bin/autopilot` 指向 `src/cli.ts`（Bun 直接执行 TS）

#### 3.6 其他模块

| Python 模块 | TS 模块 | 变化 |
|-------------|---------|------|
| `config.py` | `config.ts` | 保持逻辑，YAML 加载方式不变 |
| `infra.py` | `infra.ts` | 文件锁改用 `proper-lockfile` 或自实现；git/通知逻辑不变 |
| `logger.py` | `logger.ts` | 保持阶段标签日志，用 `console` 或轻量日志库 |
| `notify.py` | `notify.ts` | webhook 用 `fetch`；command 用 `Bun.spawn` |
| `watcher.py` | `watcher.ts` | 逻辑一致，改为 async |
| `migrate.py` | `migrate.ts` | 迁移引擎逻辑一致 |
| `plugin.py` | `plugin.ts` | 保留接口设计，后续实现 |

### 4. 工作流代码变化

**Python 版（当前）：**

```python
def run_design(task_id: str) -> None:
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task["repo_path"]
    # ...拼 prompt...
    result = run_claude(prompt, repo_path, timeout=900)
    # ...写文件...
    transition(task_id, "design_complete")
    run_in_background(task_id, "review")
```

**TypeScript 版（目标）：**

```typescript
async function run_design(task_id: string): Promise<void> {
  const task = getTask(task_id);
  const taskDir = getTaskDir(task_id);
  const repoPath = task.repo_path;
  // ...拼 prompt...
  const agent = getAgent("architect", task.workflow);
  const result = await agent.run(prompt, { cwd: repoPath });
  // ...写文件...
  transition(task_id, "design_complete");
  runInBackground(task_id, "review");
}
```

### 5. 依赖清单

```json
{
  "dependencies": {
    "commander": "^13.0.0",
    "yaml": "^2.8.0"
  },
  "optionalDependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@openai/codex": "latest",
    "@google/gemini-cli-sdk": "latest"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  }
}
```

Agent SDK 作为 `optionalDependencies`。Provider 初始化时动态 `import()` 对应的 SDK，未安装时给出清晰错误提示（如 `请运行 bun add @anthropic-ai/claude-agent-sdk 以使用 anthropic provider`）。

### 6. AUTOPILOT_HOME 结构

不变，但工作流文件从 `.py` 变为 `.ts`：

```
~/.autopilot/
├── config.yaml                  # 全局配置（仅框架级，如日志级别）
├── workflows/
│   └── dev/
│       ├── workflow.yaml         # 工作流定义（含 agents + config）
│       └── workflow.ts           # 阶段函数
├── prompts/
└── runtime/
    └── workflow.db
```

### 7. Push 模型改进

Python 版每个阶段在独立子进程中运行（`subprocess.Popen`），Node.js 版改为同进程 async：

| | Python（当前） | Node.js（目标） |
|---|---|---|
| Push 机制 | `subprocess.Popen` 启动新进程 | `setImmediate` + async 调用 |
| 进程数 | 每阶段一个进程 | 单进程 |
| 隔离性 | 进程级隔离 | 无隔离（共享内存） |
| 开销 | 高（Python 启动慢） | 低 |
| 外部触发 | `bin/run_phase.py` | `bin/run-phase.ts`（保留，供 watcher/cron） |

**注意**：同进程模式下，一个阶段 crash 可能影响后续阶段。通过 try/catch 保护 + watcher 保底恢复来兜底。

### 8. 测试策略

- 使用 `bun:test`（Bun 内置测试框架）
- 和 Python 版的测试文件一一对应
- 核心模块（state-machine、registry、db）优先测试
- Agent 系统用 mock provider 测试

### 9. 迁移策略

**全新项目，不做渐进迁移**。原因：
- Python 和 Node.js 无法共享运行时
- 数据库 schema 一致，`workflow.db` 可以直接复用
- 工作流定义格式兼容（YAML 不变，`.py` → `.ts` 需要手动迁移）

用户迁移步骤：
1. `bun install -g autopilot`
2. 将 `workflow.py` 手动改写为 `workflow.ts`
3. `autopilot upgrade`（运行数据库迁移）
4. 现有任务数据自动可用

### 10. 不做的事情

- 不做 Python → TS 自动转换工具
- 不做 WebUI（现有插件示例暂不移植）
- 不做 entry_points 插件系统（保留接口，后续实现）
- 不做流式输出到终端（agent.run() 返回完整结果，流式是后续增强）
