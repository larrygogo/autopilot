# dev-pilot

AI 驱动的可扩展开发工作流自动化框架，基于状态机 + Push 模型 + 插件化工作流。

## 架构概要

- **插件化工作流**：`core/workflows/` 下新增模块即自动注册，无需改核心代码
- **工作流注册中心**：`core/registry.py` 自动发现、注册、查询工作流
- **状态机驱动**：`core/state_machine.py` 动态加载转换表，原子性状态转换
- **Push 模型**：每阶段完成后 `run_in_background()` 非阻塞启动下一阶段
- **并发安全**：跨平台文件锁（`core/infra.py`）防止双重执行
- **Watcher 保底**：定期检测卡死任务，自动恢复
- **框架零业务知识**：核心模块不含任何工作流专属常量或逻辑

## 目录结构

```
dev-pilot/
├── core/                          # 框架核心（通用引擎）
│   ├── __init__.py
│   ├── db.py                      # SQLite 数据库 & 配置加载
│   ├── state_machine.py           # 纯状态机，转换表由注册表提供
│   ├── runner.py                  # 执行引擎 & Push 模型
│   ├── registry.py                # 工作流插件注册 & 发现
│   ├── infra.py                   # git / 锁 / 通知分发 / AI 调用
│   ├── logger.py                  # 阶段标签日志
│   ├── watcher.py                 # 卡死任务检测 & 恢复
│   └── workflows/                 # 已安装的工作流
│       ├── __init__.py            # discover()
│       ├── dev.py                 # 完整开发流程（5 阶段，自包含）
│       └── req_review.py          # 需求评审（2 阶段，自包含）
├── bin/                           # 通用 CLI
│   ├── start_task.py              # 注册并启动任务（调用 setup_func）
│   ├── run_phase.py               # 后台阶段执行入口
│   ├── cancel_task.py             # 取消任务（从 registry 获取终态）
│   ├── list_tasks.py              # 查询任务列表（支持过滤）
│   ├── show_task.py               # 查看任务详情
│   ├── list_workflows.py          # 列出已注册工作流
│   ├── task_stats.py              # 任务统计概览
│   └── watcher.py                 # cron 异常恢复入口
├── examples/                      # 示例工作流（参考实现）
│   ├── README.md                  # 安装说明
│   ├── dev/                       # dev 完整开发流程
│   │   ├── workflow.py
│   │   ├── config.example.yaml
│   │   └── prompts/
│   └── req_review/                # 需求评审流程
│       ├── workflow.py
│       ├── config.example.yaml
│       └── prompts/
├── prompts/                       # AI 提示词模板
├── knowledge/                     # 架构文档
├── tests/                         # 单元测试
└── config.example.yaml            # 极简框架配置
```

## 开发规范

- Python 3.10+，使用 `from __future__ import annotations` 支持新式类型注解
- 核心函数必须有类型提示
- git 操作使用 `infra._run_git()` 辅助函数，自动检查返回码
- 主分支名从 `config.yaml` 的 `default_branch` 读取，默认 `main`
- 框架核心（core/）不得引入任何工作流专属的常量、配置或逻辑
- 工作流模块必须自包含：业务常量、辅助函数、通知实现均在模块内部

## 新增工作流

1. 在 `core/workflows/` 下创建模块
2. 导出 `WORKFLOW` 字典（必须包含 name/phases/transitions/initial_state/terminal_states）
3. 可选字段：`setup_func`（任务初始化钩子）、`notify_func`（通知实现）

安装示例工作流：
```bash
cp examples/dev/workflow.py core/workflows/dev.py
```

## 运行测试

```bash
pip install pytest pyyaml
python -m pytest tests/ -v
```

## 配置

参考 `config.example.yaml`，框架级配置仅需：
- `workspace`：运行时数据路径（可选）
- `default_branch`：主分支名（可选）

工作流专属配置详见 `examples/` 下各工作流的 `config.example.yaml`。

## 知识库

详细架构文档见 `knowledge/` 目录：
- `architecture.md`：整体架构、模块职责、数据流、设计决策
- `workflow-development.md`：自定义工作流开发指南、WORKFLOW 字典完整字段说明
- `state-machine.md`：状态转换表、驳回机制、各工作流完整状态图
