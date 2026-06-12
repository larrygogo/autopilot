# Remove Schedules Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 autopilot 中完整移除定时任务（schedules / cron）功能，包括后端逻辑、RPC 接口、Web UI 入口、相关测试，以及数据库表。

**Architecture:** 分三个阶段执行：① 后端删除（核心模块 + 事件类型 + RPC 方法）；② 前端清理（路由/导航/API client）；③ 测试文件删除 + 验收。每步完成后立即运行 typecheck，确保不引入回归。

**Tech Stack:** TypeScript / Bun、SQLite (bun:sqlite)、React + Vite、WS-RPC 协议

---

## 文件变更总览

### 删除文件（6 个）
| 文件 | 原因 |
|------|------|
| `src/core/schedules.ts` | Schedule CRUD + cron 解析逻辑 |
| `src/core/scheduler.ts` | `runScheduledTasks()` cron 触发器 |
| `src/web/src/pages/Schedules.tsx` | Web UI 定时任务列表页 |
| `tests/rpc-scheduler-config.test.ts` | RPC 相关测试 |
| `tests/scheduler-config.test.ts` | 调度配置测试 |
| `tests/scheduler-send-prompt.test.ts` | send-prompt 模式测试 |

### 新建文件（1 个）
| 文件 | 原因 |
|------|------|
| `src/migrations/035-drop-schedules.ts` | 执行 `DROP TABLE IF EXISTS schedules` + 清理索引 |

### 修改文件（11 个）
| 文件 | 改动要点 |
|------|---------|
| `src/core/events.ts` | 移除 `Schedule` import + 4 个 `schedule:*` 事件类型 |
| `src/core/task-delete.ts` | 移除 `clearScheduleTaskRefs` 导入与调用 |
| `src/daemon/index.ts` | 移除 `schedulerTimer`、`schedulerRunning`、`runScheduledTasks` 导入 + `SCHEDULER_INTERVAL_MS` 常量 |
| `src/daemon/rpc-methods.ts` | 移除 8 个 schedules 相关导入项 + 第八批 6 个 `schedules.*` RPC 方法 |
| `src/daemon/protocol.ts` | 移除 `case "schedule"` 频道路由分支 |
| `src/client/http.ts` | 移除 `Schedule / ScheduleType` 类型导入 + 6 个 schedules 方法 |
| `src/web/src/App.tsx` | 移除 `CalendarClock` 导入、`Schedules` 懒加载、`/schedules` 路由、`SchedulesRoute` 组件、导航菜单项、`titleForPath` 中的 `/schedules` 分支 |
| `src/web/src/hooks/useApi.ts` | 移除 `/api/schedules` 正则、`Schedule` 接口、6 个 schedule API 方法 |
| `src/web/src/pages/Settings.tsx` | 更新常规偏好描述文字（删掉「新建定时任务」措辞）；更新配置文件提示文字（删掉「定时任务 Tab」） |
| `src/web/src/components/CommandPalette.tsx` | 移除 `pages` 数组中 `/schedules` 条目；若 `Clock` icon 不再被使用则从 import 删除 |
| `tests/single-writer-invariant.test.ts` | 从 `ALLOWLIST` 移除 `src/core/schedules.ts` 条目 |

### 保留不动（重要）
- `src/daemon/requirement-scheduler.ts` — 需求执行调度器，与 cron 无关
- `src/migrations/002-schedules.ts` / `022-schedules-send-prompt.ts` / `026-requirement-schedule-error.ts` — 历史迁移记录，大量测试仍在引用 002
- `src/web/src/pages/Settings.tsx` 中的 `SchedulerCard`（`scheduler.get/scheduler.save` RPC 对应的最大并发任务数设置）— 属于需求调度器配置，不是 cron

---

## Task 1：新建迁移文件 035-drop-schedules.ts

**Files:**
- Create: `src/migrations/035-drop-schedules.ts`

- [ ] **Step 1: 创建迁移文件**

