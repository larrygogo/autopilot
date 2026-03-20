[中文](faq.md) | [English](en/faq.md)

# FAQ 与故障排查

## 安装问题

### Q: `autopilot` 命令找不到

**症状**：`command not found: autopilot` 或 `'autopilot' 不是内部或外部命令`

**解决**：

1. 确认已安装：`pip install -e ".[dev]"`
2. 确认 pip scripts 目录在 PATH 中：
   ```bash
   python -m site --user-base
   # 将输出路径下的 bin/（Linux/macOS）或 Scripts/（Windows）加入 PATH
   ```
3. 或直接使用模块方式运行：`python -m core.cli`

### Q: Python 版本不兼容

**症状**：`SyntaxError` 或 `ImportError: cannot import name 'annotations'`

**解决**：autopilot 要求 Python 3.10+。检查版本：

```bash
python --version
```

如果版本低于 3.10，请升级 Python。

---

## 初始化问题

### Q: `autopilot init` 后 `~/.autopilot/` 目录为空

**解决**：`init` 只创建目录结构，不复制示例工作流。手动复制：

```bash
cp -r examples/workflows/* ~/.autopilot/workflows/
```

### Q: 数据库锁定（database is locked）

**症状**：`sqlite3.OperationalError: database is locked`

**原因**：多个进程同时写入 SQLite 数据库。

**解决**：

1. 检查是否有卡死的 autopilot 进程：
   ```bash
   ps aux | grep autopilot
   ```
2. 终止卡死进程后重试
3. 如果问题持续，删除锁文件：
   ```bash
   rm -f ~/.autopilot/runtime/*.lock
   ```

---

## 工作流问题

### Q: 自定义工作流不被发现

**症状**：`autopilot workflows` 中看不到新添加的工作流

**排查**：

1. 确认目录结构正确：
   ```
   ~/.autopilot/workflows/my_workflow/
   ├── workflow.yaml    # 必须存在
   └── workflow.py      # 必须存在
   ```
2. 确认 `workflow.yaml` 中有 `name` 字段
3. 运行校验查看具体错误：`autopilot validate my_workflow`

### Q: 工作流校验报错

**常见原因**：

- **`reject` 目标不存在**：`reject: xxx` 中的 `xxx` 必须是当前阶段之前已定义的阶段名
- **`reject` 目标在后方**：`reject` 只能往回跳，往前跳请使用 `jump_trigger` / `jump_target`
- **`func` 函数找不到**：`workflow.py` 中必须有对应函数（默认 `run_{phase_name}`）
- **`name` 字段缺失**：每个 phase 必须有 `name` 字段

### Q: 阶段函数找不到（AttributeError）

**症状**：`AttributeError: module 'workflow' has no attribute 'run_xxx'`

**解决**：

1. 确认 `workflow.py` 中定义了对应函数：
   ```python
   def run_my_phase(task_id: str) -> None:  # 函数名 = run_ + phase name
       ...
   ```
2. 如果使用了自定义函数名，在 `workflow.yaml` 中声明：
   ```yaml
   - name: my_phase
     func: my_custom_function_name
   ```

---

## 运行时问题

### Q: 任务卡在某个状态不动

**可能原因**：

1. **阶段函数异常退出**：查看日志确认
   ```bash
   autopilot show <task_id> --logs 20
   ```
2. **Push 失败**：阶段完成后的 `run_in_background()` 进程启动失败
3. **锁未释放**：进程异常退出但文件锁未清理

**解决**：

- 等待 Watcher 自动恢复（默认 600s 超时后触发）
- 或手动启动 Watcher 检测：`autopilot watch`
- 紧急情况下手动清理锁文件：`rm -f ~/.autopilot/runtime/<task_id>.lock`

### Q: `InvalidTransitionError` 非法状态转换

**症状**：`InvalidTransitionError: Cannot transition from 'xxx' with trigger 'yyy'`

**原因**：在当前状态下，该触发器不合法。

**排查**：

1. 查看当前任务状态：`autopilot show <task_id>`
2. 查看可用触发器：
   ```python
   from core.state_machine import get_available_triggers
   print(get_available_triggers(task_id))
   ```
3. 查看完整状态图：参考 [状态机详解](state-machine.md)

### Q: 并行子任务失败后父任务如何处理？

取决于 `fail_strategy` 配置：

- **`cancel_all`**（默认）：任一子任务失败 → 取消所有兄弟子任务 → 父任务回退
- **`continue`**：等待其他子任务完成后再处理

查看子任务状态：

```bash
autopilot show <parent_task_id>   # 显示子任务列表
autopilot list --all              # 显示包括子任务在内的所有任务
```

---

## WebUI 问题

### Q: `autopilot webui` 命令不存在

**症状**：`Error: No such command 'webui'`

**解决**：WebUI 是独立插件，需单独安装：

```bash
pip install -e examples/plugins/autopilot-webui
```

安装后重新运行 `autopilot webui`。

### Q: WebUI 页面打不开

**排查**：

1. 确认服务已启动：终端应显示 `Serving on http://127.0.0.1:8080`
2. 确认端口未被占用：
   ```bash
   # Linux/macOS
   lsof -i :8080
   # Windows
   netstat -ano | findstr :8080
   ```
3. 尝试换端口：`autopilot webui --port 9090`
4. 如果需要远程访问：`autopilot webui --host 0.0.0.0`

---

## 其他

### Q: 如何查看框架版本？

```bash
python -c "from core import __version__; print(__version__)"
```

### Q: AUTOPILOT_HOME 可以自定义吗？

可以，通过环境变量覆盖：

```bash
export AUTOPILOT_HOME=/path/to/my/workspace
autopilot init
```

### Q: 如何完全重置环境？

```bash
# 删除用户数据（谨慎操作！）
rm -rf ~/.autopilot/

# 重新初始化
autopilot init
autopilot upgrade
```

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [5 分钟快速入门](quickstart.md) | 从安装到跑通第一个 demo |
| [架构总览](architecture.md) | 整体架构、模块职责、数据流 |
| [工作流开发指南](workflow-development.md) | YAML 定义语法、阶段函数编写规范 |
| [状态机详解](state-machine.md) | 状态转换表、驳回机制、完整状态图 |
| [插件开发指南](plugin-development.md) | 第三方插件开发、扩展点、框架 API |
