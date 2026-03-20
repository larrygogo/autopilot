[中文](../faq.md) | [English](faq.md)

# FAQ & Troubleshooting

## Installation Issues

### Q: `autopilot` command not found

**Symptoms**: `command not found: autopilot` or `'autopilot' is not recognized`

**Solution**:

1. Confirm installation: `pip install -e ".[dev]"`
2. Ensure the pip scripts directory is in your PATH:
   ```bash
   python -m site --user-base
   # Add the bin/ (Linux/macOS) or Scripts/ (Windows) subdirectory to PATH
   ```
3. Or run directly as a module: `python -m core.cli`

### Q: Python version incompatible

**Symptoms**: `SyntaxError` or `ImportError: cannot import name 'annotations'`

**Solution**: autopilot requires Python 3.10+. Check your version:

```bash
python --version
```

If below 3.10, upgrade Python.

---

## Initialization Issues

### Q: `~/.autopilot/` is empty after `autopilot init`

**Solution**: `init` only creates the directory structure; it does not copy example workflows. Copy them manually:

```bash
cp -r examples/workflows/* ~/.autopilot/workflows/
```

### Q: Database is locked

**Symptoms**: `sqlite3.OperationalError: database is locked`

**Cause**: Multiple processes writing to SQLite simultaneously.

**Solution**:

1. Check for stalled autopilot processes:
   ```bash
   ps aux | grep autopilot
   ```
2. Kill stalled processes and retry
3. If the issue persists, remove lock files:
   ```bash
   rm -f ~/.autopilot/runtime/*.lock
   ```

---

## Workflow Issues

### Q: Custom workflow not discovered

**Symptoms**: `autopilot workflows` doesn't show the newly added workflow

**Troubleshooting**:

1. Verify the directory structure:
   ```
   ~/.autopilot/workflows/my_workflow/
   ├── workflow.yaml    # Must exist
   └── workflow.py      # Must exist
   ```
2. Confirm `workflow.yaml` has a `name` field
3. Run validation for specific errors: `autopilot validate my_workflow`

### Q: Workflow validation errors

**Common causes**:

- **`reject` target doesn't exist**: The target in `reject: xxx` must be a phase defined before the current one
- **`reject` target is after current phase**: `reject` only allows backward jumps; use `jump_trigger` / `jump_target` for forward jumps
- **`func` function not found**: `workflow.py` must contain the corresponding function (default: `run_{phase_name}`)
- **Missing `name` field**: Every phase must have a `name` field

### Q: Phase function not found (AttributeError)

**Symptoms**: `AttributeError: module 'workflow' has no attribute 'run_xxx'`

**Solution**:

1. Ensure the function is defined in `workflow.py`:
   ```python
   def run_my_phase(task_id: str) -> None:  # function name = run_ + phase name
       ...
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
   autopilot show <task_id> --logs 20
   ```
2. **Push failed**: The `run_in_background()` process after phase completion failed to start
3. **Lock not released**: Process crashed without cleaning up the file lock

**Solution**:

- Wait for Watcher to auto-recover (triggers after default 600s timeout)
- Or manually trigger Watcher: `autopilot watch`
- In emergencies, manually remove lock files: `rm -f ~/.autopilot/runtime/<task_id>.lock`

### Q: `InvalidTransitionError`

**Symptoms**: `InvalidTransitionError: Cannot transition from 'xxx' with trigger 'yyy'`

**Cause**: The trigger is not valid for the current state.

**Troubleshooting**:

1. Check current task status: `autopilot show <task_id>`
2. View available triggers:
   ```python
   from core.state_machine import get_available_triggers
   print(get_available_triggers(task_id))
   ```
3. See the full state diagram: refer to [State Machine Details](state-machine.md)

### Q: How is the parent task handled when a parallel subtask fails?

Depends on the `fail_strategy` configuration:

- **`cancel_all`** (default): any subtask failure → cancel all sibling subtasks → parent task rolls back
- **`continue`**: wait for other subtasks to complete before handling

Check subtask status:

```bash
autopilot show <parent_task_id>   # Shows subtask list
autopilot list --all              # Shows all tasks including subtasks
```

---

## WebUI Issues

### Q: `autopilot webui` command doesn't exist

**Symptoms**: `Error: No such command 'webui'`

**Solution**: WebUI is a separate plugin that needs to be installed:

```bash
pip install -e examples/plugins/autopilot-webui
```

Then run `autopilot webui` again.

### Q: WebUI page won't load

**Troubleshooting**:

1. Confirm the server is running: terminal should show `Serving on http://127.0.0.1:8080`
2. Check if the port is in use:
   ```bash
   # Linux/macOS
   lsof -i :8080
   # Windows
   netstat -ano | findstr :8080
   ```
3. Try a different port: `autopilot webui --port 9090`
4. For remote access: `autopilot webui --host 0.0.0.0`

---

## Other

### Q: How to check the framework version?

```bash
python -c "from core import __version__; print(__version__)"
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

# Re-initialize
autopilot init
autopilot upgrade
```

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [5-Minute Quickstart](quickstart.md) | From installation to running your first demo |
| [Architecture Overview](architecture.md) | Overall architecture, module responsibilities, data flow |
| [Workflow Development Guide](workflow-development.md) | YAML syntax, phase function guidelines |
| [State Machine Details](state-machine.md) | Transition tables, rejection mechanism, state diagrams |
| [Plugin Development Guide](plugin-development.md) | Third-party plugins, extension points, framework API |