```typescript
import type { Database } from "bun:sqlite";

/**
 * 移除 schedules 表及其索引。
 * 002-schedules / 022-schedules-send-prompt / 026-requirement-schedule-error
 * 等历史迁移文件保留不动，仅作历史记录。
 */
export function up(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_schedules_enabled_next;
    DROP INDEX IF EXISTS idx_schedules_workflow;
    DROP INDEX IF EXISTS idx_schedules_target_task;
    DROP TABLE IF EXISTS schedules;
  `);
}
```

- [ ] **Step 2: 验证文件存在**

```bash
ls src/migrations/035-drop-schedules.ts
```
Expected: 文件存在，无报错

- [ ] **Step 3: Commit**

```bash
git add src/migrations/035-drop-schedules.ts
git commit -m "feat(migration): 新增 035 迁移，DROP schedules 表及相关索引"
```

---

## Task 2：删除核心后端文件（schedules.ts、scheduler.ts）

**Files:**
- Delete: `src/core/schedules.ts`
- Delete: `src/core/scheduler.ts`

> ⚠️ 这一步会导致所有引用这两个文件的模块产生 TS 编译错误。后续 Task 3~7 会逐步消除这些错误。**不要在此 Task 之后运行 typecheck，而是在 Task 7 完成后一次性验证。**

- [ ] **Step 1: 删除两个文件**

```bash
rm src/core/schedules.ts
rm src/core/scheduler.ts
```

- [ ] **Step 2: Commit**

```bash
git add -u src/core/schedules.ts src/core/scheduler.ts
git commit -m "feat: 删除 cron 调度核心模块 schedules.ts 和 scheduler.ts"
```

---

## Task 3：修改 src/core/events.ts — 移除 Schedule 事件类型

**Files:**
- Modify: `src/core/events.ts`

- [ ] **Step 1: 移除 Schedule import 和 4 个事件类型**

在文件中找到并删除以下内容：

```typescript
// 删除这一行 import
import type { Schedule } from "./schedules";
```

找到 `AutopilotEvent` 联合类型，删除以下 4 行：
```typescript
  | { type: "schedule:created"; payload: { schedule: Schedule } }
  | { type: "schedule:updated"; payload: { schedule: Schedule } }
  | { type: "schedule:deleted"; payload: { scheduleId: string } }
  | { type: "schedule:fired"; payload: { schedule: Schedule; taskId: string } }
```

- [ ] **Step 2: Commit**

```bash
git add src/core/events.ts
git commit -m "feat: 从 AutopilotEvent 移除 schedule:* 事件类型"
```

---

## Task 4：修改 src/core/task-delete.ts — 移除 clearScheduleTaskRefs

**Files:**
- Modify: `src/core/task-delete.ts`

- [ ] **Step 1: 移除 import 行**

删除：
```typescript
import { clearScheduleTaskRefs } from "./schedules";
```

- [ ] **Step 2: 移除 purgeTaskTree 函数中的调用**

在 `purgeTaskTree` 函数中，找到并删除：
```typescript
  clearScheduleTaskRefs(ids);
```
（此行位于 `deleteTaskRecords(ids)` 调用的上方）

- [ ] **Step 3: 更新 purgeTaskTree 的 JSDoc 注释**

找到 JSDoc 中的描述：
```typescript
 * schedules.last_task_id 置 NULL。
