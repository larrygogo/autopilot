[中文](../quickstart.md) | [English](quickstart.md)

## What autopilot does

Real development tasks are rarely a single prompt away: you need code written *and* tested, a plan reviewed before execution, a pause when the path forks, and a clean rollback when something breaks. autopilot wraps all the glue between agent calls into a framework: a state machine, human-approval gates, local persistence, and a built-in Web UI — single-process daemon + SQLite, zero external services required.

## What you get after setup

The built-in `dev` workflow fires off a complete pipeline from a single `autopilot start "your feature"`:

```
You: add task-tagging support
  ↓
architect agent reads codebase + writes plan → workspace/00-design/plan.md
  ↓
[Gate: you review the plan in Web UI] ← Approve to continue, Reject loops back with your reason
  ↓
developer agent writes code + runs tests + git commit
  ↓
reviewer agent inspects diff → REVIEW_RESULT: PASS / REJECT
  ↓
gh pr create ← opens a real PR on GitHub
```

Every artifact is archived to the task workspace; the Web UI shows live progress and logs.

---

# Quickstart (10-15 minutes)

> Actual time depends on AI agent response speed and your configuration. Budget 10-15 minutes, not 5.

---

## Step 1: Prerequisites ⚙️

| Dependency | Minimum | Notes |
|-----------|---------|-------|
| **Bun** | 1.0+ | JavaScript runtime. Install at [bun.sh](https://bun.sh) |
| **Git** | any | Version control |
| **AI CLI** (pick one) | logged in | [Claude Code](https://docs.anthropic.com/claude-code) (recommended), [OpenAI Codex](https://github.com/openai/openai-codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli) |

Quick check:

```bash
bun --version        # should print 1.x.x
git --version        # should print git version x.x.x
claude --version     # or: codex --version / gemini --version
```

---

## Step 2: Install 📦

```bash
git clone https://github.com/larrygogo/autopilot
cd autopilot
bun install
bun run build:web   # Build the Web UI (web-dist is a gitignored artifact; without it the panel won't open)
```

Expected output (last lines):

```
bun install v1.x.x
[xxx packages] installed
```

> **Don't skip `bun run build:web`**: the Web UI static assets (`web-dist/`) are not in git and must be built once locally. If you skip it and open the dashboard, you'll see a "Web UI not built" guidance page (the CLI still works).

> **Global command**: after install, `autopilot` is invoked via `bun run`. For a globally available binary, run `bun link`.

---

## Step 3: Initialize Workspace 🗂️

```bash
autopilot init
```

`init` expected output (includes DB migrations + auto-installs the default `dev` workflow):

```
已创建目录：/Users/you/.autopilot/workflows
已创建目录：/Users/you/.autopilot/prompts
已创建目录：/Users/you/.autopilot/runtime
已初始化数据库：/Users/you/.autopilot/runtime/workflow.db（应用 19 条迁移）
已生成配置模板：/Users/you/.autopilot/config.json
已装入默认工作流：/Users/you/.autopilot/workflows/dev
初始化完成。
```

This creates `~/.autopilot/` — your user data directory for config, workflows, and runtime state, fully isolated from the framework source.

After `git pull` for new releases, run `autopilot upgrade` to apply new migrations (no-op when nothing pending), then `bun run build:web` to rebuild the Web UI (the frontend artifact isn't in git; skipping it leaves the panel on a stale bundle).

---

## Step 4: Configure an AI Agent ✨ (most important step)

autopilot relies on AI agents to do the work. You must configure at least one provider.

### Option A: Edit config file (recommended)

Open `~/.autopilot/config.json` and add a `providers` section:

```json
{
  "providers": {
    "anthropic": {
      "default_model": "claude-sonnet-4-6",
      "enabled": true
    }
  }
}
```

> **Credentials**: autopilot does not store API keys. Your installed AI CLI tool (claude-code / codex / gemini-cli) manages authentication. Make sure you've run `claude login` (or equivalent) before starting.

> **Agent config lives in the workflow, not globally**: the global `config.json` only holds cross-workflow infrastructure such as providers. Each phase's agent (provider / model / system_prompt / max_turns / permission_mode) is declared inline in the workflow directory's `workflow.yaml`; a phase that omits `agent:` falls back to the framework's built-in default agent (anthropic / claude-sonnet-4-6). See the [Workflow Development Guide](workflow-development.md).

### Option B: Web UI settings

Start the daemon (Step 5), then open `/settings?tab=providers` in the browser for a graphical configuration form.

---

## Step 5: Start the Daemon 🚀

```bash
autopilot daemon start
```

Expected output:

```
daemon 已启动 (pid=12345)
  查看监听地址与状态：autopilot daemon status
```

Check the status:

```bash
autopilot daemon status
```

Expected output:

```
daemon 运行中 (pid=12345)
  监听: 127.0.0.1:6180
  版本: x.x.x
  运行时间: 5s
  任务统计: 无任务
```

> **Default port**: `6180`. To change it, set `"daemon": { "port": <your-port> }` in `~/.autopilot/config.json` and run `autopilot daemon restart`.

---

## Step 6: Open the Web UI 🌐

```bash
autopilot dashboard
```

Your browser opens `http://127.0.0.1:6180/now` automatically.

The Web UI has four sections:

| Section | Path | Description |
|---------|------|-------------|
| **Now** | `/now` | What needs your attention right now (priority-sorted card stream) |
| **Start** | `/start` | Submit new requirements and start tasks |
| **Library** | `/library` | Browse all tasks and workflows |
| **Settings** | `/settings` | Configure providers and other infrastructure |

---

## Step 7: Submit Your First Requirement 📝

### Option A: Web UI (recommended)

1. Click **Start** (`/start`) in the top nav
2. Fill in the title and description
3. Submit

### Option B: CLI shortcut

```bash
autopilot start "add label-filtering to the task list"
```

Expected output:

```
任务已创建 [id=task-001 workflow=dev status=pending_design]
```

### Option C: Specify a workflow

```bash
autopilot start "refactor user module" --workflow dev
```

List available workflows:

```bash
autopilot workflow list
```

---

## Step 8: Watch the AI Work, Intervene When Needed 👁️

After the task starts, autopilot advances through phases automatically:

1. **design** — architect agent analyzes the codebase and writes a technical plan
2. **review** — ⚠️ **waits for your approval** — a card appears on the `/now` page
3. **develop** — developer agent writes code, runs tests, commits
4. **code_review** — reviewer agent inspects the diff
5. **submit_pr** — runs `gh pr create` automatically

### Tracking progress

**Web UI**: Open `/now` — P0–P3 priority cards tell you what needs attention.

**CLI text view**:

```bash
autopilot now
```

Expected output when there's a pending approval:

```
PRIO  TITLE                        WAIT    ACTIONS
----  ---------------------------  ------  -------
P0    Plan awaiting review: task-001  5min  Approve / Reject
```

**Task details and logs**:

```bash
autopilot task status               # list all tasks
autopilot task status task-001      # inspect one task
autopilot task logs task-001 -f     # follow live logs
```

---

## Quick Reference

```bash
# Daemon lifecycle
autopilot daemon start          # start in background
autopilot daemon stop           # stop
autopilot daemon status         # check status
autopilot daemon restart        # restart (after config changes)

# Project / Codebase / Requirement (pure CLI path, no browser needed)
autopilot project create "<name>" [-d desc]           # create project
autopilot project list                                # list projects
autopilot codebase create <alias> <path> [--github owner/repo]  # register git repo
autopilot codebase list                               # list codebases
autopilot req new --from-prompt "<requirement>" [--no-extract]   # create requirement

# Tasks
autopilot start "<title>"       # quick-create a task
autopilot task start "<title>" --workflow <name>  # specify workflow
autopilot task status           # list all tasks
autopilot task status <id>      # inspect one task
autopilot task logs <id>        # view logs
autopilot task logs <id> -f     # follow live logs
autopilot task cancel <id>      # cancel a task

# Workflows
autopilot workflow list         # list registered workflows
autopilot workflow show <name>  # inspect a workflow

# UI
autopilot now                   # text card stream (CLI version of /now)
autopilot dashboard             # open Web UI in browser
autopilot chat                  # chat with an agent (REPL)

# Maintenance
autopilot init                  # initialize workspace (first time)
autopilot upgrade               # run database migrations (after updates)
```

---

## Next Steps

| Topic | Read |
|-------|------|
| Full workflow definition syntax | [Workflow Development Guide](workflow-development.md) |
| Internal architecture and design decisions | [Architecture Overview](architecture.md) |
| State machine and rejection mechanism | [State Machine Details](state-machine.md) |
| Common issues and troubleshooting | [FAQ](faq.md) |

---

## Troubleshooting

- **`autopilot daemon start` times out**: check if port 6180 is already in use, or use `autopilot daemon run` (foreground mode with live log output)
- **AI agent doesn't respond**: confirm you've logged in with the corresponding CLI, and that `"enabled": true` is set in `~/.autopilot/config.json`
- **Task stuck**: run `autopilot task logs <id>` to see errors; also check [FAQ](faq.md)
