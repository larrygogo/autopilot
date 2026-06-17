[中文](quickstart.md) | [English](en/quickstart.md)

## autopilot 能帮你做什么

真实的开发任务很少是"一次 prompt 就搞定"的：要写完代码再跑测试、要先出方案给你审、中间遇到问题要停下来问你、出错还能回到上一步重做。autopilot 把这些"agent 调用之间的胶水"做成一个框架：状态机 + 人工审批门 + 本地持久化 + Web UI，单进程 daemon + SQLite，开箱即用。

## 跑通后你会得到什么

内置 `dev` 工作流，下次只需一句 `autopilot start "你的需求"` 就能触发完整流程：

```
你：加个任务标签功能
  ↓
architect agent 读代码库 + 写技术方案 → workspace/00-design/plan.md
  ↓
[Gate: 你在 Web UI 审方案] ← 通过继续，驳回带理由回到设计阶段
  ↓
developer agent 写代码 + 跑测试 + git commit
  ↓
reviewer agent 看 diff 评审 → REVIEW_RESULT: PASS / REJECT
  ↓
gh pr create ← 真的提 PR 到 GitHub
```

每步产物自动归档到 task workspace，Web UI 实时看进度、看日志。

---

# 快速入门（10-15 分钟）

> 实际耗时取决于 AI agent 的响应速度和你的配置情况，请预留 10-15 分钟而不是 5 分钟。

---