```
删除包含该描述的整行注释（通常是 `@param emitRootId` 后或内部注释中提到 schedules 的那行）。

- [ ] **Step 4: Commit**

```bash
git add src/core/task-delete.ts
git commit -m "feat: task-delete 移除 clearScheduleTaskRefs 引用"
```

---

## Task 5：修改 src/daemon/protocol.ts — 移除 schedule 频道路由

**Files:**
- Modify: `src/daemon/protocol.ts`

- [ ] **Step 1: 删除 case "schedule" 分支**

在 `getChannelsForEvent()` 函数的 switch 语句中，找到并删除以下整个 case 块：
```typescript
    case "schedule": {
      channels.push("schedule:*");
      break;
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/daemon/protocol.ts
git commit -m "feat: protocol.ts 移除 schedule:* 频道路由"
```

---

## Task 6：修改 src/daemon/index.ts — 移除 schedulerTimer

**Files:**
- Modify: `src/daemon/index.ts`

- [ ] **Step 1: 移除 import**

删除：
```typescript
import { runScheduledTasks } from "../core/scheduler";
```

- [ ] **Step 2: 移除常量**

删除：
```typescript
const SCHEDULER_INTERVAL_MS = 30_000;    // 每 30 秒扫一次定时任务（精度到分钟）
```

- [ ] **Step 3: 移除 schedulerTimer 的创建逻辑**

找到并删除以下代码块（约 10 行）：
```typescript
  // scheduler 定时器：扫描到期的 schedule，创建对应任务。
  // 重入守卫（CONC-04）：单 tick 可能涉及 agent 抽取耗时数秒，无守卫时重叠的两个 tick 会在
  // 任一 markScheduleFired 之前各自命中同一 due schedule 双触发。
  let schedulerRunning = false;
  const schedulerTimer = setInterval(() => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    runScheduledTasks()
      .catch((e: unknown) => {
        console.error("scheduler 异常：", e instanceof Error ? e.message : String(e));
      })
      .finally(() => { schedulerRunning = false; });
  }, SCHEDULER_INTERVAL_MS);
```

- [ ] **Step 4: 移除 shutdown 函数中的 clearInterval**

在 `shutdown` 函数中，找到并删除：
```typescript
    clearInterval(schedulerTimer);
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat: daemon/index.ts 移除 cron schedulerTimer 及其重入守卫"
```

---

## Task 7：修改 src/daemon/rpc-methods.ts — 移除 schedules.* RPC 方法

**Files:**
- Modify: `src/daemon/rpc-methods.ts`

- [ ] **Step 1: 移除 schedules 相关 import 语句**

找到以下 import 块并完整删除（共 9 个具名导入 + 1 个类型导入）：
```typescript
import {
  listSchedules as coreListSchedules,
  getSchedule as coreGetSchedule,
  createSchedule as coreCreateSchedule,
  updateSchedule as coreUpdateSchedule,
  deleteSchedule as coreDeleteSchedule,
  markScheduleFired,
  systemTimezone,
  isValidTimezone,
  type ScheduleType,
} from "../core/schedules";
```

- [ ] **Step 2: 移除 schedules.* RPC 方法注册块**

找到注释 `// ── 第八批：schedules.* 域（6 个） ──` 直到下一个批次注释（`// ── 第九批：sandbox + defaults + setup mutation（8 个） ──`）之前的全部内容，删除这个区块（6 个 `registerRpcMethod` 调用，约 120 行）：

```typescript
  // ── 第八批：schedules.* 域（6 个） ──

  registerRpcMethod({
    method: "schedules.list",
    ...
  });
  // ... schedules.get, schedules.create, schedules.update, schedules.delete, schedules.runNow
```

- [ ] **Step 3: 验证 typecheck 通过**

```bash
bun run typecheck
```
Expected: 0 errors（此时所有后端改动都已完成）

- [ ] **Step 4: Commit**

```bash
git add src/daemon/rpc-methods.ts
git commit -m "feat: rpc-methods.ts 移除 schedules.* 6 个 RPC 方法及相关导入"
```

---

## Task 8：修改 src/client/http.ts — 移除客户端 schedule 方法

**Files:**
- Modify: `src/client/http.ts`

- [ ] **Step 1: 移除类型导入**

找到并删除：
```typescript
import type { Schedule, ScheduleType } from "../core/schedules";
```

- [ ] **Step 2: 移除 Schedules 区块中的 6 个方法**

找到 `// ── Schedules ──` 注释，删除该注释及其下方的 6 个方法（`listSchedules`, `getSchedule`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `runScheduleNow`），直至 `// ── Projects ──` 注释（不删除 Projects 区块）。

- [ ] **Step 3: 验证 typecheck 通过**

