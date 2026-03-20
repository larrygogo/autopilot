[中文](workflow-development.md) | [English](en/workflow-development.md)

# 工作流开发指南

本文档指导你如何为 autopilot 创建自定义工作流。

## 两种定义方式

### 方式一：YAML 工作流（推荐）

目录配对格式，每个工作流一个目录：

```
~/.autopilot/workflows/
├── my_workflow/
│   ├── workflow.yaml    # 工作流定义（结构、阶段、状态）
│   └── workflow.py      # 阶段函数（Python 代码）
```

### 方式二：单文件 Python 工作流

单个 `.py` 文件放入 `~/.autopilot/workflows/`，导出 `WORKFLOW` 字典。

---

## YAML 工作流定义

### 最简写法（状态自动推导）

```yaml
name: doc_gen
description: 自动文档生成与评审

phases:
  - name: generate
    timeout: 600

  - name: review_doc
    timeout: 600
    reject: generate        # 语法糖：自动生成驳回 + 重试逻辑
    max_rejections: 5
```

等价于完整写法：

```yaml
name: doc_gen
description: 自动文档生成与评审
initial_state: pending_generate
terminal_states: [done, cancelled]

phases:
  - name: generate
    label: GENERATE
    pending_state: pending_generate
    running_state: running_generate
    trigger: start_generate
    complete_trigger: generate_complete
    fail_trigger: generate_fail
    timeout: 600
    func: run_generate

  - name: review_doc
    label: REVIEW_DOC
    pending_state: pending_review_doc
    running_state: running_review_doc
    trigger: start_review_doc
    complete_trigger: review_doc_complete
    jump_trigger: review_doc_reject
    jump_target: generate
    max_rejections: 5
    timeout: 600
    func: run_review_doc
```

### 自动推导规则

从 phase `name` 自动生成（以 `design` 为例）：

| 字段 | 推导值 |
|------|--------|
| `pending_state` | `pending_design` |
| `running_state` | `running_design` |
| `trigger` | `start_design` |
| `complete_trigger` | `design_complete` |
| `fail_trigger` | `design_fail` |
| `label` | `DESIGN` |
| `func` | `run_design`（在 workflow.py 中查找） |

Workflow 级别推导：
- `initial_state`：不写则取第一个 phase 的 `pending_state`
- `terminal_states`：不写则 `[done, cancelled]`

### `reject` 语法糖（只能往回跳）

```yaml
- name: review
  reject: design
  max_rejections: 10
```

自动展开为：
```yaml
- name: review
  jump_trigger: review_reject
  jump_target: design
  max_rejections: 10
```

注意：`reject` 目标必须在当前阶段之前，否则校验报错。

### `jump_trigger` / `jump_target`（任意方向跳转）

直接使用底层字段可以跳转到任意阶段（前/后均可）：

```yaml
- name: step2
  jump_trigger: step2_skip
  jump_target: step4    # 可以向前跳
```

### 兼容旧字段

旧字段 `reject_trigger` / `retry_target` 仍可使用，会自动映射为 `jump_trigger` / `jump_target`。

### 函数绑定

YAML 中 `func` 字段是字符串，对应 `workflow.py` 中的函数名：

```yaml
func: my_custom_func    # → workflow.py 中的 my_custom_func()
```

不写 `func` 时，自动使用 `run_{phase_name}` 约定。

支持绑定的函数字段：
- `phases[].func` — 阶段执行函数
- `setup_func` — 任务初始化钩子
- `notify_func` — 通知函数
- `hooks.before_phase` / `hooks.after_phase` / `hooks.on_phase_error`

### transitions 格式

YAML 中手写 transitions 时使用列表格式：

```yaml
transitions:
  pending_design:
    - [start_design, designing]
    - [cancel, cancelled]
  designing:
    - [design_complete, pending_review]
    - [design_fail, pending_design]
    - [cancel, cancelled]
```

不提供 `transitions` 字段时，从 `phases` 自动生成（推荐）。

---

## 并行阶段（parallel）

### YAML 语法

```yaml
phases:
  - name: design
    timeout: 900

  - parallel:
      name: development              # 并行组名称
      fail_strategy: cancel_all      # cancel_all（默认）| continue
      phases:
        - name: frontend
          timeout: 1800
        - name: backend
          timeout: 1800

  - name: code_review
    timeout: 1200
```

### 执行流程

1. 父任务到达并行组时，状态 → `waiting_{group_name}`
2. 为每个子阶段创建独立子任务（子任务 ID：`{parent_id}__{phase_name}`）
3. 子任务并行执行，各自有独立的 lock、status、logs
4. 全部子任务完成 → 父任务自动 transition 到下一阶段
5. 任一子任务失败：
   - `fail_strategy: cancel_all`（默认）→ 取消所有兄弟子任务，父任务回退
   - `fail_strategy: continue` → 等待其他子任务完成

