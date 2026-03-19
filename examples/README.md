# 示例工作流

本目录包含 autopilot 框架的示例工作流实现，作为开发自定义工作流的参考。

## 安装工作流

使用 `autopilot init` 自动将示例工作流复制到用户空间：

```bash
autopilot init
```

或手动复制目录到 `~/.autopilot/workflows/`：

```bash
# 安装 dev 完整开发流程（YAML 格式）
cp -r examples/dev/ ~/.autopilot/workflows/dev/

# 安装 req_review 需求评审流程
cp -r examples/req_review/ ~/.autopilot/workflows/req_review/
```

## 可用示例

### dev — 完整开发流程

5 个阶段：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交

- `workflow.yaml` — 工作流定义（YAML 格式，声明式）
- `workflow.py` — 阶段函数实现
- `config.example.yaml` — dev 专属配置模板
- `prompts/` — 5 个 AI 提示词模板

### req_review — 需求评审流程

2 个阶段：需求分析 → 需求评审

- `workflow.yaml` — 工作流定义
- `workflow.py` — 阶段函数实现
- `config.example.yaml` — req_review 专属配置模板
- `prompts/` — 1 个 AI 提示词模板

### doc_gen — 文档生成与评审

2 个阶段：文档生成 → 文档评审

- `workflow.yaml` — 极简 YAML（零手写 transitions，全自动推导）
- `workflow.py` — 阶段函数

**展示特性**：最小 YAML、reject 语法糖、零手写 transitions、状态全自动推导

### parallel_build — 并行构建流程

4 个阶段：准备 → 前端构建 + 后端构建（并行） → 集成测试

- `workflow.yaml` — 并行阶段 + hooks 定义
- `workflow.py` — 阶段函数 + hook 函数

**展示特性**：parallel fork/join、hooks（before_phase/after_phase）、auto-transitions、fail_strategy

### data_pipeline — 数据处理流水线

4 个阶段：数据抽取 → 数据校验 → 数据转换 → 数据加载

- `workflow.yaml` — 前向跳转 + 多终态 + 手写 transitions
- `workflow.py` — 阶段函数

**展示特性**：前向跳转（validate_skip → load）、多终态（completed/completed_partial/cancelled）、retry_policy、reject 与 jump 混用

## 开发自定义工作流

参考 `docs/workflow-development.md` 获取完整的工作流开发指南。

### 推荐方式：YAML 工作流

每个工作流一个目录，包含 `workflow.yaml`（结构定义）和 `workflow.py`（阶段函数）：

```yaml
# workflow.yaml
name: my_workflow
description: 工作流描述

phases:
  - name: step1
    timeout: 900

  - name: step2
    timeout: 600
    reject: step1      # 驳回后重试 step1
```

```python
# workflow.py
def run_step1(task_id: str) -> None:
    # 阶段逻辑...
    pass

def run_step2(task_id: str) -> None:
    # 阶段逻辑...
    pass
```

### 并行阶段

```yaml
phases:
  - name: design
    timeout: 900

  - parallel:
      name: development
      fail_strategy: cancel_all
      phases:
        - name: frontend
          timeout: 1800
        - name: backend
          timeout: 1800

  - name: review
    timeout: 1200
```

### 兼容方式：Python 工作流

单个 `.py` 文件，导出 `WORKFLOW` 字典。详见文档。
