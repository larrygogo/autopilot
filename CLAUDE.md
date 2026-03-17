# dev-pilot (openclaw-dev-workflow)

AI 驱动的可扩展开发工作流自动化框架，基于状态机 + Push 模型 + 插件化工作流。

## 架构概要

- **插件化工作流**：`src/dev_workflow/workflows/` 下新增模块即自动注册，无需改核心代码
- **工作流注册中心**：`src/dev_workflow/registry.py` 自动发现、注册、查询工作流
- **状态机驱动**：`src/dev_workflow/state_machine.py` 动态加载转换表，原子性状态转换
- **Push 模型**：每阶段完成后 `run_in_background()` 非阻塞启动下一阶段
- **并发安全**：跨平台文件锁（`infra.py`）防止双重执行
- **Watcher 保底**：定期检测卡死任务，自动恢复

## 目录结构

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
  architecture.md              架构总览
  workflow-development.md      工作流开发指南
  state-machine.md             状态机详解
tests/                      单元测试
```

## 开发规范

- Python 3.10+，使用 `from __future__ import annotations` 支持新式类型注解
- 核心函数必须有类型提示
- git 操作使用 `infra._run_git()` 辅助函数，自动检查返回码
- 主分支名从 `config.yaml` 的 `default_branch` 读取，默认 `main`
- 超时值从 `config.yaml` 的 `timeouts` 读取，不要硬编码
- 新增工作流：在 `workflows/` 下创建模块并导出 `WORKFLOW` 字典即可

## 运行测试

```bash
pip install pytest
python -m pytest tests/ -v
```

## 配置

参考 `config.example.yaml`，关键配置项：
- `default_branch`：主分支名
- `timeouts`：各阶段超时
- `reqgenie`：需求系统
- `notify`：通知渠道
- `agents`：AI agent 分配
- `projects`：项目映射

## 知识库

详细架构文档见 `knowledge/` 目录：
- `architecture.md`：整体架构、模块职责、数据流、设计决策
- `workflow-development.md`：自定义工作流开发指南、WORKFLOW 字典完整字段说明
- `state-machine.md`：状态转换表、驳回机制、各工作流完整状态图
