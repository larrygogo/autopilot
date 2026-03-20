[中文](README.md) | [English](README.en.md)

# Example Workflows

This directory contains example workflow implementations for the autopilot framework, serving as references for developing custom workflows.

## Installing Workflows

Use `autopilot init` to automatically copy example workflows to user space:

```bash
autopilot init
```

Or manually copy directories to `~/.autopilot/workflows/`:

```bash
# Install dev full development workflow (YAML format)
cp -r examples/dev/ ~/.autopilot/workflows/dev/

# Install req_review requirements review workflow
cp -r examples/req_review/ ~/.autopilot/workflows/req_review/

# Install doc_gen document generation and review
cp -r examples/doc_gen/ ~/.autopilot/workflows/doc_gen/

# Install parallel_build parallel build workflow
cp -r examples/parallel_build/ ~/.autopilot/workflows/parallel_build/

# Install data_pipeline data processing pipeline
cp -r examples/data_pipeline/ ~/.autopilot/workflows/data_pipeline/
```

## Available Examples

This directory includes 5 built-in example workflows in two categories:

- **AI Example Workflows**: Integrate with Claude CLI, can run AI-driven complete flows directly
- **Framework Feature Examples**: Demonstrate framework capabilities (auto-derivation, parallelism, jumping, etc.) with placeholder phase functions

### [AI] dev — Full Development Workflow

5 phases: Design -> Design Review -> Development -> Code Review -> PR Submission

- `workflow.yaml` — Workflow definition (auto-derivation + reject syntactic sugar)
- `workflow.py` — Phase function implementation (inline prompts, Claude CLI calls)
- `config.example.yaml` — Minimal config template (repo_path + default_branch)

**Features demonstrated**: 5-phase complete flow, reject rollback mechanism, Claude CLI integration, standard phase pattern (read task -> execute -> save artifacts -> transition -> push next phase)

### [AI] req_review — Requirements Review Workflow

2 phases: Requirements Analysis -> Requirements Review

- `workflow.yaml` — Workflow definition (auto-derivation + reject syntactic sugar)
- `workflow.py` — Phase function implementation (inline prompts, Claude CLI calls)

**Features demonstrated**: minimal 2-phase flow, reject rollback mechanism, local requirement.md as requirements source

### doc_gen — Document Generation and Review

2 phases: Document Generation -> Document Review

- `workflow.yaml` — Minimal YAML (zero manual transitions, fully auto-derived)
- `workflow.py` — Phase functions

**Features demonstrated**: minimal YAML, reject syntactic sugar, zero manual transitions, fully auto-derived states

### parallel_build — Parallel Build Workflow

4 phases: Preparation -> Frontend Build + Backend Build (parallel) -> Integration Testing

- `workflow.yaml` — Parallel phases + hooks definition
- `workflow.py` — Phase functions + hook functions

**Features demonstrated**: parallel fork/join, hooks (before_phase/after_phase), auto-transitions, fail_strategy

### data_pipeline — Data Processing Pipeline

4 phases: Data Extraction -> Data Validation -> Data Transformation -> Data Loading

- `workflow.yaml` — Forward jump + multiple terminal states + manual transitions
- `workflow.py` — Phase functions

**Features demonstrated**: forward jump (validate_skip -> load), multiple terminal states (completed/completed_partial/cancelled), retry_policy, mixed reject and jump usage

## Developing Custom Workflows

Refer to `docs/workflow-development.md` for the complete workflow development guide.

### Recommended: YAML Workflow

Each workflow gets its own directory, containing `workflow.yaml` (structure definition) and `workflow.py` (phase functions):

```yaml
# workflow.yaml
name: my_workflow
description: Workflow description

phases:
  - name: step1
    timeout: 900

  - name: step2
    timeout: 600
    reject: step1      # Retry step1 on rejection
```

```python
# workflow.py
def run_step1(task_id: str) -> None:
    # Phase logic...
    pass

def run_step2(task_id: str) -> None:
    # Phase logic...
    pass
```

### Parallel Phases

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

### Compatible: Python Workflow

A single `.py` file exporting a `WORKFLOW` dictionary. See documentation for details.
