# req_dev Workflow Guide

`req_dev` is autopilot's next-generation development workflow that replaces the legacy `dev` workflow, purpose-built for the "requirement queue" working model. See the [Requirement Queue design doc](../superpowers/specs/2026-05-06-requirement-queue-design.md).

## Differences from the dev workflow

| | dev (legacy) | req_dev (new) |
|---|----------|--------------|
| Repo binding | workflow.yaml `config.repo_path`, single global repo | per-task `repo_id`, looked up from the `repos` table |
| setup input | `{ title, requirement }` | `{ repo_id, title, requirement }` |
| Phases (P1) | 5 phases | 5 phases (design / review / develop / code_review / submit_pr) |
| Phases (P3+) | — | 7 phases (extra await_review / fix_revision for the PR feedback loop) |
| Multi-repo | ❌ (one workflow, one repo) | ✅ (multiple repos under one daemon) |

## Prerequisites

### 1. Register a repository

Register the repo on the Web UI `/repos` page (alias / path / default_branch / optional github_owner-repo).

Or via REST:

```bash
curl -X POST http://127.0.0.1:6180/api/repos \
  -H "Content-Type: application/json" \
  -d '{"alias":"my-project","path":"/abs/path/to/project","default_branch":"main"}'
```

### 2. Health check

After registering, click the "Health Check" button. autopilot verifies:
- The path exists and is a directory
- It is a git repository
- The origin remote is reachable (on success the GitHub owner/repo is parsed from the origin URL and backfilled automatically)

### 3. gh CLI login

The submit_pr phase uses `gh pr create`, so run `gh auth login` beforehand.

## Launching

### CLI

```bash
autopilot task start --workflow req_dev --repo <alias> "Title" --requirement "Requirement description..."
```

Parameters:
- `--workflow req_dev` (required)
- `--repo <alias>` (required for req_dev)
- Title as a positional argument
- `--requirement "..."` detailed requirement description (use a shell heredoc for multi-line)

### REST

```bash
curl -X POST http://127.0.0.1:6180/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "workflow": "req_dev",
    "title": "Add GitHub Issues integration",
    "requirement": "Detailed requirement description...",
    "repo_alias": "my-project"
  }'
```

Or pass `repo_id` directly (skipping alias resolution):

```json
{
  "workflow": "req_dev",
  "title": "...",
  "requirement": "...",
  "repo_id": "repo-001"
}
```

## Phase flow (P1)

```
design (architect agent produces plan.md)
  ↓
review (reviewer evaluates the plan; REJECT goes back to design, PASS proceeds to develop)
  ↓
develop (developer agent branches + writes code + commits)
  ↓
code_review (reviewer audits the code diff; REJECT goes back to develop, PASS proceeds to submit_pr)
  ↓
submit_pr (push branch + gh pr create/edit; writes pr_url / pr_number back to task extra)
```

Each phase's artifacts are saved under the task workspace `<task_workspace>/NN-<phase>/`:
- `00-design/plan.md` — implementation plan
- `01-review/plan_review.md` — review conclusion
- `03-code_review/code_review.md` — code review conclusion

Full phase logs are viewable on the task detail page in the Web UI.

## Automatic PR review/merge polling (from P4)

After the daemon starts it runs the pr-poller module, which periodically (default 5 min) scans the PRs of all requirements in `awaiting_review` status:

- A `CHANGES_REQUESTED` review → auto `inject_feedback` (source=github_review) → triggers the `fix_revision` phase: the req_dev task switches to fix_revision, the agent reads the latest feedback, edits the code, and pushes to the same PR branch
- A merged PR → auto `transition req → done`, terminating the task

Requires a local `gh auth login` (autopilot does not manage GitHub tokens).

Example config (`config.yaml`):

```yaml
github:
  cli: gh                      # defaults to 'gh', change for a custom path
  poll_interval_seconds: 300   # default 5 min; minimum 30s
```

Defaults apply when the github section or fields are missing; when `gh auth status` fails, pr-poller logs a warning and skips without affecting other modules.

## Submodule support (P5)

From P5, `req_dev` is git-submodule aware, treating **the parent repo + all submodules as one group** for cross-parent/child development:

- `design` first runs `git submodule update --init --recursive`; the agent prompt lists which submodules this repo contains (editable code paths)
- `develop` writes code on the same-named branch `feat/<title>` across the parent + each submodule; if a submodule has changes → commit inside the submodule, then `git add -A` + commit in the parent repo (automatic SHA bump)
- `code_review` stitches the parent + each submodule diff together for the reviewer agent
- `submit_pr` first pushes + opens **submodule PRs** (one per changed submodule), then pushes + opens the **parent PR**; the parent PR body automatically appends a "linked submodule PRs" list
- `fix_revision` edits code across parent/child based on parent PR review feedback + pushes to the original branch

For scheduling, "parent + submodules" is one scheduling group (at most 1 active task per group), avoiding git conflicts. See the [Requirement Queue guide P5 section](./requirement-queue.md#p5-git-submodule-support) and the [P5 design doc](../superpowers/specs/2026-05-07-submodule-support-design.md).

## Later phases (not in P1)

- **P2**: requirement pool + chat integration (out-of-queue clarification)
- **P3**: scheduler + await_review / fix_revision (per-repo serialization + PR feedback loop)
- **P4**: gh CLI polling listener (automatic PR review awareness)
- **P5**: git submodule support (auto discovery + cross-parent/child commit/PR + group-level scheduling lock)

## Retiring the legacy dev workflow

The legacy `dev` workflow is no longer used from P1 onward. If your `~/.autopilot/workflows/dev/` contains early Python residue (`workflow.py`), you can clean it up:

```bash
rm -rf ~/.autopilot/workflows/dev/
```

Old task history is unaffected (legacy records in the task table are preserved).
