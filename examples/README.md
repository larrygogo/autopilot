# 示例工作流

本目录包含 dev-pilot 框架的示例工作流实现，作为开发自定义工作流的参考。

## 安装工作流

将示例工作流复制到 `core/workflows/` 即可激活：

```bash
# 安装 dev 完整开发流程
cp examples/dev/workflow.py core/workflows/dev.py

# 安装 req_review 需求评审流程
cp examples/req_review/workflow.py core/workflows/req_review.py
```

## 可用示例

### dev — 完整开发流程

5 个阶段：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交

- `workflow.py` — 工作流定义 + 阶段函数（自包含）
- `config.example.yaml` — dev 专属配置模板
- `prompts/` — 5 个 AI 提示词模板

### req_review — 需求评审流程

2 个阶段：需求分析 → 需求评审

- `workflow.py` — 工作流定义 + 阶段函数（自包含）
- `config.example.yaml` — req_review 专属配置模板
- `prompts/` — 1 个 AI 提示词模板

## 开发自定义工作流

参考 `knowledge/workflow-development.md` 获取完整的工作流开发指南。

每个工作流模块需要导出一个 `WORKFLOW` 字典，包含：

```python
WORKFLOW = {
    'name': 'my_workflow',
    'description': '工作流描述',
    'setup_func': my_setup,        # 可选：任务初始化钩子
    'notify_func': my_notify,      # 可选：通知实现
    'phases': [...],               # 阶段定义列表
    'transitions': {...},          # 状态转换表
    'initial_state': '...',        # 初始状态
    'terminal_states': [...],      # 终态列表
}
```
