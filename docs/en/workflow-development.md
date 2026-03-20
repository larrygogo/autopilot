[中文](../workflow-development.md) | [English](workflow-development.md)

# Workflow Development Guide

This document guides you through creating custom workflows for autopilot.

## Two Definition Approaches

### Approach 1: YAML Workflow (Recommended)

Directory-paired format, one directory per workflow:

```
~/.autopilot/workflows/
├── my_workflow/
│   ├── workflow.yaml    # Workflow definition (structure, phases, states)
│   └── workflow.py      # Phase functions (Python code)
```

### Approach 2: Single-file Python Workflow

A single `.py` file placed in `~/.autopilot/workflows/`, exporting a `WORKFLOW` dictionary.

---

## YAML Workflow Definition

### Minimal Syntax (Auto-derived States)

```yaml
name: doc_gen
description: Automatic document generation and review

phases:
  - name: generate
    timeout: 600

  - name: review_doc
    timeout: 600
    reject: generate        # Syntactic sugar: auto-generates rejection + retry logic
    max_rejections: 5
```

Equivalent full syntax:

```yaml
name: doc_gen
description: Automatic document generation and review
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

### Auto-derivation Rules

Auto-generated from phase `name` (using `design` as an example):

| Field | Derived Value |
|-------|--------------|
| `pending_state` | `pending_design` |
| `running_state` | `running_design` |
| `trigger` | `start_design` |
| `complete_trigger` | `design_complete` |
| `fail_trigger` | `design_fail` |
| `label` | `DESIGN` |
| `func` | `run_design` (looked up in workflow.py) |

Workflow-level derivation:
- `initial_state`: defaults to the first phase's `pending_state` if not specified
- `terminal_states`: defaults to `[done, cancelled]` if not specified

### `reject` Syntactic Sugar (Backward Jump Only)

```yaml
- name: review
  reject: design
  max_rejections: 10
```

Auto-expands to:
```yaml
- name: review
  jump_trigger: review_reject
  jump_target: design
  max_rejections: 10
```

Note: the `reject` target must be before the current phase; otherwise validation will fail.

### `jump_trigger` / `jump_target` (Any Direction Jump)

Using the underlying fields directly allows jumping to any phase (forward or backward):

```yaml
- name: step2
  jump_trigger: step2_skip
  jump_target: step4    # Can jump forward
```

### Legacy Field Compatibility

Legacy fields `reject_trigger` / `retry_target` can still be used and are automatically mapped to `jump_trigger` / `jump_target`.

### Function Binding

The `func` field in YAML is a string corresponding to a function name in `workflow.py`:

```yaml
func: my_custom_func    # → my_custom_func() in workflow.py
```

When `func` is omitted, the `run_{phase_name}` convention is used automatically.

Supported function binding fields:
- `phases[].func` — phase execution function
- `setup_func` — task initialization hook
- `notify_func` — notification function
- `hooks.before_phase` / `hooks.after_phase` / `hooks.on_phase_error`

### transitions Format

When writing transitions manually in YAML, use list format:

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

When the `transitions` field is not provided, transitions are auto-generated from `phases` (recommended).

---

## Parallel Phases

### YAML Syntax

```yaml
phases:
  - name: design
    timeout: 900

  - parallel:
      name: development              # Parallel group name
      fail_strategy: cancel_all      # cancel_all (default) | continue
      phases:
        - name: frontend
          timeout: 1800
        - name: backend
          timeout: 1800

  - name: code_review
    timeout: 1200