```bash
bun run typecheck
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/client/http.ts
git commit -m "feat: client/http.ts 移除 schedule 方法及类型导入"
```

---

## Task 9：删除 Web UI 页面 + 修改 App.tsx

**Files:**
- Delete: `src/web/src/pages/Schedules.tsx`
- Modify: `src/web/src/App.tsx`

- [ ] **Step 1: 删除 Schedules 页面文件**

```bash
rm src/web/src/pages/Schedules.tsx
```

- [ ] **Step 2: 修改 App.tsx — 移除 CalendarClock import**

从 lucide-react 导入中删除 `CalendarClock`：
```typescript
// 删除这一行：
  CalendarClock,
```

- [ ] **Step 3: 修改 App.tsx — 移除 Schedules 懒加载**

删除：
```typescript
const Schedules = lazy(() => import("./pages/Schedules").then((m) => ({ default: m.Schedules })));
```

- [ ] **Step 4: 修改 App.tsx — 移除 SchedulesRoute 组件**

删除以下完整组件定义（约 8 行）：
```typescript
function SchedulesRoute({
  subscribe,
}: {
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}) {
  const navigate = useNavigate();
  return <Schedules subscribe={subscribe} onSelectTask={(id) => navigate(`/tasks/${id}`)} />;
}
```

- [ ] **Step 5: 修改 App.tsx — 移除 /schedules 路由**

在 `<Routes>` 中找到并删除：
```typescript
                <Route path="/schedules" element={<SchedulesRoute subscribe={subscribe} />} />
```

- [ ] **Step 6: 修改 App.tsx — 移除导航菜单项**

在 `NAV_GROUPS` 定义中，找到「编排」分组，删除其中的 schedules 条目，使该分组只剩工作流：
```typescript
  {
    title: "编排",
    items: [
      { path: "/workflows", label: "工作流", icon: GitBranch },
      { path: "/schedules", label: "定时任务", icon: CalendarClock },  // ← 删除此行
    ],
  },
```

- [ ] **Step 7: 修改 App.tsx — 移除 titleForPath 中的 /schedules 分支**

找到并删除：
```typescript
  if (pathname.startsWith("/schedules")) return "定时任务";
```

- [ ] **Step 8: Commit**

```bash
git add src/web/src/pages/Schedules.tsx src/web/src/App.tsx
git commit -m "feat: Web UI 移除 /schedules 路由、导航项及 Schedules 页面"
```

---

## Task 10：修改 src/web/src/hooks/useApi.ts — 移除 schedule API

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1: 移除 /api/schedules 正则模式**

在文件头部的 allowedPatterns 数组（或类似的正则白名单）中，找到并删除：
```typescript
  /^\/api\/schedules(\?.*)?$/,
```

- [ ] **Step 2: 移除 Schedule 接口定义**

找到并删除完整接口：
```typescript
export interface Schedule {
  id: string;
  name: string;
  type: "once" | "cron";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  workflow: string;
  title: string;
  requirement: string | null;
  enabled: 0 | 1;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: 移除 6 个 schedule API 方法**

找到注释 `// Schedules` 块，删除从该注释开始直到下一个 API 区块之前的所有内容：
```typescript
  // Schedules
  // [WS-RPC] schedules.list
  listSchedules: () => requestRpc<Schedule[]>("schedules.list"),
  // [WS-RPC] schedules.get
  getSchedule: (id: string) => requestRpc<Schedule>("schedules.get", { id }),
  // [WS-RPC] schedules.create
  createSchedule: (body: { ... }) => requestRpc<Schedule>("schedules.create", body),
  // [WS-RPC] schedules.update
  updateSchedule: (id: string, body: Record<string, unknown>) =>
    requestRpc<Schedule>("schedules.update", { id, ...body }),
  // [WS-RPC] schedules.delete
  deleteSchedule: (id: string) =>
    requestRpc<{ ok: true }>("schedules.delete", { id }),
  // [WS-RPC] schedules.runNow
  runScheduleNow: (id: string) =>
    requestRpc<{ ok: true; taskId: string }>("schedules.runNow", { id }),
```

