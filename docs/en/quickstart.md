[中文](../quickstart.md) | [English](quickstart.md)

# 5-Minute Quickstart

This tutorial takes you from zero to running your first autopilot task in 5 minutes.

**Prerequisites**: Python 3.10+, Git

---

## Part 1: See Results in 3 Minutes

### Step 1: Install (30s)

```bash
git clone https://github.com/larrygogo/autopilot && cd autopilot
pip install -e ".[dev]"
```

### Step 2: Initialize Workspace (10s)

```bash
autopilot init
autopilot upgrade
```

Expected output:

```
✓ Created ~/.autopilot/
✓ Created ~/.autopilot/workflows/
✓ Created ~/.autopilot/runtime/
✓ Initialization complete
```

### Step 3: List Available Workflows (10s)

```bash
autopilot workflows
```

Expected output (after copying example workflows to `~/.autopilot/workflows/`):

```
Registered workflows:
  dev          [AI] Full dev workflow (Design → Review → Develop → Code Review → PR)
  req_review   [AI] Requirement review (Analysis → Review)
  doc_gen      Document generation and review
```

> **Tip**: The framework auto-scans `~/.autopilot/workflows/`. If the list is empty, copy the example workflows first:
> ```bash
> cp -r examples/workflows/* ~/.autopilot/workflows/
> ```

### Step 4: Start a Task (10s)

Use `doc_gen` (the simplest 2-phase workflow) to start a task:

```bash
autopilot start DOC-001 --workflow doc_gen
```

Expected output:

```
2026-01-15 10:30:00 [INFO] [GENERATE] Task DOC-001 created, workflow: doc_gen
2026-01-15 10:30:00 [INFO] [GENERATE] Starting phase: generate
```

### Step 5: Check Task Status (10s)

```bash
# View single task details
autopilot show DOC-001

# List all tasks
autopilot list
```

`show` expected output:

```
Task: DOC-001
Workflow: doc_gen
Status: pending_generate
Created: 2026-01-15 10:30:00
```

`list` expected output:

```
ID        Workflow    Status             Created
DOC-001   doc_gen    pending_generate   2026-01-15 10:30:00
```

### Step 6: Open the WebUI Dashboard (30s)

Install the WebUI plugin and start it:

```bash
pip install -e examples/plugins/autopilot-webui
autopilot webui
```

Open your browser to `http://127.0.0.1:8080` to see:

- **Dashboard**: Task statistics, success rate, status distribution
- **Task List**: Filter, view details, state transition timeline
- **Workflow List**: Card-style display of all registered workflows

<!-- TODO: Add WebUI screenshots
![WebUI Dashboard](../screenshots/webui-dashboard.png)
-->

### Step 7: View Statistics (10s)

```bash
autopilot stats
```

Expected output:

```
Task statistics:
  Total: 1
  Active: 1
  Completed: 0
  Cancelled: 0
```

---

## Part 2: Create a Custom Workflow (2 min, Optional)

Create a minimal custom workflow to verify the entire flow.

### 1. Create the Workflow Directory

```bash
mkdir -p ~/.autopilot/workflows/hello
```

### 2. Write workflow.yaml

```bash
cat > ~/.autopilot/workflows/hello/workflow.yaml << 'EOF'
name: hello
description: Hello World example workflow

phases:
  - name: greet
    timeout: 60

  - name: farewell
    timeout: 60
EOF
```

You only need to define `name` and `timeout` — all states (`pending_greet`, `running_greet`, etc.) are **auto-derived**.

### 3. Write workflow.py

```bash
cat > ~/.autopilot/workflows/hello/workflow.py << 'EOF'
from core.state_machine import transition
from core.runner import run_in_background

def run_greet(task_id: str) -> None:
    print(f"[hello] Hello, task {task_id}! Starting...")
    transition(task_id, "greet_complete")
    run_in_background(task_id, "farewell")

def run_farewell(task_id: str) -> None:
    print(f"[hello] Task {task_id} done. Goodbye!")
    transition(task_id, "farewell_complete")
EOF
```

### 4. Validate and Run

```bash
# Validate workflow definition
autopilot validate hello

# List workflows (should include hello)
autopilot workflows

# Start a task
autopilot start HELLO-001 --workflow hello

# Check the result
autopilot show HELLO-001
```

Expected output:

```
Task: HELLO-001
Workflow: hello
Status: done
Created: 2026-01-15 10:35:00
```

Congratulations! You've successfully created and run a custom workflow.

---

## Next Steps

| Want to learn about... | Read |
|------------------------|------|
| Full workflow definition syntax | [Workflow Development Guide](workflow-development.md) |
| Internal architecture and design decisions | [Architecture Overview](architecture.md) |
| State machine and rejection mechanism | [State Machine Details](state-machine.md) |
| Developing third-party plugins | [Plugin Development Guide](plugin-development.md) |
| Common issues and troubleshooting | [FAQ](faq.md) |