```

### Execution Flow

1. When the parent task reaches the parallel group, its status transitions to `waiting_{group_name}`
2. Independent subtasks are created for each sub-phase (subtask ID: `{parent_id}__{phase_name}`)
3. Subtasks execute in parallel, each with independent lock, status, and logs
4. All subtasks complete -> parent task automatically transitions to the next phase
5. If any subtask fails:
   - `fail_strategy: cancel_all` (default) -> cancel all sibling subtasks, parent task rolls back
   - `fail_strategy: continue` -> wait for other subtasks to complete

### Database Fields

Subtasks use the tasks table's core columns:
- `parent_task_id` — parent task ID
- `parallel_index` — index within the parallel group
- `parallel_group` — parallel group name

Subtasks automatically inherit the parent task's `extra` JSON field.

### CLI Behavior

- `list`: subtasks are hidden by default; use `--all` to show them
- `show`: for parent tasks, displays subtask list; for subtasks, displays parent task ID
- `cancel`: cancelling a parent task cascades to cancel all subtasks

---

## WORKFLOW Dictionary Structure (Single-file Python Workflow)

```python
WORKFLOW = {
    # === Required ===
    'name': str,                # Unique workflow identifier
    'phases': list[dict],       # Phase definition list

    # === Optional ===
    'description': str,
    'initial_state': str,       # Default: first phase's pending_state
    'terminal_states': list,    # Default: ['done', 'cancelled']
    'transitions': dict,        # Auto-generated if not provided
    'setup_func': callable,     # Task initialization hook
    'notify_func': callable,    # Notification implementation
    'notify_backends': list,    # Multi-backend notification config
    'hooks': dict,              # before_phase / after_phase / on_phase_error
    'retry_policy': dict,       # Retry policy
}
```

## Phase Definition Fields

```python
{
    'name': str,                # Phase identifier
    'label': str,               # Log tag (YAML auto-derives as NAME.upper())
    'trigger': str | None,      # Trigger to enter running state
    'pending_state': str,       # Pending state name
    'running_state': str,       # Running state name
    'complete_trigger': str,    # Completion trigger
    'fail_trigger': str | None, # Failure trigger (returns to pending for retry)
    'jump_trigger': str | None,     # Jump trigger (generated from reject syntactic sugar)
    'jump_target': str | None,      # Jump target phase name
    'max_rejections': int,      # Maximum rejection count (default 10)
    'func': callable,           # Phase execution function
}
```

## Transition Table: Auto-generated vs Manual

### Auto-generated (Recommended)

When `transitions` field is not provided, `registry.build_transitions()` auto-generates from `phases`:

- `pending_state` -> `(trigger, running_state)`
- `running_state` -> `(complete_trigger, next_pending_state)`
- With `fail_trigger`: `running_state` -> `(fail_trigger, pending_state)`
- With `jump_trigger`: generates rejection and retry transitions
- All non-terminal states include `(cancel, cancelled)`
- `parallel` phases auto-generate fork/join transitions

### Manual

Only needed for complex flows requiring non-linear routing:

```yaml
transitions:
  state_a:
    - [trigger1, state_b]
    - [trigger2, state_c]  # Conditional branching
```

## Task Data Storage

The framework schema retains only core columns; workflow-specific fields are stored in `extra` JSON:

```python
# Create task: core fields passed explicitly, rest auto-stored in extra
create_task(
    task_id="T001",
    title="My Task",
    workflow="dev",
    channel="telegram",
    notify_target="chat-id",
    # Everything below stored in extra JSON
    req_id="REQ-001",
    project="my-project",
    repo_path="/path/to/repo",
    branch="feat/T001",
    agents={"dev": "claude"},
)

# Read: extra fields auto-expanded, direct access
task = get_task("T001")
task["repo_path"]  # Directly accessible, no need to worry about storage location
task["project"]    # Same

# Update: transparent distinction between column fields vs extra
update_task("T001", pr_url="https://...", failure_count=1)
```

## Phase Function Writing Guidelines

### Writing Pattern

```python
def run_my_phase(task_id: str) -> None:
    # 1. Get task info (extra fields auto-expanded)
    task = get_task(task_id)

    # 2. Prepare inputs
    plan = (task_dir / "plan.md").read_text()

    # 3. Execute core logic (direct access to extra fields)
    result = my_execute(prompt, repo_path=task['repo_path'])

    # 4. Save artifacts
    (task_dir / "output.md").write_text(result)

    # 5. State transition (extra_updates also transparently distinguished)
    transition(task_id, 'my_phase_complete')

    # 6. Push next phase
    run_in_background(task_id, 'next_phase')
```

### Important Notes

- **Do not manually manage locks**: `execute_phase()` acquires locks automatically
- **Do not swallow exceptions**: let exceptions propagate; Runner will catch and log them
- **Transition before Push**: call `transition()` before `run_in_background()`
- **Transparent field storage**: `get_task()` auto-expands extra; developers need not worry about whether a field is in a column or JSON

## Complete Examples

See `examples/workflows/dev/` and `examples/workflows/req_review/`:
- `workflow.yaml` — workflow definition
- `workflow.py` — phase function implementation