- [ ] **Step 4: Commit**

```bash
git add src/web/src/hooks/useApi.ts
git commit -m "feat: useApi.ts 移除 Schedule 类型及 6 个 schedules API 方法"
```

---

## Task 11：修改 src/web/src/pages/Settings.tsx — 清理描述文字

**Files:**
- Modify: `src/web/src/pages/Settings.tsx`

> **注意**：`SchedulerCard` 是关于「最大并发任务数」的需求调度器配置，与 cron 无关，**不删除**。只修改两处措辞。

- [ ] **Step 1: 更新常规偏好卡片描述文字**

找到（第 81-83 行附近）：
```typescript
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            影响新建定时任务时的默认值；已创建的任务不受影响。
          </p>
```

替换为：
```typescript
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            全局时区默认值，影响工作流触发时的时间基准。
          </p>
```

- [ ] **Step 2: 更新配置文件提示文字**

找到（第 143-146 行附近）：
```typescript
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            日常配置请用上方的提供商 / 智能体 / 工作流 / 定时任务 Tab；
            原始 YAML 请用 IDE 直接编辑文件，daemon 即时读到改动（providers / agents 无需重启）。
          </p>
```

替换为：
```typescript
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            日常配置请用上方的提供商 / 智能体 / 工作流 Tab；
            原始 YAML 请用 IDE 直接编辑文件，daemon 即时读到改动（providers / agents 无需重启）。
          </p>
```

- [ ] **Step 3: Commit**

```bash
git add src/web/src/pages/Settings.tsx
git commit -m "feat: Settings.tsx 清理残留的定时任务措辞"
```

---

## Task 12：修改 src/web/src/components/CommandPalette.tsx — 移除导航条目

**Files:**
- Modify: `src/web/src/components/CommandPalette.tsx`

- [ ] **Step 1: 移除 pages 数组中的 schedules 条目**

找到 `pages` 数组（在 `useMemo` 内），删除：
```typescript
      { path: "/schedules", label: "定时任务", icon: Clock },
```

- [ ] **Step 2: 检查 Clock icon 是否还被使用**

在文件中搜索 `Clock`，如果删除该条目后 `Clock` 不再有任何其他用途，则从 import 中删除：
```typescript
// 从 import 中删除 Clock（如未被其他地方使用）
import { MessageSquare, Workflow, Plug, Sliders, Moon, Sun, Plus, FileText, Clock, Folder, MessageCircle, XCircle, RotateCw } from "lucide-react";
// 改为：
import { MessageSquare, Workflow, Plug, Sliders, Moon, Sun, Plus, FileText, Folder, MessageCircle, XCircle, RotateCw } from "lucide-react";
```

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/CommandPalette.tsx
git commit -m "feat: CommandPalette.tsx 移除定时任务导航条目"
```

---

## Task 13：修改 tests/single-writer-invariant.test.ts — 清理 ALLOWLIST

**Files:**
- Modify: `tests/single-writer-invariant.test.ts`

- [ ] **Step 1: 从 ALLOWLIST 移除 schedules.ts 条目**

找到并删除：
```typescript
  "src/core/schedules.ts",       // schedules 表：SQLite 即权威源，无 manifest 同步需求
