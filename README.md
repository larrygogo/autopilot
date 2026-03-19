# autopilot

[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)
[![CI](https://github.com/larrygogo/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/larrygogo/autopilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Code style: ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

AI 驱动的可扩展开发工作流自动化框架。
通过状态机 + Push 模型编排多阶段任务，支持插件化工作流定义，让 AI Agent 按流程自动完成从方案设计到 PR 提交的完整开发流程。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [架构概览](#架构概览)
- [CLI 命令](#cli-命令)
- [配置](#配置)
- [自定义工作流](#自定义工作流)
- [开发](#开发)
- [依赖](#依赖)
- [License](#license)

## 特性

- **插件化工作流** — 放入 `~/.autopilot/workflows/` 即自动发现注册，零配置接入
- **状态机驱动** — SQLite 持久化，原子性状态转换，非法转换运行时阻止
- **Push 模型** — 阶段完成后非阻塞启动下一阶段，无需轮询
- **并发安全** — 跨平台文件锁防止竞态条件
- **Watcher 保底** — 定期检测卡死任务，自动恢复执行
- **统一 CLI** — `autopilot` 命令，10 个子命令覆盖所有操作
- **用户空间分离** — `AUTOPILOT_HOME`（默认 `~/.autopilot/`）独立存放用户数据，`git pull` 升级无冲突
- **数据库迁移** — 纯 stdlib 实现，支持顺序迁移与版本管理
- **配置校验** — `autopilot config check` 自动检测类型错误和未知字段

## 快速开始

```bash
# 克隆 & 安装
git clone https://github.com/larrygogo/autopilot && cd autopilot
pip install -e ".[dev]"

# 初始化工作空间 & 数据库
autopilot init
autopilot upgrade

# 编辑配置
vim ~/.autopilot/config.yaml
autopilot config check

# 启动任务
autopilot start <req_id> --project my-project
```

> `AUTOPILOT_HOME` 默认为 `~/.autopilot/`，可通过环境变量 `export AUTOPILOT_HOME=/custom/path` 覆盖。

## 架构概览

```
autopilot/
├── core/                          # 框架核心（通用引擎）
│   ├── __init__.py                # __version__ + AUTOPILOT_HOME
│   ├── cli.py                     # 统一 click CLI 入口
│   ├── config.py                  # 配置加载 + schema 校验
│   ├── db.py                      # SQLite 数据库 & 查询
│   ├── state_machine.py           # 纯状态机，转换表由注册表提供
│   ├── runner.py                  # 执行引擎 & Push 模型
│   ├── registry.py                # 工作流插件注册 & 发现
│   ├── infra.py                   # git / 锁 / 通知分发 / AI 调用
│   ├── notify.py                  # 多后端通知系统（webhook / command）
│   ├── watcher.py                 # 卡死任务检测 & 恢复
│   ├── migrate.py                 # 数据库迁移引擎
│   └── migrations/                # 迁移脚本
├── bin/                           # 独立 CLI 脚本（兼容旧用法）
├── examples/                      # 示例工作流（参考实现）
├── prompts/                       # AI 提示词模板
├── knowledge/                     # 架构文档
├── tests/                         # 单元测试
└── pyproject.toml                 # 包配置 + ruff + pytest
```

核心模块职责：

| 模块 | 职责 |
|------|------|
| `cli` | 统一命令行入口，10 个子命令覆盖全部操作 |
| `config` | 配置文件加载（多路径搜索）和 schema 校验 |
| `registry` | 自动扫描用户工作流目录，注册工作流，提供阶段查询、转换表生成 |
| `state_machine` | 原子性状态转换（SQLite 事务），动态从 registry 加载转换表 |
| `runner` | 获取锁 → 执行阶段函数 → 释放锁，提供 `run_in_background()` Push 推进 |
| `infra` | 跨平台文件锁、git 操作、Claude CLI 调用、通知发送 |
| `notify` | 多后端通知系统，支持 webhook 和 command 两种后端 |
| `db` | SQLite 持久化（tasks / task_logs 表） |
| `migrate` | 数据库迁移引擎，顺序执行、失败回滚、版本管理 |
| `watcher` | 定期扫描活跃任务，检测卡死，自动重试恢复 |

> 详细架构文档见 [`knowledge/architecture.md`](knowledge/architecture.md)

## CLI 命令

```bash
# 任务管理
autopilot start <req_id> [--project <name>] [--workflow <name>]   # 注册并启动任务
autopilot cancel <task_id> [--reason <reason>]                    # 取消任务
autopilot list [--status <s>] [--workflow <w>] [--project <p>]    # 查询任务列表
autopilot show <task_id> [--logs <n>]                             # 查看任务详情
autopilot stats                                                   # 任务统计概览

# 工作流
autopilot workflows                                               # 列出已注册工作流

# 系统管理
autopilot init [--path <dir>]                                     # 初始化用户工作空间
autopilot upgrade [--status] [--dry-run]                          # 数据库升级
autopilot watch                                                   # 卡死检测与自动恢复

# 配置
autopilot config check [--file <path>]                            # 校验配置文件
```

## 配置

参考 `config.example.yaml`，主要配置项：

```yaml
default_branch: main

timeouts:
  design: 900
  review: 900
  development: 1800
  code_review: 1200

agents:
  default:
    plan_design: claude
    development: claude
    code_review: codex

projects:
  my-project:
    repo_path: ~/repos/my-project
    tech_stack: "Rust + TypeScript + PostgreSQL"
```

## 自定义工作流

将工作流模块放入 `~/.autopilot/workflows/` 目录，框架自动发现并注册。

```python
# ~/.autopilot/workflows/my_workflow.py

WORKFLOW = {
    'name': 'my_workflow',
    'description': '我的自定义工作流',
    'initial_state': 'pending_step1',
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

## 开发

```bash
pip install -e ".[dev]"           # 安装开发依赖
pytest tests/ -v                  # 运行测试
ruff check . && ruff format .     # lint + 格式化
```

数据库迁移脚本放入 `core/migrations/`，命名格式 `NNN_description.py`，实现 `up(conn)` 函数：

```bash
autopilot upgrade --status        # 查看版本
autopilot upgrade --dry-run       # 预览迁移
autopilot upgrade                 # 执行迁移
```

**开发规范**：Python 3.10+ · `from __future__ import annotations` · ruff 格式化（行宽 120） · 核心函数必须有类型提示 · 框架核心不引入工作流专属逻辑

## 依赖

- Python 3.10+
- PyYAML >= 6.0
- click >= 8.0
- [Claude Code CLI](https://claude.ai/code) 或 [Codex CLI](https://github.com/openai/codex)
- [GitHub CLI (gh)](https://cli.github.com/)

## License

MIT
