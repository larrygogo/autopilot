# 任务执行可见性 + 产出物收口 设计文档

- 日期：2026-05-14
- 范围：用户操作流 ④ 任务执行 + ⑤ 结束收口
- 方案：MVU（最小可用）—— phase 起止时间 + 产出物卡片
- 依赖：无；与 PR #66 的 /now 通知系统正交

## 一、背景与目标

### 当前痛点

- ④ TaskDetail 只展示 task.status（如 `running_design` / `awaiting_review`）和日志，**看不到各 phase 耗时**、**看不到整体进度**
- ⑤ 任务终态后用户**不知道去哪看结果**：PR 链接散在 requirement 上、改了哪些文件要 cd 到 workspace 跑 `git diff`、下一步动作没明示

### 目标

让用户从任务开始到结束都「看得见、能反应」：

1. **阶段时间线**：TaskDetail 顶部展示 workflow 各 phase 的状态 + 耗时
2. **产出物卡片**：任务终态时展示 PR 链接 + diff 概要 + 耗时分布 + 「看 PR」「重跑」按钮

### 非目标（YAGNI）

- 不做 phase 内子进度上报（"calling LLM / writing file"）
- 不做工作流函数改造（runner 透明加 phase event，phase 函数无感知）
- 不做 task 状态机改造（沿用现有状态命名）

## 二、核心数据：`task_phase_events` 表

### 2.1 表结构

```sql
CREATE TABLE task_phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'running' | 'done' | 'failed' | 'awaiting'
  started_at INTEGER NOT NULL,    -- epoch ms
  ended_at INTEGER,               -- null = 进行中
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_phase_events_task ON task_phase_events (task_id, started_at);
```

迁移 `018-task-phase-events.ts`（最新迁移是 017-kv）。

### 2.2 同 phase 多次重试

允许同 phase 出现多行 event。耗时聚合时**累加所有 done/awaiting/failed event 的 (ended_at - started_at)**——重试时间也算用户在等。

### 2.3 db.ts API

```ts
export function startTaskPhase(taskId: string, phase: string): number;  // 返回 event id
export function endTaskPhase(eventId: number, status: 'done' | 'failed' | 'awaiting'): void;
export function listTaskPhaseEvents(taskId: string): TaskPhaseEvent[];
```

写 SQL 集中在 db.ts，符合 single-writer invariant。

## 三、Runner 集成

在 `src/core/runner.ts` 的 `executePhase` 内：

- transition 到 `running_<phase>` 成功后立刻调 `startTaskPhase(taskId, phase)`，保存 eventId 到本地变量
- phase 函数完成的三个分支：
  - 自动 transition 到 `awaiting_<phase>` → `endTaskPhase(id, 'awaiting')`
  - 自动 transition 到下一 phase → `endTaskPhase(id, 'done')`
  - 抛错 → `endTaskPhase(id, 'failed')`

emit 事件：

```ts
{ type: "task:phase-started", payload: { task_id, phase, event_id, started_at } }
{ type: "task:phase-ended",   payload: { task_id, phase, event_id, ended_at, status, duration_ms } }
```

**phase 函数无感知**——runner 透明加这层。

## 四、HTTP API

### 4.1 GET `/api/tasks/:id/phase-events`

```
→ { events: TaskPhaseEvent[] }
```

按 started_at 升序。

### 4.2 GET `/api/tasks/:id/outcome`

```
非终态 → 404 "task not in terminal state"
终态 → 200 TaskOutcome:

interface TaskOutcome {
  task_id: string;
  status: "done" | "failed" | "cancelled";
  pr_url: string | null;
  pr_number: number | null;
  diff_stat: { files: number; insertions: number; deletions: number } | null;
  total_duration_ms: number;
  top_phases: Array<{ phase: string; duration_ms: number }>;  // top 3
  workspace_path: string | null;
  failure_reason: string | null;  // status=failed 时从 task_logs 拿
}
```

### 4.3 diff_stat 实现

```ts
async function computeDiffStat(workspacePath: string, baseBranch: string): Promise<DiffStat | null> {
  if (!existsSync(workspacePath)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const proc = Bun.spawn(["git", "diff", "--shortstat", `origin/${baseBranch}`], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    clearTimeout(timer);
    if (exit !== 0) return null;
    const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return { files: 0, insertions: 0, deletions: 0 };
    return { files: parseInt(m[1]!, 10), insertions: parseInt(m[2] ?? "0", 10), deletions: parseInt(m[3] ?? "0", 10) };
  } catch {
    clearTimeout(timer);
    return null;
  }
}
```

3s 超时；失败/超时返回 `null`，前端隐藏 diff 行。

### 4.4 base branch 来源

`task → requirement → codebase.default_branch`。

### 4.5 failure_reason 来源

`task_logs` 表里 `to_status='failed'` 的最后一条 note。如 note 也空，返 `null`，UI 显示"任务失败，查看日志"。

## 五、Web 改造

### 5.1 PR-1：`TaskPhaseTimeline` 组件

