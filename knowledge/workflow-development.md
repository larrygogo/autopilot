# 工作流开发指南

本文档指导你如何为 autopilot 创建自定义工作流。

## WORKFLOW 字典结构

每个工作流模块必须导出一个 `WORKFLOW` 字典：

```python
WORKFLOW = {
    # === 必填 ===
    'name': str,                # 工作流唯一标识（如 'dev', 'req_review'）
    'description': str,         # 人类可读描述
    'phases': list[dict],       # 阶段定义列表（顺序即执行顺序）

    # === 选填 ===
    'initial_state': str,       # 初始状态（默认：第一个阶段的 pending_state）
    'terminal_states': list[str],  # 终态列表（默认：['cancelled']）
    'transitions': dict,        # 手写转换表（不提供则自动生成）
}
```

## 阶段（Phase）定义字段

每个阶段是一个字典：

```python
{
    'name': str,                # 阶段标识符，用于 execute_phase(task_id, name)
    'label': str,               # 日志标签，如 'PLAN_DESIGN'（显示为 [PLAN_DESIGN]）
    'trigger': str | None,      # 进入运行态的触发器（None 表示自动进入）
    'pending_state': str,       # 等待状态名
    'running_state': str,       # 运行状态名
    'complete_trigger': str,    # 完成触发器（成功时调用）
    'fail_trigger': str | None, # 失败触发器（可选，触发后回到 pending_state 重试）
    'reject_trigger': str | None,   # 驳回触发器（可选）
    'retry_target': str | None,     # 驳回后重试的目标阶段名（可选）
    'timeout_key': str,         # config.yaml 中 timeouts 的键名
    'max_rejections': int,      # 最大驳回次数（默认 10，超过则取消任务）
    'func': callable,           # 阶段执行函数：func(task_id: str) -> None
}
```

### 字段详解

| 字段 | 说明 |
|------|------|
| `name` | 唯一标识符，传给 `execute_phase()` 和 `run_in_background()` |
| `label` | 日志中的阶段标签，格式 `[LABEL]`，建议大写下划线风格 |
| `trigger` | `pending_state` → `running_state` 的触发器名；设为 `None` 跳过显式触发 |
| `pending_state` | 等待执行的状态，如 `pending_design` |
| `running_state` | 正在执行的状态，如 `designing` |
| `complete_trigger` | 阶段成功完成时调用 `transition(task_id, complete_trigger)` |
| `fail_trigger` | 执行失败时 `running_state` → `pending_state` 的触发器（用于重试） |
| `reject_trigger` | 评审驳回时的触发器，`running_state` → `{name}_rejected` |
| `retry_target` | 驳回后要重新执行的阶段名（如 review 驳回后重试 design） |
| `timeout_key` | 对应 `config.yaml` 的 `timeouts.{timeout_key}` |
| `max_rejections` | 驳回次数上限，超过后自动取消任务 |
| `func` | Python 函数，签名：`func(task_id: str) -> None` |

## 转换表：自动生成 vs 手写

### 自动生成（推荐）

不提供 `transitions` 字段时，`registry.build_transitions()` 会从 `phases` 自动生成转换表：

- 每个阶段生成：`pending_state` → `(trigger, running_state)`
- 每个阶段生成：`running_state` → `(complete_trigger, next_pending_state)`
- 有 `fail_trigger` 时：`running_state` → `(fail_trigger, pending_state)`
- 有 `reject_trigger` 时：生成驳回和重试转换
- 所有非终态都加入 `(cancel, cancelled)` 转换

**优点**：简洁、不易出错、阶段定义即转换规则。

### 手写

在 `WORKFLOW` 中提供 `transitions` 字段：

```python
'transitions': {
    'pending_design': [
        ('start_design', 'designing'),
        ('cancel', 'cancelled'),
    ],
    'designing': [
        ('design_complete', 'pending_review'),
        ('design_fail', 'pending_design'),
        ('cancel', 'cancelled'),
    ],
    # ...
}
```

**适用场景**：需要非线性流转（如条件分支、并行阶段）时才需要手写。

## 完整示例：从零创建工作流

以创建一个「文档生成」工作流为例：

### 第 1 步：编写阶段函数

