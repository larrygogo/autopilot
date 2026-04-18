[中文](README.md) | [English](README.en.md)

# Example Workflows

This directory contains example workflow implementations for the autopilot framework, intended as references for developing your own.

## Installing Workflows

Use `autopilot init` to copy the example workflows into your user space automatically:

```bash
autopilot init
```

Or copy the directories manually into `~/.autopilot/workflows/`:

```bash
# install dev — full development workflow (YAML format)
cp -r examples/workflows/dev/ ~/.autopilot/workflows/dev/

# install req_review — requirements review workflow
cp -r examples/workflows/req_review/ ~/.autopilot/workflows/req_review/

# install doc_gen — document generation and review
cp -r examples/workflows/doc_gen/ ~/.autopilot/workflows/doc_gen/

# install parallel_build — parallel build workflow
cp -r examples/workflows/parallel_build/ ~/.autopilot/workflows/parallel_build/

# install data_pipeline — data processing pipeline
cp -r examples/workflows/data_pipeline/ ~/.autopilot/workflows/data_pipeline/
```

## Available Examples

This directory ships 6 example workflows, in two categories:

- **AI example workflows**: integrate the Claude CLI and run a full AI-driven flow out of the box
- **Framework feature examples**: showcase framework capabilities (auto-derivation, parallel, jumps, etc.); phase functions are placeholder implementations

### [AI] dev — Full development workflow

5 phases: plan design → plan review → develop → code review → PR submission

- `workflow.yaml` — workflow definition (auto-derivation + reject syntactic sugar)
- `workflow.py` — phase function implementations (inline prompts, calls the Claude CLI)
- `config.example.yaml` — minimal config template (repo_path + default_branch)

**Features showcased**: full 5-phase flow, reject mechanism, Claude CLI integration, standard phase pattern (read task → execute → save artifact → transition → push next phase)

### [AI] req_review — Requirements review workflow

2 phases: requirement analysis → requirement review

- `workflow.yaml` — workflow definition (auto-derivation + reject syntactic sugar)
- `workflow.py` — phase function implementations (inline prompts, calls the Claude CLI)

**Features showcased**: minimal 2-phase flow, reject mechanism, requirement source from local requirement.md

### doc_gen — Document generation and review

2 phases: document generation → document review

- `workflow.yaml` — minimal YAML (zero hand-written transitions, fully auto-derived)
- `workflow.py` — phase functions

**Features showcased**: minimal YAML, reject syntactic sugar, zero hand-written transitions, fully auto-derived states

### parallel_build — Parallel build workflow

4 phases: prepare → frontend build + backend build (parallel) → integration test

- `workflow.yaml` — parallel phases + hooks definition
- `workflow.py` — phase functions + hook functions

**Features showcased**: parallel fork/join, hooks (before_phase/after_phase), auto-transitions, fail_strategy

### data_pipeline — Data processing pipeline

4 phases: data extract → data validate → data transform → data load

- `workflow.yaml` — forward jump + multiple terminal states + hand-written transitions
- `workflow.py` — phase functions

**Features showcased**: forward jump (validate_skip → load), multiple terminal states (completed/completed_partial/cancelled), retry_policy, mixed reject and jump

### [AI] with_human — Human-in-the-loop example

2 phases: plan → review, paired with the two built-in human-in-the-loop mechanisms:

- `workflow.yaml` — `plan` is configured with `gate: true`, suspends after run waiting for user approval
- `workflow.ts` — the prompt for the `plan` phase encourages the agent to call the `ask_user` tool when the direction is unclear

**Features showcased**:
- **Gate** (manual approval): `gate: true` + `gate_message`, the UI shows an orange banner [Pass / Reject / Cancel], the rejection note is fed to the next round via `task.last_user_decision`
- **ask_user** (agent asks mid-run): the framework auto-injects the `mcp__autopilot_workflow__ask_user` tool; after the agent calls it the task stays at `running_<phase>` but `pending_question` is written; the UI shows a blue banner, options mode renders buttons
- **Key pitfall**: when using gate, **do not** actively call `transition('xxx_complete')` + `runInBackground('next')` at the end of the phase function, otherwise the gate will be bypassed

Full documentation in the "Human-in-the-loop (Gate & ask_user)" section of `docs/en/workflow-development.md`.

## Developing Custom Workflows

Refer to `docs/en/workflow-development.md` for the complete workflow development guide.
