[中文](../faq.md) | [English](faq.md)

# FAQ & Troubleshooting

## Installation Issues

### Q: `autopilot` command not found

**Symptoms**: `command not found: autopilot` or `'autopilot' is not recognized`

**Solution**:

1. Confirm dependencies are installed: run `bun install` in the repo root
2. Run from source with `bun run dev <command>` (e.g. `bun run dev task status`)
3. To use `autopilot` globally: link `bin/autopilot.ts` into your PATH, or run `bun link` in the repo root

### Q: Bun not installed / version too old

**Symptoms**: `command not found: bun`, or unsupported API/syntax errors at runtime

**Solution**: autopilot's runtime is Bun. Install or upgrade, then retry:

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

bun --version
```

---

## Initialization Issues

### Q: `~/.autopilot/` is empty after `autopilot init`

**Fixed in v1.0+** (dogfood-bug 8 + bug 19): `init` now auto-runs all database
migrations and installs the default `dev` workflow from `examples/workflows/dev`
into `~/.autopilot/workflows/dev/`.

Expected output includes:
- `已初始化数据库：...（应用 N 条迁移）` (DB initialized with N migrations applied)
- `已装入默认工作流：~/.autopilot/workflows/dev` (default workflow installed)

If you still see an empty directory, confirm you're running the latest build
(`git pull && bun install`).

### Q: Database is locked

**Symptoms**: `SqliteError: database is locked`

**Cause**: Multiple processes writing to SQLite simultaneously.

**Solution**:

1. Check for stalled autopilot processes:
   ```bash
   # Linux/macOS
   ps aux | grep autopilot
   # Windows
   Get-Process | Where-Object { $_.ProcessName -like '*bun*' }
   ```
2. Kill stalled processes and retry
3. If the issue persists, remove lock files:
   ```bash
   rm -f ~/.autopilot/runtime/locks/*
   ```

---

## Workflow Issues

### Q: Custom workflow not discovered

**Symptoms**: `autopilot workflow list` doesn't show the newly added workflow

**Troubleshooting**:

1. Verify the directory structure:
   ```
   ~/.autopilot/workflows/my_workflow/
   ├── workflow.yaml    # Must exist
   └── workflow.ts      # Must exist
   ```
2. Confirm `workflow.yaml` has a `name` field
3. Check the specific load error: `autopilot workflow show my_workflow` or `autopilot doctor`

### Q: Workflow validation errors

**Common causes**:

- **`reject` target doesn't exist**: The target in `reject: xxx` must be a phase defined before the current one
- **`reject` target is after current phase**: `reject` only allows backward jumps; use `jump_trigger` / `jump_target` for forward jumps
- **`func` function not found**: `workflow.ts` must export the corresponding function (default: `run_{phase_name}`)
- **Missing `name` field**: Every phase must have a `name` field

### Q: Phase function not found

**Symptoms**: `workflow <name> is missing phase function run_xxx` at registration or execution

**Solution**:

1. Ensure the function is exported from `workflow.ts`:
   ```typescript
   // function name = run_ + phase name
   export async function run_my_phase(taskId: string): Promise<void> {
     // ...
   }
   ```
2. If using a custom function name, declare it in `workflow.yaml`:
   ```yaml
   - name: my_phase
     func: my_custom_function_name
   ```

---

## Runtime Issues

### Q: Task stuck in a state

**Possible causes**:

1. **Phase function crashed**: Check the logs
   ```bash
   autopilot task logs <task-id>
   ```
2. **Push failed**: The `runInBackground()` subprocess after phase completion failed to start
3. **Lock not released**: Process crashed without cleaning up the file lock

**Solution**:

- Wait for Watcher to auto-recover (built into the daemon, triggers after the default timeout)
- In emergencies, manually remove lock files: `rm -f ~/.autopilot/runtime/locks/<task-id>.lock`

### Q: `InvalidTransitionError`

**Symptoms**: `InvalidTransitionError: Cannot transition from 'xxx' with trigger 'yyy'`

**Cause**: The trigger is not valid for the current state.

**Troubleshooting**:

1. Check current task status: `autopilot task status <task-id>`
2. View the workflow's transition table: `autopilot workflow show <name>`
3. See the full state diagram: refer to [State Machine Details](state-machine.md)

### Q: How is the parent task handled when a parallel subtask fails?

Depends on the `fail_strategy` configuration:

- **`cancel_all`** (default): any subtask failure → cancel all sibling subtasks → parent task rolls back
- **`continue`**: wait for other subtasks to complete before handling

Check task (including subtask) status:

```bash
autopilot task status <parent-task-id>   # parent task and its subtasks
autopilot task status                     # list all tasks
```

---

## Web UI Issues

### Q: How do I open the Web UI

**Solution**: The Web UI is served by the daemon itself, no separate install needed. Confirm the daemon is running, then open the browser:

```bash
autopilot daemon status     # Confirm the daemon is running
autopilot dashboard         # Opens http://127.0.0.1:6180 in the browser
```

If static assets are reported missing (first run from source / just changed the frontend), build the Web UI first:

```bash
bun run build:web
```

### Q: Web UI page won't load / port conflict

**Troubleshooting**:

1. Confirm the daemon is running: `autopilot daemon status` should show the listen address (default `127.0.0.1:6180`)
2. Check if the port is in use:
   ```bash
   # Linux/macOS
   lsof -i :6180
   # Windows
   netstat -ano | findstr :6180
   ```
3. Change the port: edit `daemon.port` in `config.yaml`, then `autopilot daemon restart`
4. For LAN access: set `daemon.host` in `config.yaml` to `0.0.0.0`, then restart the daemon

---

## Other

### Q: How to check the framework version?

```bash
autopilot --version
```

### Q: Can AUTOPILOT_HOME be customized?

Yes, override via environment variable:

```bash
export AUTOPILOT_HOME=/path/to/my/workspace
autopilot init
```

### Q: How to completely reset the environment?

```bash
# Delete user data (use with caution!)
rm -rf ~/.autopilot/

# Re-initialize (init now includes migrations + default dev workflow)
autopilot init
```

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [5-Minute Quickstart](quickstart.md) | From installation to running your first demo |
| [Architecture Overview](architecture.md) | Overall architecture, module responsibilities, data flow |
| [Workflow Development Guide](workflow-development.md) | YAML syntax, phase function guidelines |
| [State Machine Details](state-machine.md) | Transition tables, rejection mechanism, state diagrams |
