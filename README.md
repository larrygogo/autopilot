# dev-pilot

AI 驱动的可扩展开发工作流自动化框架。基于状态机 + Push 模型，支持插件化工作流定义。

## 特性

- **插件化工作流**：在 `workflows/` 目录下新增工作流模块即可自动注册，无需修改核心代码
- **状态机驱动**：SQLite 持久化，原子性状态转换，非法转换在运行时阻止
- **Push 模型**：每个阶段完成后非阻塞启动下一阶段，无需轮询
- **并发安全**：跨平台文件锁（Unix `fcntl.flock` / Windows `msvcrt.locking`）防止竞态条件
- **Watcher 保底**：定期检测卡死任务，自动恢复执行
- **可配置**：`config.yaml` 驱动，支持多项目、多 AI agent、自定义超时

## 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/your-org/dev-pilot
cd dev-pilot

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写项目路径、通知渠道等

# 4. 启动任务
python3 bin/start_task.py <req_id> --project my-project
```

## 内置工作流

### dev — 完整开发流程

从需求到 PR 的全自动 5 阶段流水线：

```
pending_design ──→ designing ──→ pending_review ──→ reviewing
       ↑ (驳回重试)                                    ↓ 通过
       └── review_rejected                        developing
                                                       │
                                                  in_development
                                                       │
                                              code_reviewing ──→ pr_submitted ✓
                                                       ↑ (驳回重试)
                                                  code_rejected
```

| 阶段 | 说明 | 默认超时 |
|------|------|----------|
| **design** | AI 生成技术方案（`plan.md`） | 900s |
| **review** | AI 评审方案，通过/驳回 | 900s |
| **dev** | AI 在仓库中实现代码并提交 | 1800s |
| **code_review** | AI 审查代码变更，通过/驳回 | 1200s |
| **pr** | 推送分支、生成 PR 描述、创建 PR | 300s |

驳回时自动重试上游阶段，默认最多 10 次。

### req_review — 需求评审

轻量级需求分析与评审，2 阶段：

```
pending_analysis ──→ analyzing ──→ pending_req_review ──→ req_reviewing
                                          ↑ (驳回重试)          ↓ 通过
                                     req_review_rejected    req_review_done ✓
```

| 阶段 | 说明 | 默认超时 |
|------|------|----------|
| **req_analysis** | 获取并分析需求 | 900s |
| **req_review** | AI 评审需求质量 | 900s |

## 自定义工作流

创建新工作流只需 3 步：

1. 在 `src/dev_workflow/workflows/` 下新建 Python 模块
2. 定义阶段函数和 `WORKFLOW` 字典
3. 框架自动发现并注册

```python
# src/dev_workflow/workflows/my_workflow.py

WORKFLOW = {
    'name': 'my_workflow',
    'description': '我的自定义工作流',
    'terminal_states': ['done', 'cancelled'],
    'phases': [
        {
            'name': 'step1',
            'label': 'STEP_ONE',
            'trigger': 'start_step1',
            'pending_state': 'pending_step1',
            'running_state': 'running_step1',
            'complete_trigger': 'step1_complete',
            'timeout_key': 'design',
            'func': run_step1,
        },
        # ... 更多阶段
    ],
}
```

> 详细开发指南见 [`knowledge/workflow-development.md`](knowledge/workflow-development.md)

## 架构概览

```
bin/                        CLI 入口脚本
  start_task.py               注册并启动任务
  run_phase.py                后台阶段执行入口
  cancel_task.py              取消运行中的任务
  watcher.py                  cron 异常恢复入口
src/dev_workflow/           核心库
  db.py                       SQLite 数据库 & 配置加载
  state_machine.py            状态机定义 & 原子转换
  runner.py                   阶段执行引擎 & Push 模型
  registry.py                 工作流插件注册 & 发现
  infra.py                    基础设施（git / 锁 / 通知 / AI 调用）
  logger.py                   阶段标签日志
  watcher.py                  卡死任务检测 & 恢复
  workflows/                  工作流插件目录
    dev.py                      完整开发流程（5 阶段）
    req_review.py               需求评审（2 阶段）
