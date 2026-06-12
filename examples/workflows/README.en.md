[中文](README.md) | [English](README.en.md)

# Example Workflows

This directory is autopilot's workflow template library (the source `autopilot workflow create` clones from), split into two tiers:

- **Product templates** — PR-delivery shaped. They plug into the platform's full value-added services: requirement clarification, per-repo scheduling, PR acceptance, the fix_revision repair loop, and automatic CI fixing. The bridge generalizes on "does the task deliver a PR" (not on phase names), so custom variants derived from this tier (extra phases / different phase agents / rejection tuning / parallel blocks) get the whole service suite as long as they end up delivering a PR. **Start your custom workflows from this tier.**
- **Engine capability demos** — teaching fixtures that showcase state-machine / YAML engine features (hand-written transitions, forward jumps, multiple terminal states, parallelism, hooks, zero-code prompts). They serve as live examples for docs like `docs/state-machine.md`. **They depend only on the engine contract and do not plug into the requirement loop's value-added services**; running them also surfaces no decision affordance on the Web console — use them as syntax references, not for real work.

> See "产品分层定位" in the repo root `CLAUDE.md` for the product positioning: workflow customization is currently scoped to customizing the PR delivery pipeline, not a general-purpose process orchestration platform.

## Installation

`autopilot init` automatically installs the two product workflows **dev** and **ad-hoc**. Clone other templates as needed:

```bash
autopilot workflow create <name>      # derive from a template interactively

# or copy manually
cp -r examples/workflows/doc_gen/ ~/.autopilot/workflows/doc_gen/
```

Existing users can pull template bug fixes from the repo: `autopilot workflow sync dev` (dry-run shows the diff, add `--apply` to overwrite).

## Product Templates (PR-delivery shaped)

### dev — full development workflow (installed by init)

5 phases: design → design review → develop → code review → submit PR

- `workflow.yaml` — workflow definition (auto-derivation + reject sugar + per-phase inline agents)
- `workflow.ts` — phase function implementations
- `config.example.yaml` — configuration template

**Showcases**: the full requirement loop (clarify → execute → submit_pr delivery → pr-poller acceptance → fix_revision repair), the reject mechanism, stop-and-report on rejection cap, multi-repo requirements delivering one PR per repo

### ad-hoc — ad-hoc task (installed by init)

Single-phase zero-code workflow; the default workflow behind `autopilot run "<prompt>"`: skips the project/requirement ceremony and runs an agent prompt directly. With a workspace it builds a sandbox on top of it; without one it degrades to an empty directory (good for writing docs, generating scripts, experiments).

### req_dev — requirement development (a lean variant of dev)

design → review → develop → code_review → submit_pr, with agents configured inline per phase. A good minimal starting point for deriving custom PR delivery pipelines.

## Engine Capability Demos (teaching fixtures)

### prompt_quick — quick prompt writing

2 phases, zero code: write `prompt:` directly in the yaml and the framework's built-in prompt-runner invokes the agent — no ts needed. **Showcases**: zero-code workflows, the handoff protocol (`${HANDOFF}` passed across phases), per-phase inline agents

### doc_gen — document generation and review

A 2-phase minimal structure example. **Showcases**: minimal YAML, reject sugar, zero hand-written transitions, fully auto-derived states

### parallel_build — parallel build workflow

prepare → frontend build + backend build (parallel) → integration test. **Showcases**: parallel fork/join, hooks (before_phase/after_phase), fail_strategy

### data_pipeline — data processing pipeline

extract → validate → transform → load. **Showcases**: forward jump (validate_skip → load), multiple terminal states (completed/completed_partial/cancelled), retry_policy, hand-written transitions — the only complete reference for these fields

### req_review — requirement review workflow

requirement analysis → requirement review. **Showcases**: a minimal 2-phase flow with reject

### with_human — human-in-the-loop example

plan (`gate: true` manual approval) → review. **Note**: the gate and ask_user mechanisms themselves are product-grade (available to dev-style workflows too); this workflow is merely their minimal demo.

**Showcases**:
- **Gate** (manual approval): `gate: true` + `gate_message`; the UI shows an approval banner [approve / reject / cancel], and the rejection reason is fed to the next round via `task.last_user_decision`
- **ask_user** (mid-run agent questions): the framework auto-injects the `mcp__autopilot_workflow__ask_user` tool; when called, the task stays in `running_<phase>` with `pending_question` set; the UI shows a question banner and renders buttons in options mode
- **Key pitfall**: with a gate, do **not** call `transition('xxx_complete')` + `runInBackground('next')` at the end of the phase function — that bypasses the gate

See the "Human interaction (Gate and ask_user)" section in `docs/workflow-development.md` for full documentation.

## Developing Custom Workflows

See `docs/workflow-development.md` for the complete workflow development guide.
