# 示例工作流

本目录包含 autopilot 框架的示例工作流实现，作为开发自定义工作流的参考。

## 安装工作流

将示例工作流复制到 `core/workflows/` 即可激活：

```bash
# 安装 dev 完整开发流程
cp examples/dev/workflow.py core/workflows/dev.py

# 安装 req_review 需求评审流程
cp examples/req_review/workflow.py core/workflows/req_review.py

# 安装 doc_gen 文档生成流程
cp examples/doc_gen/workflow.py core/workflows/doc_gen.py

# 安装 parallel_build 并行构建流程
cp examples/parallel_build/workflow.py core/workflows/parallel_build.py

# 安装 data_pipeline 数据处理流水线
cp examples/data_pipeline/workflow.py core/workflows/data_pipeline.py
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

### doc_gen — 文档生成与评审

2 个阶段：文档生成 → 文档评审

- `workflow.yaml` — 极简 YAML 配置（展示最小定义）
- `workflow.py` — 工作流定义 + 阶段函数

**展示特性**：最小 YAML、reject 语法糖、零手写 transitions、状态全自动推导

### parallel_build — 并行构建流程

4 个阶段：准备 → 前端构建 + 后端构建（并行） → 集成测试

- `workflow.yaml` — 并行阶段 YAML 配置
- `workflow.py` — 工作流定义 + hook 函数 + 阶段函数

**展示特性**：parallel fork/join、hooks（before_phase/after_phase）、手写 transitions、fail_strategy

### data_pipeline — 数据处理流水线

4 个阶段：数据抽取 → 数据校验 → 数据转换 → 数据加载

- `workflow.yaml` — 前向跳转 + 多终态 YAML 配置
- `workflow.py` — 工作流定义 + 阶段函数

**展示特性**：jump_trigger/jump_target 前向跳转、多终态（completed/completed_partial/cancelled）、retry_policy、reject 与 jump 混用

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
    'transitions': {...},          # 状态转换表（可选，框架可自动推导）
    'initial_state': '...',        # 初始状态
    'terminal_states': [...],      # 终态列表
}
```
