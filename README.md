# dev-pilot

AI 驱动的可扩展开发工作流自动化框架。基于状态机 + Push 模型，支持插件化工作流定义。

## 特性

- **插件化工作流**：用户工作流自动发现，放入 `DEV_PILOT_HOME/workflows/` 即可注册
- **状态机驱动**：SQLite 持久化，原子性状态转换，非法转换在运行时阻止
- **Push 模型**：每个阶段完成后非阻塞启动下一阶段，无需轮询
- **并发安全**：跨平台文件锁（Unix `fcntl.flock` / Windows `msvcrt.locking`）防止竞态条件
- **Watcher 保底**：定期检测卡死任务，自动恢复执行
- **统一 CLI**：`dev-pilot` 命令，10 个子命令覆盖所有操作
- **用户空间分离**：`DEV_PILOT_HOME`（默认 `~/.dev-pilot/`）存放用户配置、工作流和运行时数据，`git pull` 升级安全无冲突
- **数据库迁移引擎**：纯 stdlib 实现，支持顺序迁移、失败回滚、schema 版本检查
- **配置校验**：`dev-pilot config check` 自动检测配置文件中的类型错误和未知字段
- **可配置**：`config.yaml` 驱动，支持多项目、多 AI agent、自定义超时

## 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/larrygogo/dev-pilot
cd dev-pilot

# 2. 安装（推荐）
pip install -e ".[dev]"

# 3. 初始化用户工作空间
dev-pilot init

# 4. 执行数据库迁移
dev-pilot upgrade

# 5. 编辑配置
vim ~/.dev-pilot/config.yaml

# 6. 校验配置
dev-pilot config check

# 7. 启动任务
dev-pilot start <req_id> --project my-project
```

## 自定义工作流

将工作流模块放入 `~/.dev-pilot/workflows/` 目录，框架自动发现并注册。

```python
# ~/.dev-pilot/workflows/my_workflow.py

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

## DEV_PILOT_HOME

用户数据与框架代码分离，统一存放在 `DEV_PILOT_HOME`（默认 `~/.dev-pilot/`，可通过环境变量覆盖）：

```
~/.dev-pilot/                    # DEV_PILOT_HOME
├── config.yaml                  # 用户配置
├── workflows/                   # 用户自定义工作流
├── prompts/                     # 用户提示词模板
└── runtime/
    └── workflow.db              # SQLite 数据库
```

## 架构概览

```
dev-pilot/
├── core/                          # 框架核心（通用引擎）
│   ├── __init__.py                # __version__ + DEV_PILOT_HOME
│   ├── cli.py                     # 统一 click CLI 入口
│   ├── config.py                  # 配置加载 + schema 校验
│   ├── db.py                      # SQLite 数据库 & 查询
│   ├── state_machine.py           # 纯状态机，转换表由注册表提供
│   ├── runner.py                  # 执行引擎 & Push 模型
│   ├── registry.py                # 工作流插件注册 & 发现（用户工作流）
│   ├── infra.py                   # git / 锁 / 通知分发 / AI 调用
│   ├── logger.py                  # 阶段标签日志
│   ├── watcher.py                 # 卡死任务检测 & 恢复
│   ├── migrate.py                 # 数据库迁移引擎
│   ├── migrations/                # 迁移脚本
│   └── workflows/                 # 工作流包（触发用户工作流发现）
├── bin/                           # 独立 CLI 脚本（兼容旧用法）
├── examples/                      # 示例工作流（参考实现）
├── prompts/                       # AI 提示词模板
├── knowledge/                     # 架构文档
├── tests/                         # 单元测试（176 个）
├── pyproject.toml                 # 包配置 + ruff + pytest
└── .github/workflows/ci.yml      # GitHub Actions CI
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
| `db` | SQLite 持久化（tasks / task_logs 表） |
| `migrate` | 数据库迁移引擎，顺序执行、失败回滚、版本管理 |
| `watcher` | 定期扫描活跃任务，检测卡死（>600s 无锁），自动重试恢复 |

> 详细架构文档见 [`knowledge/architecture.md`](knowledge/architecture.md)

## CLI 命令

安装后通过 `dev-pilot` 命令使用：

```bash
# 任务管理
dev-pilot start <req_id> [--project <name>] [--workflow <name>]   # 注册并启动任务
dev-pilot cancel <task_id> [--reason <reason>]                    # 取消任务
dev-pilot list [--status <s>] [--workflow <w>] [--project <p>]    # 查询任务列表
dev-pilot show <task_id> [--logs <n>]                             # 查看任务详情
dev-pilot stats                                                   # 任务统计概览

# 工作流
dev-pilot workflows                                               # 列出已注册工作流

# 系统管理
dev-pilot init [--path <dir>]                                     # 初始化用户工作空间
dev-pilot upgrade [--status] [--dry-run]                          # 数据库升级
dev-pilot watch                                                   # 卡死检测与自动恢复

# 配置
dev-pilot config check [--file <path>]                            # 校验配置文件
```

> `bin/` 目录下的独立脚本仍可使用，但推荐使用 `dev-pilot` 统一命令。

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
  base_url: https://reqgenie.example.com
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

使用 `dev-pilot config check` 校验配置是否正确。

## 开发

### 安装开发环境

```bash
pip install -e ".[dev]"    # 安装 dev-pilot + pytest + ruff
```

### 运行测试

```bash
pytest tests/ -v           # 176 个测试
```

### 代码质量

```bash
ruff check .               # lint 检查
ruff format .              # 代码格式化
```

### 数据库升级

新增迁移脚本放入 `core/migrations/`，命名格式 `NNN_description.py`，实现 `up(conn)` 函数。

```bash
dev-pilot upgrade --status    # 查看当前版本和待执行迁移
dev-pilot upgrade --dry-run   # 预览将执行的迁移
dev-pilot upgrade             # 执行迁移
```

### 开发规范

- Python 3.10+，使用 `from __future__ import annotations`
- ruff 格式化，行宽 120
- 核心函数必须有类型提示
- git 操作使用 `infra._run_git()` 辅助函数
- 主分支名和超时值从 `config.yaml` 读取，不要硬编码
- 框架核心（`core/`）不得引入任何工作流专属的常量、配置或逻辑

## 依赖

- Python 3.10+
- PyYAML >= 6.0
- click >= 8.0
- [Claude Code CLI](https://claude.ai/code) 或 [Codex CLI](https://github.com/openai/codex)
- [GitHub CLI (gh)](https://cli.github.com/)

## License

MIT
