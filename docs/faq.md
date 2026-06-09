[中文](faq.md) | [English](en/faq.md)

# FAQ 与故障排查

## 安装问题

### Q: `autopilot` 命令找不到

**症状**：`command not found: autopilot` 或 `'autopilot' 不是内部或外部命令`

**解决**：

1. 确认已装依赖：在 repo 根目录跑 `bun install`
2. 从源码运行用 `bun run dev <命令>`（如 `bun run dev task status`）
3. 想全局直接用 `autopilot`：把 `bin/autopilot.ts` 链接进 PATH，或在 repo 根目录 `bun link`

### Q: Bun 未安装 / 版本过低

**症状**：`command not found: bun`，或运行时报 API/语法不支持

**解决**：autopilot 运行时是 Bun。安装或升级后重试：

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

bun --version
```

---

## 初始化问题

### Q: `autopilot init` 后 `~/.autopilot/` 目录为空

**v1.0+ 已修**（dogfood-bug 8 + bug 19）：`init` 现在会自动跑全部数据库迁移 +
从 `examples/workflows/dev` 装一份默认 dev 工作流到 `~/.autopilot/workflows/dev/`。

预期输出含：
- `已初始化数据库：...（应用 N 条迁移）`
- `已装入默认工作流：~/.autopilot/workflows/dev`

若仍看到空目录，确认你跑的是最新版（git pull 后 bun install）。

### Q: 数据库锁定（database is locked）

**症状**：`SqliteError: database is locked`

**原因**：多个进程同时写入 SQLite 数据库。

**解决**：

1. 检查是否有卡死的 autopilot 进程：
   ```bash
   # Linux/macOS
   ps aux | grep autopilot
   # Windows
   Get-Process | Where-Object { $_.ProcessName -like '*bun*' }
   ```
2. 终止卡死进程后重试
3. 如果问题持续，删除锁文件：
   ```bash
   rm -f ~/.autopilot/runtime/locks/*
   ```

---

## 工作流问题

### Q: 自定义工作流不被发现

**症状**：`autopilot workflow list` 中看不到新添加的工作流

**排查**：

1. 确认目录结构正确：
   ```
   ~/.autopilot/workflows/my_workflow/
   ├── workflow.yaml    # 必须存在
   └── workflow.ts      # 必须存在
   ```
2. 确认 `workflow.yaml` 中有 `name` 字段
3. 看具体加载错误：`autopilot workflow show my_workflow` 或 `autopilot doctor`

### Q: 工作流校验报错

**常见原因**：

- **`reject` 目标不存在**：`reject: xxx` 中的 `xxx` 必须是当前阶段之前已定义的阶段名
- **`reject` 目标在后方**：`reject` 只能往回跳，往前跳请使用 `jump_trigger` / `jump_target`
- **`func` 函数找不到**：`workflow.ts` 中必须导出对应函数（默认 `run_{phase_name}`）
- **`name` 字段缺失**：每个 phase 必须有 `name` 字段

### Q: 阶段函数找不到

**症状**：注册或执行时报 `workflow <name> 缺少阶段函数 run_xxx`

**解决**：

1. 确认 `workflow.ts` 导出了对应函数：
   ```typescript
   // 函数名 = run_ + phase name
   export async function run_my_phase(taskId: string): Promise<void> {
     // ...
   }
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
   autopilot task logs <task-id>
   ```
2. **Push 失败**：阶段完成后的 `runInBackground()` 子进程启动失败
3. **锁未释放**：进程异常退出但文件锁未清理

**解决**：

- 等待 Watcher 自动恢复（daemon 内置，默认超时后触发）
- 紧急情况下手动清理锁文件：`rm -f ~/.autopilot/runtime/locks/<task-id>.lock`

### Q: `InvalidTransitionError` 非法状态转换

**症状**：`InvalidTransitionError: Cannot transition from 'xxx' with trigger 'yyy'`

**原因**：在当前状态下，该触发器不合法。

**排查**：

1. 查看当前任务状态：`autopilot task status <task-id>`
2. 查看该工作流的转换表：`autopilot workflow show <name>`
3. 查看完整状态图：参考 [状态机详解](state-machine.md)

### Q: 并行子阶段失败后父任务如何处理？

取决于 `fail_strategy` 配置（并行块在父任务进程内并发跑各子阶段，不建独立子任务）：

- **`cancel_all`**（默认）：任一子阶段失败 → 等其余兄弟各自结束后整组判失败、走失败分支。注意它**不中途取消/打断仍在跑的兄弟**（命名有误导，见 backlog CONC-06），只是全部结束后选失败分支
- **`continue`**：失败后其他子阶段继续运行，全部结束再处理

查看任务状态：

```bash
autopilot task status <task-id>   # 查看某任务
autopilot task status             # 列出所有任务
```

---

## Web UI 问题

### Q: 怎么打开 Web UI

**解决**：Web UI 由 daemon 自身 serve，无需单独安装。先确认 daemon 在跑，再打开浏览器：

```bash
autopilot daemon status     # 确认 daemon 运行中
autopilot dashboard         # 浏览器打开 http://127.0.0.1:6180
```

若提示静态资源缺失（首次从源码运行 / 刚改过前端），先构建 Web UI：

```bash
bun run build:web
```

### Q: Web UI 页面打不开 / 端口冲突

**排查**：

1. 确认 daemon 已启动：`autopilot daemon status` 应显示监听地址（默认 `127.0.0.1:6180`）
2. 确认端口未被占用：
   ```bash
   # Linux/macOS
   lsof -i :6180
   # Windows
   netstat -ano | findstr :6180
   ```
3. 改端口：编辑 `config.yaml` 的 `daemon.port`，然后 `autopilot daemon restart`
4. 如需局域网访问：把 `config.yaml` 的 `daemon.host` 设为 `0.0.0.0` 后重启 daemon

---

## 其他

### Q: 如何查看框架版本？

```bash
autopilot --version
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

# 重新初始化（init 已含迁移 + 装 dev workflow）
autopilot init
```

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [5 分钟快速入门](quickstart.md) | 从安装到跑通第一个 demo |
| [架构总览](architecture.md) | 整体架构、模块职责、数据流 |
| [工作流开发指南](workflow-development.md) | YAML 定义语法、阶段函数编写规范 |
| [状态机详解](state-machine.md) | 状态转换表、驳回机制、完整状态图 |
