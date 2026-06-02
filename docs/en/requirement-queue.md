# Requirement Queue Working Model Guide

The requirement queue is autopilot's new working model that replaces the legacy dev workflow: you propose a requirement to the chat agent → multiple rounds of clarification → the user confirms enqueue → autopilot automatically runs the req_dev workflow (design → review → develop → code review → submit PR).

> **Current status: full closed loop with 4 phases + submodule support 🎉**
> - ✅ P1: repository management + req_dev workflow (first 5 phases)
> - ✅ P2: requirement pool + chat integration
> - ✅ P3: scheduler (strict per-repo serialization) + await_review/fix_revision + manual feedback-triggered re-entry
> - ✅ P4: gh CLI polling listener (auto-inject PR review change requests + auto-detect PR merge)
> - ✅ P5: git submodule support (auto discovery + cross-parent/child commit/PR + parent/child group scheduling lock)

## Flow overview

```
[propose requirement in chat] → drafting → clarifying (multiple rounds) → ready
   ↓ user confirms enqueue
queued → running (req_dev task starts) → submit_pr done
```

Each requirement has a single status line evolving across phases; from P3 it expands with awaiting_review / fix_revision states.

## Prerequisites

1. The repo is registered on the Web UI `/repos` page and passes the health check ([req_dev workflow guide](./req-dev-workflow.md))
2. `gh auth login` is done (used by the submit_pr phase to open PRs)
3. The autopilot daemon is running

## Usage

### Option A: propose via chat (recommended)

Open the Web UI `/chat` and tell the agent something like:

```
I have a new requirement — add an "About" section to the end of the README in the autopilot repo
```

The agent should:
1. Call `list_repos` to see which repos you have
2. Ask which repo to use
3. Call `create_requirement_draft` to create a draft
4. Ask follow-up questions over multiple rounds (acceptance criteria, constraints, reference implementations)
5. Call `update_requirement_spec` to write the complete spec
6. Wait for you to say "OK, enqueue it"
7. Call `mark_requirement_ready` + `enqueue_requirement`
8. Report the newly created task_id and the entry point for PR progress

After `enqueue_requirement` completes, a req_dev task is created immediately (a temporary implementation before the P3 scheduler takes over).

### Option B: operate directly in the Web UI

1. Go to `/requirements` and click "New Requirement"
2. Pick a repo + enter a title → enter the detail page (draft status)
3. Edit spec_md on the detail page (paste / hand-write the complete spec)
4. Click "Mark as clarified" (status → ready)
5. Click "Enqueue for execution" (status → running, triggers the task)
6. Go to `/tasks` to watch the task run

### Option C: REST API (for automation)

```bash
# Create a draft
curl -X POST http://127.0.0.1:6180/api/requirements \
  -H "Content-Type: application/json" \
  -d '{"repo_id":"repo-001","title":"Add README section","spec_md":"detailed requirement..."}'
# → { requirement: { id: "req-001", status: "drafting", ... } }

# Transition to ready (when the draft is complete)
curl -X POST http://127.0.0.1:6180/api/requirements/req-001/transition \
  -H "Content-Type: application/json" -d '{"to":"ready"}'

# Enqueue (creates a req_dev task)
curl -X POST http://127.0.0.1:6180/api/requirements/req-001/enqueue
# → { requirement: {... status: "running" ...}, task_id: "abc123" }

# Check task progress
curl http://127.0.0.1:6180/api/tasks/abc123
```

## Status enumeration

| Status | Meaning |
|------|------|
| `drafting` | Just created, still in multi-round clarification |
| `clarifying` | spec_md has been written but is still being adjusted |
| `ready` | spec_md complete, waiting for the user to enqueue |
| `queued` | Enqueued, waiting for the scheduler to pick it up (a transitional state before P3) |
| `running` | Picked up by the scheduler, task running up to await_review |
| `awaiting_review` | Task reached the await_review phase (only from P3, does not occupy a slot) |
| `fix_revision` | Received review feedback, task entered fixing (only from P3, occupies a slot) |
| `done` | PR merged |
| `cancelled` | Cancelled by the user |
| `failed` | Fallback state after repeated retries still fail |

## Feedback history

The "Feedback History" timeline on the `/requirements/:id` detail page shows all manually injected feedback.

From P3, when a PR review receives a change request, github_review-type feedback is auto-injected, triggering the fix_revision phase; in P2 it is only recorded, not triggered.

## P3 workflow: per-repo serialization + PR feedback loop

The scheduler (`src/daemon/requirement-scheduler.ts`) subscribes to the `requirement:status-changed` event-bus event and follows spec §6 rules:
- **Each repo has at most 1 "occupied slot"** (running ∨ fix_revision)
- **`awaiting_review` does not occupy a slot** (once the task reaches the await_review phase it can immediately be released to the next queued requirement)
- enqueue only sets status=queued; the scheduler responds to the event to create a req_dev task

When PR feedback arrives:
1. The `inject_feedback` REST / chat tool records feedback into `requirement_feedbacks`
2. If the requirement is in `awaiting_review`, setStatus → `fix_revision`
3. The `run_await_review` phase function loops, detects the status change, and emits the jump trigger `revision_request`
4. The state machine jumps to the `fix_revision` phase; the `run_fix_revision` phase function reads the latest feedback + runs edits on the original PR branch + pushes
5. Once done it emits `fix_done` to jump back to `await_review`, waiting for the next round of feedback or merge