### 数据库字段

子任务使用 tasks 表的核心列：
- `parent_task_id` — 父任务 ID
- `parallel_index` — 并行组内的索引
- `parallel_group` — 并行组名称

子任务自动继承父任务的 `extra` JSON 字段。

### CLI 行为

- `list`：默认隐藏子任务，加 `--all` 显示
- `show`：如果是父任务，显示子任务列表；如果是子任务，显示父任务 ID
- `cancel`：取消父任务时级联取消所有子任务

---

## WORKFLOW 字典结构（单文件 Python 工作流）

```python
WORKFLOW = {
    # === 必填 ===
    'name': str,                # 工作流唯一标识
    'phases': list[dict],       # 阶段定义列表

    # === 选填 ===
    'description': str,
    'initial_state': str,       # 默认：第一个阶段的 pending_state
    'terminal_states': list,    # 默认：['done', 'cancelled']
    'transitions': dict,        # 不提供则自动生成
    'setup_func': callable,     # 任务初始化钩子
    'notify_func': callable,    # 通知实现
    'notify_backends': list,    # 多后端通知配置
    'hooks': dict,              # before_phase / after_phase / on_phase_error
    'retry_policy': dict,       # 重试策略
}
```

## 阶段（Phase）定义字段

```python
{
    'name': str,                # 阶段标识符
    'label': str,               # 日志标签（YAML 自动推导为 NAME.upper()）
    'trigger': str | None,      # 进入运行态的触发器
    'pending_state': str,       # 等待状态名
    'running_state': str,       # 运行状态名
    'complete_trigger': str,    # 完成触发器
    'fail_trigger': str | None, # 失败触发器（回到 pending 重试）
    'jump_trigger': str | None,     # 跳转触发器（reject 语法糖展开后生成）
    'jump_target': str | None,      # 跳转目标阶段名
    'max_rejections': int,      # 最大驳回次数（默认 10）
    'func': callable,           # 阶段执行函数
}
```

## 转换表：自动生成 vs 手写

### 自动生成（推荐）

不提供 `transitions` 字段时，`registry.build_transitions()` 从 `phases` 自动生成：

- `pending_state` → `(trigger, running_state)`
- `running_state` → `(complete_trigger, next_pending_state)`
- 有 `fail_trigger` 时：`running_state` → `(fail_trigger, pending_state)`
- 有 `jump_trigger` 时：生成驳回和重试转换
- 所有非终态都加入 `(cancel, cancelled)`
- `parallel` 阶段自动生成 fork/join 转换

### 手写

复杂流程需要非线性流转时才需手写：

```yaml
transitions:
  state_a:
    - [trigger1, state_b]
    - [trigger2, state_c]  # 条件分支
```

## 任务数据存储

框架 schema 只保留核心列，工作流自定义字段存入 `extra` JSON：

```python
# 创建任务：核心字段显式传入，其余自动存入 extra
create_task(
    task_id="T001",
    title="My Task",
    workflow="dev",
    channel="telegram",
    notify_target="chat-id",
    # 以下全部存入 extra JSON
    req_id="REQ-001",
    project="my-project",
    repo_path="/path/to/repo",
    branch="feat/T001",
    agents={"dev": "claude"},
)

# 读取：extra 字段自动展开，直接访问
task = get_task("T001")
task["repo_path"]  # 直接可用，无需关心存储位置
task["project"]    # 同上

# 更新：透明区分列字段 vs extra
update_task("T001", pr_url="https://...", failure_count=1)
```

## 阶段函数编写规范

### 编写模式

```python
def run_my_phase(task_id: str) -> None:
    # 1. 获取任务信息（extra 字段自动展开）
    task = get_task(task_id)

    # 2. 准备输入
    plan = (task_dir / "plan.md").read_text()

    # 3. 执行核心逻辑（直接访问 extra 字段）
    result = my_execute(prompt, repo_path=task['repo_path'])

    # 4. 保存产出物
    (task_dir / "output.md").write_text(result)

    # 5. 状态转换（extra_updates 同样透明区分）
    transition(task_id, 'my_phase_complete')

    # 6. Push 下一阶段
    run_in_background(task_id, 'next_phase')
```

### 注意事项

- **不要手动管理锁**：`execute_phase()` 自动获取锁
- **不要吞异常**：让异常抛出，Runner 会捕获并记录
- **转换必须在 Push 之前**：先 `transition()` 再 `run_in_background()`
- **字段存储透明**：`get_task()` 自动展开 extra，开发者无需关心字段在列里还是 JSON 里

## 完整示例

参见 `examples/dev/` 和 `examples/req_review/`：
- `workflow.yaml` — 工作流定义
- `workflow.py` — 阶段函数实现