```

- [ ] **Step 2: Commit**

```bash
git add tests/single-writer-invariant.test.ts
git commit -m "chore: single-writer-invariant ALLOWLIST 移除已删除的 schedules.ts"
```

---

## Task 14：删除测试文件

**Files:**
- Delete: `tests/rpc-scheduler-config.test.ts`
- Delete: `tests/scheduler-config.test.ts`
- Delete: `tests/scheduler-send-prompt.test.ts`

- [ ] **Step 1: 删除三个测试文件**

```bash
rm tests/rpc-scheduler-config.test.ts
rm tests/scheduler-config.test.ts
rm tests/scheduler-send-prompt.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add -u tests/rpc-scheduler-config.test.ts tests/scheduler-config.test.ts tests/scheduler-send-prompt.test.ts
git commit -m "feat: 删除 cron schedule 相关测试文件（共 3 个）"
```

---

## Task 15：验收测试

**Files:** 无（只运行验证命令）

- [ ] **Step 1: TypeScript 类型检查**

```bash
bun run typecheck
```
Expected: 无任何 error（0 errors, 0 warnings）

- [ ] **Step 2: 运行全量测试**

```bash
bun test
```
Expected: 全部通过，特别确认以下测试仍绿：
- `tests/requirement-scheduler.test.ts`
- `tests/requirement-scheduler-global.test.ts`
- `tests/single-writer-invariant.test.ts`

- [ ] **Step 3: 检查 Web UI 构建**

```bash
bun run build:web
```
Expected: 构建成功，无 TypeScript / Vite 编译报错

- [ ] **Step 4: 冒烟测试（可选，如有运行环境）**

```bash
autopilot daemon run &
# 访问 http://127.0.0.1:6180
# 验证：导航栏无「定时任务」入口
# 验证：访问 /schedules 被 catch-all 重定向到 /now
# 验证：Ctrl+K 命令面板无「定时任务」选项
# 按 Ctrl+C 停止 daemon
```

- [ ] **Step 5: 验证迁移**

```bash
autopilot upgrade
# 或
bun run dev upgrade
```
Expected: 执行 migration 035，输出类似 `[035] 执行完毕`，之后 DB 中无 schedules 表

---

## 风险与注意事项

### ⚠️ 保留项容易误删

| 保留 | 原因 |
|------|------|
| `src/daemon/requirement-scheduler.ts` | 需求执行调度器，与 cron 完全无关 |
| `src/web/src/pages/Settings.tsx` 中的 `SchedulerCard` | 使用 `scheduler.get/scheduler.save` RPC 配置最大并发任务数 |
| `src/core/config.ts` 中的 `loadSchedulerConfig/saveSchedulerConfig` | 被 `scheduler.get/scheduler.save` RPC 使用，属于需求调度器配置 |
| 所有 `tests/requirement-scheduler*.test.ts` | 测试需求调度器，与 cron 无关 |
| `migration 002/022/026` 历史文件 | 大量测试通过 `import { up as m002 }` 引用，删除会导致数十个测试报错 |

### ⚠️ 测试文件引用 migration 002

大量测试文件通过 `import { up as m002 } from "../src/migrations/002-schedules"` 引用历史迁移文件。这些测试本身不测试 schedule 功能，只是用 002 迁移来建立完整的内存数据库 schema。**不需要修改这些测试文件**，因为 002 迁移文件本身是保留的。

### ⚠️ useApi.ts 中的 schedule_error 字段

`Requirement` 接口中有 `schedule_error: string | null` 字段（来自 migration 026）。该字段被 **requirement-scheduler.ts**（需求调度器）使用，与 cron schedule 无关，**不删除**。

---

## 完整依赖图

```
schedules.ts  ←──── 删除
  ↑ 被引用
  ├── src/core/events.ts        → 修改：移除事件类型
  ├── src/core/task-delete.ts   → 修改：移除 clearScheduleTaskRefs
  ├── src/daemon/rpc-methods.ts → 修改：移除 8 个 import + 6 个 RPC
  ├── src/client/http.ts        → 修改：移除 6 个方法 + 2 个类型
  └── src/core/scheduler.ts     ←── 删除

scheduler.ts  ←──── 删除
  ↑ 被引用
  └── src/daemon/index.ts       → 修改：移除 schedulerTimer

Web 层：
  src/web/src/pages/Schedules.tsx           ←── 删除
  src/web/src/App.tsx                        → 修改（路由/导航）
  src/web/src/hooks/useApi.ts                → 修改（API 方法 + 类型）
  src/web/src/pages/Settings.tsx             → 修改（措辞）
  src/web/src/components/CommandPalette.tsx  → 修改（导航条目）

协议层：
  src/daemon/protocol.ts  → 修改（移除 schedule:* 频道路由）
```