```python
# src/dev_workflow/workflows/doc_gen.py
from __future__ import annotations

import logging
from dev_workflow.infra import run_claude, PROMPTS_DIR, notify
from dev_workflow.db import get_task
from dev_workflow.state_machine import transition
from dev_workflow.runner import run_in_background

log = logging.getLogger('dev_workflow')


def run_generate(task_id: str) -> None:
    """生成文档"""
    task = get_task(task_id)
    prompt = f"为 {task['title']} 生成技术文档"
    result = run_claude(prompt, repo_path=task['repo_path'], timeout=600)

    # 保存产出物
    task_dir = Path(f"runtime/dev-tasks/{task_id}")
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / 'doc.md').write_text(result)

    # 推进到下一阶段
    transition(task_id, 'generate_complete')
    run_in_background(task_id, 'review_doc')


def run_review_doc(task_id: str) -> None:
    """评审文档"""
    task = get_task(task_id)
    doc = Path(f"runtime/dev-tasks/{task_id}/doc.md").read_text()
    prompt = f"评审以下文档...\n\n{doc}"
    result = run_claude(prompt, timeout=600)

    if 'REVIEW_RESULT: PASS' in result:
        transition(task_id, 'review_doc_pass')
        notify(task, '文档生成完成 ✓')
    else:
        transition(task_id, 'review_doc_reject')
        transition(task_id, 'retry_generate')
        run_in_background(task_id, 'generate')
```

### 第 2 步：定义 WORKFLOW 字典

```python
WORKFLOW = {
    'name': 'doc_gen',
    'description': '自动文档生成与评审',
    'terminal_states': ['doc_done', 'cancelled'],
    'phases': [
        {
            'name': 'generate',
            'label': 'DOC_GENERATE',
            'trigger': 'start_generate',
            'pending_state': 'pending_generate',
            'running_state': 'generating',
            'complete_trigger': 'generate_complete',
            'fail_trigger': 'generate_fail',
            'timeout_key': 'design',
            'func': run_generate,
        },
        {
            'name': 'review_doc',
            'label': 'DOC_REVIEW',
            'trigger': 'start_review_doc',
            'pending_state': 'pending_review_doc',
            'running_state': 'reviewing_doc',
            'complete_trigger': 'review_doc_pass',
            'reject_trigger': 'review_doc_reject',
            'retry_target': 'generate',
            'timeout_key': 'review',
            'max_rejections': 5,
            'func': run_review_doc,
        },
    ],
}
```

### 第 3 步：启动任务

```bash
python3 bin/start_task.py <req_id> --project my-project --workflow doc_gen
```

框架会自动发现 `doc_gen.py`，加载 `WORKFLOW` 字典，执行第一个阶段。

## 阶段函数编写规范

### 可用的 infra 工具函数

| 函数 | 用途 | 示例 |
|------|------|------|
| `run_claude(prompt, repo_path, timeout)` | 调用 Claude CLI | `result = run_claude(prompt, cwd, 900)` |
| `_run_git(args, cwd)` | 执行 git 命令 | `_run_git(['checkout', 'main'], repo)` |
| `fetch_req(req_id)` | 获取 ReqGenie 需求 | `req = fetch_req(task['req_id'])` |
| `notify(task, message)` | 发送通知 | `notify(task, '阶段完成')` |
| `acquire_lock(task_id)` | 获取文件锁 | Runner 自动管理，阶段函数无需调用 |

### 阶段函数编写模式

```python
def run_my_phase(task_id: str) -> None:
    # 1. 获取任务信息
    task = get_task(task_id)

    # 2. 准备输入（读取上游产出物、获取需求等）
    plan = Path(f"runtime/dev-tasks/{task_id}/plan.md").read_text()

    # 3. 执行核心逻辑（调用 AI、操作 git 等）
    result = run_claude(prompt, repo_path=task['repo_path'])

    # 4. 保存产出物
    Path(f"runtime/dev-tasks/{task_id}/output.md").write_text(result)

    # 5. 状态转换
    transition(task_id, 'my_phase_complete')

    # 6. Push 下一阶段
    run_in_background(task_id, 'next_phase')
```

### 注意事项

- **不要手动管理锁**：`execute_phase()` 会在调用阶段函数前自动获取锁
- **不要吞异常**：让异常抛出，Runner 会捕获并记录 `failure_count`
- **产出物存放路径**：`runtime/dev-tasks/{task_id}/`
- **超时由 Runner 管理**：阶段函数内部不需要处理超时
- **转换必须在 Push 之前**：先 `transition()` 再 `run_in_background()`