## 第一步：确认前置条件 ⚙️

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **Bun** | 1.0+ | JavaScript 运行时。安装：[bun.sh](https://bun.sh) |
| **Git** | 任意 | 版本控制 |
| **AI CLI**（任选一） | 已登录 | [Claude Code](https://docs.anthropic.com/claude-code)（推荐）、[OpenAI Codex](https://github.com/openai/openai-codex) 或 [Gemini CLI](https://github.com/google-gemini/gemini-cli) |

快速检查：

```bash
bun --version        # 应输出 1.x.x
git --version        # 应输出 git version x.x.x
claude --version     # 或 codex --version / gemini --version
```

---

## 第二步：安装 📦

```bash
git clone https://github.com/larrygogo/autopilot
cd autopilot
bun install
bun run build:web   # 构建 Web UI（web-dist 是 gitignore 产物，不构建则面板打不开）
```

预期输出（最后几行）：

```
bun install v1.x.x
[xxx packages] installed
```

> **别漏 `bun run build:web`**：Web UI 的静态资源（`web-dist/`）不在 git 里，需本地构建一次。没构建就启动 daemon、打开面板，会看到一张「Web UI 未构建」的指引页（CLI 仍可正常用）。

> **全局命令**：安装完成后 `autopilot` 命令通过 `bun run` 调用。如需全局可用，运行：
> ```bash
> bun link
> ```

---

## 第三步：初始化工作空间 🗂️

```bash
autopilot init
```

`init` 预期输出（含数据库迁移 + 自动装默认 dev 工作流）：

```
已创建目录：/Users/you/.autopilot/workflows
已创建目录：/Users/you/.autopilot/prompts
已创建目录：/Users/you/.autopilot/runtime
已初始化数据库：/Users/you/.autopilot/runtime/workflow.db（应用 19 条迁移）
已生成配置模板：/Users/you/.autopilot/config.yaml
已装入默认工作流：/Users/you/.autopilot/workflows/dev
初始化完成。
```

这会在 `~/.autopilot/` 创建你的用户数据目录——配置文件、工作流、运行时数据都放在这里，与框架代码完全隔离。

后续 `git pull` 拉新代码后，跑 `autopilot upgrade` 增量执行新迁移（init 已跑全部时 no-op），再 `bun run build:web` 重新构建 Web UI（前端产物不在 git 里，不重建会跑旧 bundle）。

---

## 第四步：配置 AI Agent ✨（最重要的一步）

autopilot 靠 AI agent 来干活，必须配置至少一个 provider。

### 方式 A：编辑配置文件（推荐）

打开 `~/.autopilot/config.yaml`，加上 providers 段：

```yaml
providers:
  anthropic:
    default_model: claude-sonnet-4-6
    enabled: true
```

> **凭证**：autopilot 不存储 API key，由你已登录的 CLI 工具（claude-code / codex / gemini-cli）负责管理。确保已在对应 CLI 里 `claude login` / `codex login` 登录过。

> **agent 配置在工作流里，不在全局**：全局 `config.yaml` 只放 providers 等跨工作流基础设施。每个阶段的 agent（provider / model / system_prompt / max_turns / permission_mode）写在工作流目录的 `workflow.yaml` 里，由阶段内联声明；阶段省略 `agent:` 时框架用内置默认 agent（anthropic / claude-sonnet-4-6）兜底。详见[工作流开发指南](workflow-development.md)。

### 方式 B：Web UI 配置

先启动 daemon（见第五步），然后在浏览器打开 `/settings?tab=providers` 图形化配置。

---

## 第五步：启动 Daemon 🚀

```bash
autopilot daemon start
```

预期输出：

```
daemon 已启动 (pid=12345)
  查看监听地址与状态：autopilot daemon status
```

检查状态：

```bash
autopilot daemon status
```

预期输出：

```
daemon 运行中 (pid=12345)
  监听: 127.0.0.1:6180
  版本: x.x.x
  运行时间: 5s
  任务统计: 无任务
```

> **默认端口**：`6180`。如需修改，在 `~/.autopilot/config.yaml` 加 `daemon: { port: 你的端口 }` 后 `autopilot daemon restart`。

---

## 第六步：打开 Web UI 🌐

```bash
autopilot dashboard
```

浏览器会自动打开 `http://127.0.0.1:6180/now`。

Web UI 有四个区域：

| 区域 | 路径 | 说明 |
|------|------|------|
| **现在** | `/now` | 当前需要你关注的事（按优先级排序的卡片流） |
| **开始** | `/start` | 提交新需求、启动任务 |
| **库** | `/library` | 查看所有任务和工作流 |
| **设置** | `/settings` | 配置 providers 等基础设施 |

---

## 第七步：提交第一个需求 📝

### 方式 A：Web UI（推荐）

1. 点击顶部导航 **开始**（`/start`）
2. 填写需求标题和描述
3. 点击提交

### 方式 B：CLI 快捷命令

```bash
autopilot start "给任务列表加标签筛选功能"
```

预期输出：

```
任务已创建 [id=task-001 workflow=dev status=pending_design]
```

### 方式 C：指定工作流

```bash
autopilot start "重构用户模块" --workflow dev
```

查看当前可用工作流：

```bash
autopilot workflow list
```

---

## 第八步：等待 AI 干活，在需要时介入 👁️

任务启动后，autopilot 自动推进各阶段：

1. **design（设计）**：architect agent 分析代码库、生成技术方案
2. **review（方案评审）**：⚠️ **等待你的审批** — 在 Web UI `/now` 页面会出现一张卡片
3. **develop（开发）**：developer agent 写代码、跑测试、提交
4. **code_review（代码评审）**：reviewer agent 评审 diff
5. **submit_pr（提 PR）**：自动运行 `gh pr create`

### 查看进度

**Web UI**：打开 `/now` 主屏，优先级 P0-P3 的卡片会告诉你现在该做什么。

**CLI 文本视图**：

```bash
autopilot now
```

预期输出（有待审批任务时）：

```
PRIO  TITLE                        WAIT    ACTIONS
----  ---------------------------  ------  -------
P0    任务方案待审批: task-001      5min    审批 / 驳回
```

**终端 UI**：

```bash
autopilot tui
```

**查看详情和日志**：

```bash
# 列出所有任务
autopilot task status

# 查看单个任务
autopilot task status task-001

# 跟踪实时日志
autopilot task logs task-001 --follow
```

---

## 常用操作速查

```bash
# daemon 管理
autopilot daemon start          # 后台启动
autopilot daemon stop           # 停止
autopilot daemon status         # 查看状态
autopilot daemon restart        # 重启（重载配置后用）

# Project / Codebase / Requirement（纯 CLI 路径，不必开浏览器）
autopilot project create "<name>" [-d desc]           # 创建 project
autopilot project list                                # 列出 project
autopilot codebase create <alias> <path> [--github owner/repo]  # 注册 git 仓库
autopilot codebase list                               # 列出 codebase
autopilot req new --from-prompt "<需求>" [--no-extract] # 创建 requirement

# 任务
autopilot start "<标题>"        # 快捷创建任务
autopilot task start "<标题>" --workflow <name>  # 指定工作流
autopilot task status           # 列出所有任务
autopilot task status <id>      # 查看单个任务
autopilot task logs <id>        # 查看日志
autopilot task logs <id> -f     # 实时跟踪日志
autopilot task cancel <id>      # 取消任务

# 工作流
autopilot workflow list         # 列出已注册工作流
autopilot workflow show <name>  # 查看工作流详情

# 界面
autopilot now                   # 文本卡片流（/now 的 CLI 版）
autopilot tui                   # 终端 UI
autopilot dashboard             # 打开浏览器 Web UI
autopilot chat                  # 与 agent 对话（REPL）

# 维护
autopilot init                  # 初始化工作空间（首次）
git pull && bun install         # 拉新代码 + 更新依赖
autopilot upgrade               # 运行数据库迁移（升级后）
bun run build:web               # 重新构建 Web UI（pull 后必跑，否则面板跑旧 bundle）
```

---

## 下一步

| 想了解... | 阅读 |
|-----------|------|
| 工作流的完整定义语法 | [工作流开发指南](workflow-development.md) |
| 框架内部架构和设计决策 | [架构总览](architecture.md) |
| 状态机和驳回机制 | [状态机详解](state-machine.md) |
| 常见问题和故障排查 | [FAQ](faq.md) |

---

## 遇到问题？

- **`autopilot daemon start` 超时**：检查端口 6180 是否被占用，或改用 `autopilot daemon run`（前台模式，日志直接输出）
- **AI agent 不工作**：确认已用对应 CLI 登录，`~/.autopilot/config.yaml` 中 `enabled: true`
- **任务卡住不动**：运行 `autopilot task logs <id>` 看报错；或查看 [FAQ](faq.md)