新建 `src/web/src/components/TaskPhaseTimeline.tsx`，渲染在 TaskDetail 状态 badge 下方、Gate banner 之上。

UI：

```
┌─ 阶段进度 ──────────────────────────────────────┐
│ ● design     18m 24s  ✓ 完成                    │
│ ● review      5m 12s  ⊙ 等待用户决断             │
│ ◌ dev         —       □ 待运行                  │
│ ◌ pr          —       □ 待运行                  │
└─────────────────────────────────────────────────┘
```

- 列出 workflow 全部 phases（按 workflow.yaml 顺序）
- 状态图标：`✓ done` / `⊙ awaiting` / `▶ running` / `✗ failed` / `□ 待运行`
- 同 phase 重试时显示累计耗时 + 角标 `×2`
- 进行中的 phase 用 `setInterval(1000)` 滚动 elapsed

数据来源：新 hook `useTaskPhaseEvents(taskId)`：
- mount 时 fetch
- 订阅 WebSocket `task:phase-started` / `task:phase-ended` 增量更新

### 5.2 PR-2：`TaskOutcomeCard` 组件

新建 `src/web/src/components/TaskOutcomeCard.tsx`，**仅在终态时**在 TaskDetail 顶部渲染（状态 badge 之上）。

UI：

```
┌─ 产出物 ────────────────────────────────────────┐
│  ✓ 已完成 · 总耗时 32m 18s                       │
│                                                  │
│  PR #142   https://github.com/.../pull/142  ↗   │
│                                                  │
│  改动统计                                        │
│    12 files changed · +234 / -56                 │
│                                                  │
│  耗时分布（top 3）                               │
│    design   18m 24s                              │
│    review   10m 02s                              │
│    dev       3m 52s                              │
│                                                  │
│  下一步                                          │
│    [ 看 PR ↗ ]  [ 重跑 ]                          │
└──────────────────────────────────────────────────┘
```

- status icon: `✓ done` / `✗ failed` / `⊘ cancelled`
- failed 时顶部红色 banner 显示 `failure_reason`，无则显示"任务失败，查看日志"
- 字段空（pr_url / diff_stat / top_phases）时该行隐藏
- 「看 PR」: `window.open(pr_url)`，pr_url 为空时按钮 disable
- 「重跑」: 调 `client.startTask({ requirement: req_id, workflow })` 建同 requirement 新 task，跳新 task 详情

### 5.3 不做

- 不做"关闭任务"按钮（/now 上已有 dismiss）
- 不做点击 phase 跳日志（PhaseLogs 已按 phase 切分）
- 不做组件测试（参考 PR #64 / #66 模式）

## 六、测试覆盖

### 6.1 核心

```
tests/task-phase-events.test.ts
  - startTaskPhase 写入 + 返回 id
  - endTaskPhase 更新 ended_at + status
  - 同 phase 多次重试 → 多行
  - listTaskPhaseEvents 按 started_at 排序
```

### 6.2 Runner

```
tests/runner-phase-events.test.ts (新增)
  - executePhase 起点写 phase event
  - 终点 done / awaiting / failed 三分支正确回填
```

### 6.3 HTTP

```
tests/routes-task-phase-events.test.ts
  - GET /api/tasks/:id/phase-events 列表
  - GET /api/tasks/:id/outcome 终态正常
  - 非终态 → 404
  - workspace 不在时 diff_stat=null
  - failure 时 failure_reason 拉自 task_logs
```

### 6.4 Web

不做组件测试，手测 + e2e dogfood。

## 七、边界与失败处理

| 场景 | 处理 |
|---|---|
| daemon 重启时 phase 在跑 | watchdog 检测卡死任务、自动 transition；event 表的 running 行 ended_at 一直为 null。UI 显示"卡住"角标 |
| workspace 被清理 | `diff_stat = null`，UI 隐藏改动行 + 显示 "workspace 已清理" |
| `git diff` 超时 / corrupt | 3s 超时返回 null，不阻塞 outcome |
| task 没关联 requirement | `pr_url = null`，按钮 disable |
| task_phase_events 表为空（旧任务） | total_duration_ms=0，top_phases=[]，UI 显示"无阶段记录" |
| 失败 log note 也空 | UI 显示"任务失败，查看日志"，无具体原因 |
| 重跑 | 建同 requirement 新 task；旧 task 保留 done 状态 |

## 八、PR 拆分

```
PR-1  task_phase_events 表 + 迁移 + db helper + runner 集成 + GET phase-events + Web 时间线   ~半天
PR-2  GET /api/tasks/:id/outcome + diff_stat + Web TaskOutcomeCard + 重跑按钮                  ~半天
```

PR-1 是 PR-2 依赖。

## 九、不做（YAGNI）

- phase 内子进度上报（推后）
- 工作流 phase 函数改造
- 终态后定期重算 diff_stat
- 重跑复用 task_id
- 跨 workflow 耗时比较
- 关闭任务按钮（/now dismiss 已覆盖）
