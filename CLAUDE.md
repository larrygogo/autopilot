# autopilot

轻量级多阶段任务编排引擎，基于状态机 + Push 模型 + 插件化工作流。

## 架构概要

- **插件化工作流**：`AUTOPILOT_HOME/workflows/`（用户）工作流自动发现
- **YAML 工作流定义**：`workflow.yaml` 定义结构，`workflow.py` 只写阶段函数
- **工作流注册中心**：`core/registry.py` 自动发现、注册、查询工作流
- **状态自动推导**：从 phase name 自动生成 pending/running/trigger，支持简写
- **并行阶段支持**：`parallel:` 语法支持 fork/join 并行执行
- **状态机驱动**：`core/state_machine.py` 动态加载转换表，原子性状态转换
- **Push 模型**：每阶段完成后 `run_in_background()` 非阻塞启动下一阶段
- **并发安全**：跨平台文件锁（`core/infra.py`）防止双重执行
- **Watcher 保底**：定期检测卡死任务，自动恢复
- **框架零业务知识**：核心模块不含任何工作流专属常量或逻辑
- **用户空间分离**：`AUTOPILOT_HOME`（默认 `~/.autopilot/`）存放用户配置、工作流和运行时数据

## AUTOPILOT_HOME

用户数据与框架代码分离，统一存放在 `AUTOPILOT_HOME`（默认 `~/.autopilot/`，可通过环境变量覆盖）：

```
~/.autopilot/                    # AUTOPILOT_HOME
├── config.yaml                  # 用户配置
├── workflows/                   # 用户自定义工作流
│   ├── dev/                     # YAML 工作流（推荐）
│   │   ├── workflow.yaml
│   │   └── workflow.py
│   └── my_workflow.py            # 单文件 Python 工作流
├── prompts/                     # 用户提示词模板
└── runtime/
    └── workflow.db              # SQLite 数据库
```

初始化：`autopilot init`
升级：`autopilot upgrade`

## 目录结构

```
autopilot/
├── core/                          # 框架核心（通用引擎）
│   ├── __init__.py                # __version__ + AUTOPILOT_HOME
│   ├── cli.py                     # 统一 CLI 入口（click）
│   ├── config.py                  # 配置加载 & 校验
│   ├── db.py                      # SQLite 数据库（含子任务支持）
│   ├── state_machine.py           # 纯状态机，转换表由注册表提供
│   ├── runner.py                  # 执行引擎 & Push 模型 & 并行 fork/join
│   ├── registry.py                # 工作流插件注册 & 发现 & YAML 加载
│   ├── infra.py                   # git / 锁 / 通知分发
│   ├── notify.py                  # 多后端通知系统（webhook / command）
│   ├── logger.py                  # 阶段标签日志
│   ├── watcher.py                 # 卡死任务检测 & 恢复（含并行子任务）
│   ├── migrate.py                 # 数据库迁移引擎
│   ├── migrations/                # 迁移脚本
│   │   ├── __init__.py
│   │   ├── 001_baseline.py        # 基线迁移
│   │   ├── 002_schema_version_pk.py
│   │   └── 003_add_parallel_support.py  # 并行子任务支持
│   └── workflows/                 # 工作流包（触发用户工作流发现）
│       └── __init__.py            # discover()
├── bin/                           # 通用 CLI
├── examples/                      # 示例工作流（参考实现）
│   ├── README.md                  # 安装说明
│   ├── dev/                       # 完整开发流程（5 阶段）
│   ├── req_review/                # 需求评审流程（2 阶段）
│   ├── doc_gen/                   # 文档生成与评审（极简自动推导）
│   ├── parallel_build/            # 并行构建流程（fork/join + hooks）
│   └── data_pipeline/             # 数据处理流水线（前向跳转 + 多终态）
├── docs/                          # 架构文档
├── tests/                         # 单元测试
└── config.example.yaml            # 极简框架配置
```

## 开发规范

- Python 3.10+，使用 `from __future__ import annotations` 支持新式类型注解
- 核心函数必须有类型提示
- 主分支名从 `config.yaml` 的 `default_branch` 读取，默认 `main`
- 框架核心（core/）不得引入任何工作流专属的常量、配置或逻辑
- 工作流模块必须自包含：业务常量、辅助函数、通知实现均在模块内部
- 所有模块通过 `from core import AUTOPILOT_HOME` 引用用户工作空间路径

## 新增工作流

**推荐：YAML 工作流**（目录配对格式）

创建目录 `AUTOPILOT_HOME/workflows/<name>/`，包含：
- `workflow.yaml` — 工作流结构定义（阶段、状态、转换）
- `workflow.py` — 阶段函数实现

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

**方式二：单文件 Python 工作流**

单个 `.py` 文件放入 `AUTOPILOT_HOME/workflows/`，导出 `WORKFLOW` 字典。

## 升级流程

```bash
# 首次安装
git clone ... && cd autopilot
autopilot init                   # 初始化 ~/.autopilot/
autopilot upgrade                # 执行迁移

# 日常升级
git pull                         # 更新框架代码（不影响用户数据）
autopilot upgrade                # 执行新迁移（如有）
```

## 运行测试

```bash
pip install pytest pyyaml
python -m pytest tests/ -v
```

## 配置

参考 `config.example.yaml`，框架级配置仅需：
- `default_branch`：主分支名（可选）

工作流专属配置详见 `examples/` 下各工作流的 `config.example.yaml`。

## 知识库

详细架构文档见 `docs/` 目录：
- `architecture.md`：整体架构、模块职责、数据流、设计决策
- `workflow-development.md`：自定义工作流开发指南、YAML 工作流完整字段说明
- `state-machine.md`：状态转换表、驳回机制、各工作流完整状态图