prompts/                    AI 提示词模板（Mustache 风格）
knowledge/                  架构文档 & 开发指南
tests/                      单元测试
```

核心模块职责：

| 模块 | 职责 |
|------|------|
| `registry` | 自动扫描 `workflows/` 目录，注册工作流，提供阶段查询、转换表生成 |
| `state_machine` | 原子性状态转换（SQLite 事务），动态从 registry 加载转换表 |
| `runner` | 获取锁 → 执行阶段函数 → 释放锁，提供 `run_in_background()` Push 推进 |
| `infra` | 跨平台文件锁、git 操作、Claude CLI 调用、通知发送、需求获取 |
| `db` | SQLite 持久化（tasks / task_logs 表），配置文件加载 |
| `logger` | 阶段标签格式化日志，支持文件和控制台输出 |
| `watcher` | 定期扫描活跃任务，检测卡死（>600s 无锁），自动重试恢复 |

> 详细架构文档见 [`knowledge/architecture.md`](knowledge/architecture.md)

## 配置

参考 `config.example.yaml`，主要配置项：

```yaml
# 主分支名
default_branch: main

# 各阶段超时（秒）
timeouts:
  design: 900
  review: 900
  development: 1800
  code_review: 1200
  pr_description: 300

# 需求系统
reqgenie:
  base_url: https://reqgenie.reverse-game.ltd
  op_item: 'reqgenie 需求系统'

# 通知
notify:
  channel: telegram
  target: "your_chat_id"

# AI agent 配置
agents:
  default:
    plan_design: claude
    plan_review: codex
    development: claude
    code_review: codex

# 项目映射
projects:
  my-project:
    repo_path: ~/repos/my-project
    tech_stack: "Rust + TypeScript + PostgreSQL"
```

## CLI 命令

### 启动任务

```bash
python3 bin/start_task.py <req_id> [--project <name>] [--repo <path>] [--title <title>] [--workflow <name>]
```

- `req_id`：需求 ID（来自 ReqGenie）
- `--project`：项目名（对应 config.yaml 中的 projects 配置）
- `--workflow`：工作流名称（默认 `dev`，可选 `req_review`）

### 取消任务

```bash
python3 bin/cancel_task.py <task_id> [--reason <reason>]
```

### 手动执行阶段

```bash
python3 bin/run_phase.py <task_id> <phase>
```

### Watcher（建议配合 cron）

```bash
# 手动运行
python3 bin/watcher.py

# 配置 OpenClaw cron（每 5 分钟）
openclaw cron add --name dev-workflow-watcher --every 5m \
  --system-event "python3 /path/to/dev-pilot/bin/watcher.py"
```

## 开发

### 运行测试

```bash
pip install pytest
python -m pytest tests/ -v
```

### 开发规范

- Python 3.10+，使用 `from __future__ import annotations`
- 核心函数必须有类型提示
- git 操作使用 `infra._run_git()` 辅助函数
- 主分支名和超时值从 `config.yaml` 读取，不要硬编码

## 依赖

- Python 3.10+
- [Claude Code CLI](https://claude.ai/code) 或 [Codex CLI](https://github.com/openai/codex)
- [1Password CLI (op)](https://1password.com/downloads/command-line/)
- [GitHub CLI (gh)](https://cli.github.com/)
- OpenClaw（用于通知和 cron 调度）

## 未来规划

- **持久化任务队列**：引入 Redis 或消息队列，替代 SQLite + subprocess 调度，支持分布式部署
- **Web UI / Dashboard**：可视化面板查看任务状态、日志、产出物，支持手动干预
- **Metrics 与可观测性**：接入 Prometheus / Grafana，采集各阶段耗时和成功率指标
- **更多 AI 模型**：支持 GPT-4、Gemini、本地模型等，按阶段灵活选择