## Current limitations / known boundaries

- ✅ Strict per-repo serialization (guaranteed by the scheduler)
- ✅ PR review change requests auto-inject feedback to trigger fix_revision
- ✅ PR merge auto-transitions req → done
- ✅ git submodule parent/child coordination (see the next section)
- ⚠️ **gh CLI must be logged in locally via `gh auth login`**: when not logged in, pr-poller logs a warning and skips without affecting other modules
- ⚠️ **Polling interval defaults to 5 min**: tunable via `config.yaml.github.poll_interval_seconds`; minimum 30s to protect the GitHub API rate limit
- ⚠️ **External requirement sources like GitHub Issues / Jira**: out of scope for this working model, left for future extension (see spec §15)

## P5: git submodule support

If your project uses git submodules (typical: parent is frontend + submodule is backend / shared lib), autopilot treats the parent + all submodules as **one group**, running the entire req_dev flow seamlessly across parent and children.

### Auto discovery

After registering the parent repo and clicking "Health Check", autopilot will:
1. Scan the parent repo root's `.gitmodules`
2. Register each submodule (only `github.com` remotes) as a `repos` row (`parent_repo_id` pointing to the parent)
3. Default the alias to the submodule name, adding a `-2 / -3` suffix on conflicts
4. Take `default_branch` preferentially from the `branch` field in `.gitmodules`, defaulting to `main` (repos using `master` such as subhgit-rs need a manual alias / branch edit after registration)

Submodules whose physical path does not exist / whose URL is not GitHub are skipped + a warning is given in the health response.

To re-scan (the user added submodules later), click the "Rediscover submodules" button on the parent repo row in `/repos` (`POST /api/repos/:id/rediscover-submodules`).

### List display

`/repos` lists only **parent repos** by default (`listRepos()` filters `parent_repo_id IS NULL` by default). Click the expand button at the far left of a parent repo row to see the list of its submodules (path / alias / default branch / GitHub).

The chat tool `list_repos` likewise lists only parent repos — only parents can be selected when proposing a requirement. Calling `create_requirement_draft` with a submodule alias is rejected with a hint to use the parent alias.

### Proposing requirements across parent/child

Propose normally via chat (or create at `/requirements`); the requirement is associated with the parent repo. In the req_dev workflow:

1. **design**: `git submodule update --init --recursive` pulls submodules; the agent prompt lists which submodules this repo contains and each submodule's GitHub owner/repo, so the agent knows the editable code paths
2. **develop**: parent + each submodule switch to the `feat/<title>` branch; the agent writes code anywhere in parent / child; scan each submodule, and if it has changes → commit inside the submodule, finally `git add -A` in the parent repo (automatically including the submodule SHA bump) + commit
3. **code_review**: stitch the parent diff + each submodule diff for the reviewer agent
4. **submit_pr**: first push + open **submodule PRs** (one per changed submodule) → then push + open the **parent PR**; the parent PR body automatically appends a "linked submodule PRs" list; submodule PR info is stored in the new table `requirement_sub_prs` (one requirement maps to N sub-PRs)
5. **fix_revision**: based on review feedback on the parent PR, the agent switches back to the original branch, edits across parent/child + pushes to the original branch (no new PR)

### Scheduling policy: group-level lock

The parent + all submodules **share one scheduling lock as a group**:

- If any repo in the group has a requirement in `running` or `fix_revision` → the whole group occupies the slot, and new requirements must queue
- candidates are pulled only from the **parent repo** (the chat flow also ensures only parents can be selected)
- Different groups do not block each other

This avoids git conflicts when "cross-parent/child tasks concurrently edit submodules".

### Web UI associations

- `/repos`: expand a parent repo row to see submodules; click "Rediscover submodules" (GitBranch icon) to trigger a sync
- `/requirements/:id`: the "Linked submodule PRs" list below the Meta card (each entry links out to GitHub)

### Supported scope (P5)

- ✅ One level of submodules (nested submodules not supported)
- ✅ `github.com` remotes
- ✅ Submodule default branch differing from the parent (child uses master, parent uses main)
- ❌ Auto-polling submodule PR reviews (pr-poller only watches the parent PR; users review/merge sub-PRs on GitHub themselves)
- ❌ pnpm/yarn workspace sub-package association (multiple packages in one repo already work, no special handling needed)
- ❌ Non-GitHub submodules such as GitLab / Bitbucket

## Future extensions (out of 4-phase + P5 scope)

The full 4 phases + P5 submodule support are implemented. Possible future extensions (see spec §15):

- External requirement source connectors (GitHub Issues / Feishu tasks / Jira)
- Requirement templates / types (feat / fix / chore)
- Queue priority + drag-to-reorder
- Cross-requirement dependencies ("req-002 waits for req-001 to finish")
- PR webhooks instead of polling (better real-time, but needs a public-facing daemon)
- Multi-user collaboration (requirement ownership / review assignment)

## Related docs

- [req_dev workflow guide](./req-dev-workflow.md)
- [Requirement Queue design doc](../superpowers/specs/2026-05-06-requirement-queue-design.md)
- [git submodule support design doc (P5)](../superpowers/specs/2026-05-07-submodule-support-design.md)
- [P1 implementation plan](../superpowers/plans/2026-05-06-requirement-queue-phase1.md)
- [P2 implementation plan](../superpowers/plans/2026-05-06-requirement-queue-phase2.md)
- [P5.1–5.3 implementation plans](../superpowers/plans/)
