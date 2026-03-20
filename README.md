<div align="center">

# autopilot

**轻量级多阶段任务编排引擎**

定义阶段，写每步逻辑，框架负责按顺序跑、失败重试、驳回回退、并行执行、卡死恢复。

[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)
[![CI](https://github.com/larrygogo/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/larrygogo/autopilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Code style: ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

</div>

---

## 特性

| | 特性 | 说明 |
|---|---|---|
| **📝** | **YAML 声明式定义** | `workflow.yaml` 定义结构，`workflow.py` 只写阶段函数，状态自动推导 |
| **🔌** | **插件化工作流** | 放入 `~/.autopilot/workflows/` 即自动发现注册，零配置接入 |
| **🧩** | **第三方插件** | `pip install` 自动注册扩展：通知后端 / CLI 命令 / 全局钩子 |
| **⚡** | **并行阶段** | `parallel:` 语法支持 fork/join 并行执行，可配置失败策略 |
| **🔄** | **状态机驱动** | SQLite 持久化，原子性状态转换，非法转换运行时阻止 |
| **🚀** | **Push 模型** | 阶段完成后非阻塞启动下一阶段，无需轮询 |
| **🔒** | **并发安全** | 文件锁 + SQLite 事务双重保障，防止竞态 |
| **👀** | **Watcher 保底** | 定期检测卡死任务，自动恢复执行 |
| **📦** | **用户空间分离** | 框架代码与用户数据分离，`git pull` 升级无冲突 |

## 快速开始

```bash
# 安装
git clone https://github.com/larrygogo/autopilot && cd autopilot
pip install -e ".[dev]"

# 初始化
autopilot init
autopilot upgrade

# 启动任务
autopilot start <req_id> --project my-project
```

## 定义工作流

放入 `~/.autopilot/workflows/`，框架自动发现并注册。支持两种写法：

### 方式一：YAML + Python（推荐）

每个工作流一个目录，`workflow.yaml` 定义结构，`workflow.py` 只写阶段函数：

```yaml
# workflow.yaml
name: my_workflow
description: 我的工作流

phases:
  - name: design
    timeout: 900

  - name: review
    timeout: 600
    reject: design          # 驳回后重试 design

  - name: develop
    timeout: 1800
```

```python
# workflow.py
def run_design(task_id: str) -> None:
    ...

def run_review(task_id: str) -> None:
    ...

def run_develop(task_id: str) -> None:
    ...
```

> 从 phase `name` 自动推导：`pending_state` · `running_state` · `trigger` · `complete_trigger` · `fail_trigger` · `label` · `func`

### 并行阶段

```yaml
phases:
  - name: design
    timeout: 900

  - parallel:
      name: development
      fail_strategy: cancel_all    # cancel_all（默认）| continue
      phases:
        - name: frontend
          timeout: 1800
        - name: backend
          timeout: 1800

  - name: code_review
    timeout: 1200
```

### 方式二：纯 Python

单个 `.py` 文件，导出 `WORKFLOW` 字典：

```python
# ~/.autopilot/workflows/my_workflow.py
WORKFLOW = {
    'name': 'my_workflow',
    'phases': [
        {'name': 'step1', 'func': run_step1, ...},
        {'name': 'step2', 'func': run_step2, ...},
    ],
}
```

> 完整开发指南见 [`docs/workflow-development.md`](docs/workflow-development.md)

## 架构

```
autopilot/
├── core/                    # 框架核心
│   ├── registry.py          # 工作流发现 + YAML 加载 + 状态推导
│   ├── state_machine.py     # 原子性状态转换
│   ├── runner.py            # 执行引擎 + Push 模型 + 并行 fork/join
│   ├── db.py                # SQLite 持久化（tasks / task_logs / 子任务）
│   ├── infra.py             # 文件锁 / git / 通知分发
│   ├── watcher.py           # 卡死检测 & 自动恢复
│   ├── plugin.py            # 第三方插件发现 & 注册（entry_points）
│   ├── notify.py            # 多后端通知（webhook / command / 插件扩展）
│   ├── migrate.py           # 数据库迁移引擎
│   └── cli.py               # 统一 CLI 入口
├── examples/                # 示例工作流（dev / req_review / doc_gen / parallel_build / data_pipeline）
├── docs/                    # 架构文档
└── tests/                   # 单元测试
```

> 详细架构文档见 [`docs/architecture.md`](docs/architecture.md) · 插件开发见 [`docs/plugin-development.md`](docs/plugin-development.md)

## CLI

```bash
autopilot start <req_id> [--project <p>] [--workflow <w>]              # 启动任务
autopilot list [--status <s>] [--workflow <w>] [--project <p>] [--all] # 任务列表
autopilot show <task_id> [--logs <n>]                                  # 任务详情
autopilot cancel <task_id> [--reason <r>]                              # 取消任务
autopilot stats                                                        # 统计概览
autopilot workflows                                                    # 已注册工作流
autopilot validate [<name>]                                            # 校验工作流定义
autopilot init                                                         # 初始化工作空间
autopilot upgrade [--status] [--dry-run]                               # 数据库迁移
autopilot watch                                                        # 卡死检测
autopilot config check                                                 # 校验配置
```

## 开发

```bash
pip install -e ".[dev]"
pytest tests/ -v
ruff check . && ruff format .
```

**规范**：Python 3.10+ · `from __future__ import annotations` · ruff（行宽 120） · 框架核心不引入工作流专属逻辑

## 依赖

- **Python** 3.10+
- **PyYAML** >= 6.0
- **click** >= 8.0

## License

MIT
