# 项目页需求列表流水线化 + 执行界面 GA 化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目详情页需求列表复刻流水线页（4 段 tab + 时间分组 + RowCard）；TaskDetail 执行界面改为 GitHub Actions job 形态（左 phase 导航 + 右折叠日志 section 流）。

**Architecture:** 改造 A 把 Tasks.tsx 内的卡片/分组逻辑抽到共享组件 `PipelineList.tsx` + 两个纯函数 lib；改造 B 新增 `TaskRunView`（容器）+ `RunPhaseNav`（左导航/窄容器横条）+ `RunPhaseSection`（单 phase 折叠日志）三组件 + 纯逻辑 lib `run-view-logic.ts`，替换 TaskDetail 中的 PhasePipeline/TaskPhaseTimeline/三个日志 tab。纯函数全部 TDD（bun:test，无 DOM）；UI 组件靠 typecheck + build:web + 手动 dogfood 验证（项目无 DOM 测试基建）。

**Tech Stack:** React 18 + Vite + Tailwind v4（容器查询 `@container`）+ shadcn/ui + bun:test。

**Spec:** `docs/superpowers/specs/2026-06-10-project-pipeline-list-and-ga-task-view-design.md`

**验证命令**（每个 task 末尾都跑）：`bun test <新测试>` / `bun run typecheck` / 最终 `bun run build:web`

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/web/src/lib/pipeline-time.ts` | Create | relTime / tsToMs / bucketOf / TimeBucket 常量（从 Tasks.tsx 平移） |
| `src/web/src/lib/requirement-buckets.ts` | Create | 项目页需求 → tab 分桶纯函数 |
| `src/web/src/components/PipelineList.tsx` | Create | TONE / taskMeta / reqMeta / RowCard / TimeGroupedList / RequirementRow / TaskRow（从 Tasks.tsx 平移+补全） |
| `src/web/src/pages/Tasks.tsx` | Modify | 删平移走的代码，改 import |
| `src/web/src/pages/ProjectDetail.tsx` | Modify | 需求 section 重写为 tab+分组+卡片 |
| `src/web/src/lib/run-view-logic.ts` | Create | 展开 override 状态机 / 追尾阈值 / log phase 解析 / 轮数 / fmtDuration |
| `src/web/src/components/RunPhaseSection.tsx` | Create | 单 phase 折叠 section（懒加载日志 + 追尾 + 过滤） |
| `src/web/src/components/RunPhaseNav.tsx` | Create | 左侧导航（宽）+ 横向 chip 条（窄），phaseVisual 同源 |
| `src/web/src/components/TaskRunView.tsx` | Create | GA 双栏容器：flatten phases、WS 分发、工具栏、transitions section |
| `src/web/src/pages/TaskDetail.tsx` | Modify | 删旧三件套接入 TaskRunView，重排布局 |
| `src/web/src/components/TaskPhaseTimeline.tsx` | Delete | 仅 TaskDetail 引用（grep 确认后删） |
| `src/web/src/components/PhaseLogsViewer.tsx` | Delete | 仅 TaskDetail 引用（LEVEL 逻辑移入 run-view-logic） |
| `tests/web-pipeline-time.test.ts` 等 3 个 | Create | 纯函数单测 |

注意：`PhasePipeline.tsx` 组件文件**不删**（工作流编辑器等处还在用），只是 TaskDetail 不再引用。

---

### Task 1: 时间分组纯函数 lib（TDD）

**Files:**
- Create: `src/web/src/lib/pipeline-time.ts`
- Test: `tests/web-pipeline-time.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/web-pipeline-time.test.ts
import { describe, it, expect } from "bun:test";
import { relTime, tsToMs, bucketOf, BUCKET_ORDER, BUCKET_LABEL } from "../src/web/src/lib/pipeline-time";

const NOW = new Date("2026-06-10T15:00:00+08:00").getTime();

describe("tsToMs", () => {
  it("ISO 字符串转 ms", () => {
    expect(tsToMs("2026-06-10T10:00:00.000Z")).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
  });
  it("秒级 epoch 自动 ×1000", () => {
    expect(tsToMs(1_780_000_000)).toBe(1_780_000_000_000);
  });
  it("ms 级 epoch 原样", () => {
    expect(tsToMs(1_780_000_000_000)).toBe(1_780_000_000_000);
  });
  it("null/undefined/非法 → 0", () => {
    expect(tsToMs(null)).toBe(0);
    expect(tsToMs(undefined)).toBe(0);
    expect(tsToMs("not-a-date")).toBe(0);
  });
});

describe("bucketOf", () => {
  it("今天零点之后 → today", () => {
    const t = new Date(NOW); t.setHours(1, 0, 0, 0);
    expect(bucketOf(t.getTime(), NOW)).toBe("today");
  });
  it("昨天 → yesterday", () => {
    expect(bucketOf(NOW - 86_400_000, NOW)).toBe("yesterday");
  });
  it("6 天前 → week，7 天前 → month", () => {
    const startToday = new Date(NOW); startToday.setHours(0, 0, 0, 0);
    expect(bucketOf(startToday.getTime() - 6 * 86_400_000 + 1, NOW)).toBe("week");
    expect(bucketOf(startToday.getTime() - 7 * 86_400_000, NOW)).toBe("month");
  });
  it("30 天前 → earlier", () => {
    const startToday = new Date(NOW); startToday.setHours(0, 0, 0, 0);
    expect(bucketOf(startToday.getTime() - 30 * 86_400_000, NOW)).toBe("earlier");
  });
});

describe("relTime", () => {
  it("1 分钟内 → 刚刚", () => expect(relTime(NOW - 30_000, NOW)).toBe("刚刚"));
  it("分钟 / 小时 / 天", () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5分钟前");
    expect(relTime(NOW - 3 * 3600_000, NOW)).toBe("3小时前");
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe("2天前");
  });
});

describe("常量", () => {
  it("BUCKET_ORDER 覆盖 5 桶且 LABEL 齐全", () => {
    expect(BUCKET_ORDER).toEqual(["today", "yesterday", "week", "month", "earlier"]);
    for (const b of BUCKET_ORDER) expect(BUCKET_LABEL[b]).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-pipeline-time.test.ts`
Expected: FAIL — Cannot find module `../src/web/src/lib/pipeline-time`

- [ ] **Step 3: 实现（从 Tasks.tsx L65-105 平移，逻辑零改动）**

```ts
// src/web/src/lib/pipeline-time.ts
// 流水线列表的时间工具：相对时间 + 时段分桶。从 Tasks.tsx 抽出供项目页复用。

export type TimeBucket = "today" | "yesterday" | "week" | "month" | "earlier";
export const BUCKET_ORDER: TimeBucket[] = ["today", "yesterday", "week", "month", "earlier"];
export const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: "今天", yesterday: "昨天", week: "一周内", month: "一月内", earlier: "更早",
};

/** 相对时间（中文）：刚刚 / N分钟前 / N小时前 / N天前 / N周前 / N个月前 */
export function relTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}天前`;
  const w = Math.floor(day / 7);
  if (w < 5) return `${w}周前`;
  return `${Math.floor(day / 30)}个月前`;
}

/** 归一化到 ms：需求的 ts 是数字 epoch，任务的是 ISO 字符串；秒级时间戳自动 *1000 */
export function tsToMs(ts: string | number | null | undefined): number {
  if (ts == null) return 0;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export function bucketOf(ms: number, now: number): TimeBucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startToday = start.getTime();
  const DAY = 86_400_000;
  if (ms >= startToday) return "today";
  if (ms >= startToday - DAY) return "yesterday";
  if (ms >= startToday - 6 * DAY) return "week";
  if (ms >= startToday - 29 * DAY) return "month";
  return "earlier";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-pipeline-time.test.ts`
Expected: PASS（全绿）

- [ ] **Step 5: Commit**

```bash
git add src/web/src/lib/pipeline-time.ts tests/web-pipeline-time.test.ts
git commit -m "refactor(web): 抽取流水线时间分组纯函数到 lib/pipeline-time"
```

---

### Task 2: 项目页需求 tab 分桶纯函数（TDD）

**Files:**
- Create: `src/web/src/lib/requirement-buckets.ts`
- Test: `tests/web-requirement-buckets.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/web-requirement-buckets.test.ts
import { describe, it, expect } from "bun:test";
import { projectReqTab, type ProjectReqTab } from "../src/web/src/lib/requirement-buckets";

describe("projectReqTab（spec 的 tab 分桶表）", () => {
  const cases: Array<[string, ProjectReqTab]> = [
    ["drafting", "human"],
    ["clarifying", "human"],
    ["ready", "human"],
    ["awaiting_approval", "human"],
    ["awaiting_review", "human"],
    ["failed", "human"],
    ["queued", "running"],
    ["running", "running"],
    ["fix_revision", "running"],
    ["done", "archived"],
    ["cancelled", "archived"],
  ];
  for (const [status, tab] of cases) {
    it(`${status} → ${tab}`, () => expect(projectReqTab(status)).toBe(tab));
  }
  it("未知状态兜底 human（球在你这，宁可误报不漏报）", () => {
    expect(projectReqTab("investigating")).toBe("human");
    expect(projectReqTab("whatever_new")).toBe("human");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-requirement-buckets.test.ts`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

```ts
// src/web/src/lib/requirement-buckets.ts
// 项目详情页需求列表的 4 段 tab 分桶。
// 与流水线页不同：项目页没有 task 行，需求自己代表全生命周期，
// 所以 running/awaiting_review 等后段状态也要进桶（不能 task_id 去重跳过）。

export type ProjectReqTab = "human" | "running" | "archived";

export function projectReqTab(status: string): ProjectReqTab {
  if (status === "queued" || status === "running" || status === "fix_revision") return "running";
  if (status === "done" || status === "cancelled") return "archived";
  // drafting / clarifying / ready / awaiting_approval / awaiting_review / failed
  // 及任何未知新状态 → 等待人工（宁可误报不漏报）
  return "human";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-requirement-buckets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/src/lib/requirement-buckets.ts tests/web-requirement-buckets.test.ts
git commit -m "feat(web): 项目页需求 tab 分桶纯函数"
```

---

### Task 3: 抽取 PipelineList 共享组件 + Tasks.tsx 瘦身

**Files:**
- Create: `src/web/src/components/PipelineList.tsx`
- Modify: `src/web/src/pages/Tasks.tsx`

- [ ] **Step 1: 创建 PipelineList.tsx（平移 Tasks.tsx 的 TONE/meta/卡片/分组，reqMeta 补全后段状态）**

```tsx
// src/web/src/components/PipelineList.tsx
// 流水线风列表的共享件：状态色调、行卡片、时间分组容器。
// Tasks 页（需求+任务混合）与 ProjectDetail 页（纯需求）共用。
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, Search, Clock, FileText, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import type { Requirement } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { relTime, tsToMs, bucketOf, BUCKET_ORDER, BUCKET_LABEL, type TimeBucket } from "@/lib/pipeline-time";

export interface PipelineTask {
  id: string;
  title: string;
  workflow: string;
  status: string;
  requirement_id?: string | null;
  requirement?: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  pr_url?: string | null;
  dangling?: boolean;
}

// 卡片状态色调：头像图标色 + 状态点 bg
export const TONE = {
  accent: { text: "text-accent", dot: "bg-accent" },
  warning: { text: "text-warning", dot: "bg-warning" },
  destructive: { text: "text-destructive", dot: "bg-destructive" },
  success: { text: "text-success", dot: "bg-success" },
  info: { text: "text-info", dot: "bg-info" },
  muted: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
} as const;
export type Tone = keyof typeof TONE;

export function taskMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string } {
  if (status.startsWith("running_")) return { Icon: Loader2, tone: "accent", label: "运行中" };
  if (status.startsWith("awaiting_")) return { Icon: Hand, tone: "warning", label: "等待人工" };
  if (status === "failed" || status.startsWith("failed_")) return { Icon: AlertCircle, tone: "destructive", label: "失败" };
  if (status.startsWith("pending_")) return { Icon: Clock, tone: "muted", label: "待执行" };
  if (status === "done") return { Icon: CheckCircle2, tone: "success", label: "已完成" };
  return { Icon: XCircle, tone: "muted", label: "已取消" };
}

/** 需求状态 → 卡片视觉。覆盖全生命周期（项目页的需求没有任务行代表后段）。 */
export function reqMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string; spin?: boolean } {
  if (status === "queued") return { Icon: Clock, tone: "accent", label: "待执行" };
  if (status === "running") return { Icon: Loader2, tone: "accent", label: "执行中", spin: true };
  if (status === "fix_revision") return { Icon: Loader2, tone: "accent", label: "修复中", spin: true };
  if (status === "awaiting_review") return { Icon: Hand, tone: "warning", label: "待 PR review" };
  if (status === "awaiting_approval") return { Icon: Hand, tone: "warning", label: "待审批" };
  if (status === "ready") return { Icon: Hand, tone: "warning", label: "待入队" };
  if (status === "clarifying") return { Icon: Search, tone: "info", label: "调查中" };
  if (status === "drafting") return { Icon: FileText, tone: "muted", label: "草稿" };
  if (status === "done") return { Icon: CheckCircle2, tone: "success", label: "已完成" };
  if (status === "failed") return { Icon: AlertCircle, tone: "destructive", label: "失败" };
  if (status === "cancelled") return { Icon: XCircle, tone: "muted", label: "已取消" };
  return { Icon: FileText, tone: "muted", label: status };
}

export interface TimedRow { key: string; ts: number; node: ReactNode; }

/** 把行列表分桶渲染（带时段小标题）。入参应已按时间倒序。 */
export function TimeGroupedList({ rows, now }: { rows: TimedRow[]; now: number }) {
  const byBucket = new Map<TimeBucket, TimedRow[]>();
  for (const r of rows) {
    const b = bucketOf(r.ts, now);
    const arr = byBucket.get(b);
    if (arr) arr.push(r);
    else byBucket.set(b, [r]);
  }
  const sections = BUCKET_ORDER.filter((b) => byBucket.has(b));
  return (
    <div className="space-y-4">
      {sections.map((b) => {
        const items = byBucket.get(b)!;
        return (
          <div key={b}>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {BUCKET_LABEL[b]}
              <span className="font-mono text-[10px] text-muted-foreground/60">{items.length}</span>
            </p>
            <ul className="space-y-2">
              {items.map((r) => <li key={r.key}>{r.node}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Claude Code 风卡片外壳：头像图标 + 标题 + 相对时间 + 状态行 + 可选预览 */
export function RowCard({
  to, Icon, tone, spin, title, time, statusLabel, secondary, preview,
}: {
  to: string;
  Icon: typeof Loader2;
  tone: Tone;
  spin?: boolean;
  title: string;
  time: string;
  statusLabel: string;
  secondary?: string;
  preview?: string | null;
}) {
  const t = TONE[tone];
  return (
    <Link
      to={to}
      className="block rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:border-accent"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className={cn("h-[18px] w-[18px]", t.text, spin && "animate-spin")} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-snug">{title}</p>
            <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">{time}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} />
            <span className={cn("shrink-0 font-medium", t.text)}>{statusLabel}</span>
            {secondary && <span className="truncate font-mono text-[11px]">· {secondary}</span>}
          </div>
          {preview && (
            <div className="mt-2.5 rounded-lg bg-muted/50 px-3 py-2">
              <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{preview}</p>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export function RequirementRow({ req, now }: { req: Requirement; now: number }) {
  const { Icon, tone, label, spin } = reqMeta(req.status);
  const secondary = [req.id, req.task_id ? `${req.task_id} →` : null].filter(Boolean).join(" · ");
  return (
    <RowCard
      to={`/requirements/${req.id}`}
      Icon={Icon}
      tone={tone}
      spin={spin}
      title={req.title}
      time={relTime(tsToMs(req.updated_at), now)}
      statusLabel={label}
      secondary={secondary}
    />
  );
}

export function TaskRow({ task, now }: { task: PipelineTask; now: number }) {
  const { Icon, tone, label } = taskMeta(task.status);
  const phase = parsePhase(task.status);
  const secondary = [
    task.workflow,
    phase || null,
    task.requirement_id ? `← ${task.requirement_id}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <RowCard
      to={`/tasks/${task.id}`}
      Icon={Icon}
      tone={tone}
      spin={task.status.startsWith("running_")}
      title={task.title}
      time={relTime(tsToMs(task.updated_at), now)}
      statusLabel={label}
      secondary={secondary}
      preview={task.requirement ?? null}
    />
  );
}

export function parsePhase(status: string): string | null {
  const m = status.match(/^(?:running|pending|awaiting|failed)_(.+)$/);
  return m ? m[1] : null;
}
```

- [ ] **Step 2: Tasks.tsx 瘦身**

删除 Tasks.tsx 中：L12-24（Task interface）、L37-137（TONE→TimeGroupedList 全部）、L407-496（RowCard→parsePhase 全部）。
顶部 import 改为：

```tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, Search, X, List, Archive } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHero } from "@/components/PageHero";
import { cn } from "@/lib/utils";
import { tsToMs } from "@/lib/pipeline-time";
import {
  TimeGroupedList, RequirementRow, TaskRow,
  type PipelineTask, type TimedRow,
} from "@/components/PipelineList";
```

文件内所有 `Task` 类型引用改 `PipelineTask`（`useState<PipelineTask[]>`、`tlist as PipelineTask[]`、`PipelineTab.tasks: PipelineTask[]`、`rowsOf` 内）。其余逻辑（tabs/分桶/搜索/渲染）不动。

- [ ] **Step 3: 验证**

Run: `bun run typecheck && bun test`
Expected: typecheck 0 错误，全量测试通过

- [ ] **Step 4: Commit**

```bash
git add src/web/src/components/PipelineList.tsx src/web/src/pages/Tasks.tsx
git commit -m "refactor(web): 流水线卡片/分组抽为 PipelineList 共享组件"
```

---

### Task 4: ProjectDetail 需求 section 重写

**Files:**
- Modify: `src/web/src/pages/ProjectDetail.tsx`（L545-608 的需求 section + 顶部 import/state）

- [ ] **Step 1: 加 import 与 state**

import 区追加：

```tsx
import { List, Archive, Loader2, Hand } from "lucide-react";   // 并入现有 lucide import 行
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TimeGroupedList, RequirementRow, type TimedRow } from "@/components/PipelineList";
import { tsToMs } from "@/lib/pipeline-time";
import { projectReqTab, type ProjectReqTab } from "@/lib/requirement-buckets";
```

`ProjectDetail` 组件内（state 区）追加：

```tsx
const [reqTab, setReqTab] = useState<string>("all");
```

组件内（refresh 之后）追加分桶 memo：

```tsx
const reqBuckets = useMemo(() => {
  const buckets: Record<ProjectReqTab, Requirement[]> = { human: [], running: [], archived: [] };
  for (const r of requirements) buckets[projectReqTab(r.status)].push(r);
  return buckets;
}, [requirements]);

const now = Date.now();
const rowsOf = (list: Requirement[]): TimedRow[] =>
  list
    .map((r) => ({ key: r.id, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} /> }))
    .sort((a, b) => b.ts - a.ts);
```

（注意 `useMemo` 需在 react import 中存在——ProjectDetail 现只 import useCallback/useEffect/useState，补 useMemo。）

- [ ] **Step 2: 重写需求 section 的非空分支（L582-607 的 `<Card>` divide-y 列表）**

空态分支（`requirements.length === 0`）**原样保留**（不渲染 tab）。非空分支替换为：

```tsx
<Tabs value={reqTab} onValueChange={setReqTab}>
  <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden">
    <TabsTrigger value="all" className="gap-1.5">
      <List className="h-3.5 w-3.5 text-foreground/70" />
      全部
      <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{requirements.length}</span>
    </TabsTrigger>
    <TabsTrigger value="human" className="gap-1.5">
      <Hand className="h-3.5 w-3.5 text-warning" />
      等待人工
      <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.human.length}</span>
    </TabsTrigger>
    <TabsTrigger value="running" className="gap-1.5">
      <Loader2 className="h-3.5 w-3.5 text-accent" />
      运行中
      <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.running.length}</span>
    </TabsTrigger>
    <TabsTrigger value="archived" className="gap-1.5">
      <Archive className="h-3.5 w-3.5 text-muted-foreground" />
      归档
      <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.archived.length}</span>
    </TabsTrigger>
  </TabsList>

  <TabsContent value="all">
    <TimeGroupedList rows={rowsOf(requirements)} now={now} />
  </TabsContent>
  {([
    ["human", reqBuckets.human, "没有等你处理的需求"],
    ["running", reqBuckets.running, "没有正在推进的需求"],
    ["archived", reqBuckets.archived, "还没有归档的需求"],
  ] as Array<[string, Requirement[], string]>).map(([key, list, empty]) => (
    <TabsContent key={key} value={key}>
      {list.length > 0 ? (
        <TimeGroupedList rows={rowsOf(list)} now={now} />
      ) : (
        <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">{empty}</p>
      )}
    </TabsContent>
  ))}
</Tabs>
```

旧的 `STATUS_LABEL` / `STATUS_VARIANT` 常量若 grep 后无其他引用则删除（Badge/ExternalLink import 同理清理）。

- [ ] **Step 3: 验证 + 构建**

Run: `bun run typecheck && bun run build:web`
Expected: 0 错误，构建成功

- [ ] **Step 4: Commit**

```bash
git add src/web/src/pages/ProjectDetail.tsx
git commit -m "feat(web): 项目页需求列表改为流水线形态（4 段 tab + 时间分组 + 卡片）"
```

---

### Task 5: run-view 纯逻辑 lib（TDD）

**Files:**
- Create: `src/web/src/lib/run-view-logic.ts`
- Test: `tests/web-run-view-logic.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/web-run-view-logic.test.ts
import { describe, it, expect } from "bun:test";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  shouldFollow, resolveLogPhase, phaseRounds, fmtDuration,
  LEVEL_RE, extractLevel,
  type ExpandState, type PhaseRunState,
} from "../src/web/src/lib/run-view-logic";

const S = (statuses: Record<string, PhaseRunState>, prev?: ExpandState) =>
  applyStatusTransitions(prev ?? createExpandState(), statuses);

describe("展开状态机（spec B5）", () => {
  it("pending→running 跃迁自动展开", () => {
    let st = S({ dev: "pending" });
    expect(isExpanded(st, "dev")).toBe(false);
    st = S({ dev: "running" }, st);
    expect(isExpanded(st, "dev")).toBe(true);
  });
  it("手动收起 running 后当前周期不再自动展开", () => {
    let st = S({ dev: "running" });
    st = toggleManual(st, "dev");          // 收起
    expect(isExpanded(st, "dev")).toBe(false);
    st = S({ dev: "running" }, st);        // 同状态重复 apply（轮询）
    expect(isExpanded(st, "dev")).toBe(false);
  });
  it("状态跃迁清除 override；→failed 强制展开覆盖手动收起", () => {
    let st = S({ dev: "running" });
    st = toggleManual(st, "dev");          // 用户收起
    st = S({ dev: "failed" }, st);         // 跃迁 failed
    expect(isExpanded(st, "dev")).toBe(true);
  });
  it("→awaiting 自动展开", () => {
    let st = S({ review: "running" });
    st = S({ review: "awaiting" }, st);
    expect(isExpanded(st, "review")).toBe(true);
  });
  it("手动展开 done section 不被自动逻辑收起", () => {
    let st = S({ design: "done", dev: "pending" });
    st = toggleManual(st, "design");       // 展开
    st = S({ design: "done", dev: "running" }, st);
    expect(isExpanded(st, "design")).toBe(true);
    expect(isExpanded(st, "dev")).toBe(true);  // 多展开共存
  });
});

describe("shouldFollow（追尾阈值 24px）", () => {
  it("贴底跟随，超 24px 暂停", () => {
    expect(shouldFollow(976, 1000, 0)).toBe(true);   // 距底 24
    expect(shouldFollow(975, 1000, 0)).toBe(false);  // 距底 25
    expect(shouldFollow(176, 1000, 800)).toBe(true); // clientHeight 参与
  });
});

describe("resolveLogPhase（log:entry 的 tag 可能是 label）", () => {
  const names = new Set(["design", "develop"]);
  const labelToName = { "设计": "design", "开发": "develop" };
  it("tag 即 phase name 直接命中", () => {
    expect(resolveLogPhase("design", labelToName, names)).toBe("design");
  });
  it("tag 是 label 时映射回 name", () => {
    expect(resolveLogPhase("设计", labelToName, names)).toBe("design");
  });
  it("无法解析 → null（不错挂）", () => {
    expect(resolveLogPhase("SYSTEM", labelToName, names)).toBe(null);
    expect(resolveLogPhase(undefined, labelToName, names)).toBe(null);
  });
});

describe("phaseRounds（驳回重跑轮数）", () => {
  it("同 phase 多条 events = 轮数", () => {
    const events = [{ phase: "design" }, { phase: "review" }, { phase: "design" }];
    expect(phaseRounds(events, "design")).toBe(2);
    expect(phaseRounds(events, "review")).toBe(1);
    expect(phaseRounds(events, "develop")).toBe(0);
  });
});

describe("fmtDuration", () => {
  it("秒 / 分秒 / 时分", () => {
    expect(fmtDuration(48_000)).toBe("48s");
    expect(fmtDuration(124_000)).toBe("2m04s");
    expect(fmtDuration(3_780_000)).toBe("1h03m");
  });
});

describe("extractLevel（从 PhaseLogsViewer 平移）", () => {
  it("解析方括号 level", () => {
    expect(extractLevel("2026-06-10 10:00:00 [INFO] [设计] hi")).toBe("INFO");
    expect(extractLevel("plain line")).toBe(null);
    expect(LEVEL_RE.test(" [ERROR] ")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-run-view-logic.test.ts`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

```ts
// src/web/src/lib/run-view-logic.ts
// TaskRunView（GA 式执行视图）的纯逻辑：折叠展开状态机 / 追尾滚动阈值 /
// log:entry phase 归属解析 / 重跑轮数 / 耗时格式化 / 日志 level 解析。

export type PhaseRunState = "idle" | "pending" | "running" | "done" | "failed" | "awaiting";

// ── 展开状态机（spec B5）────────────────────────
// 规则：自动展开只发生在状态跃迁瞬间（→running / →awaiting / →failed）；
// 用户手动操作记 override，状态跃迁时清除；→failed 强制展开（清 override）。

export interface ExpandState {
  /** 用户手动操作："collapsed" 不再自动展开；"expanded" 不被收起 */
  overrides: Record<string, "collapsed" | "expanded">;
  /** 自动展开集（只增不减；自动逻辑从不收起） */
  auto: Record<string, boolean>;
  /** 上一次观察到的各 phase 状态，用于检测跃迁 */
  prev: Record<string, PhaseRunState>;
}

export function createExpandState(): ExpandState {
  return { overrides: {}, auto: {}, prev: {} };
}

const AUTO_EXPAND_STATES: ReadonlySet<PhaseRunState> = new Set(["running", "awaiting", "failed"]);

export function applyStatusTransitions(
  state: ExpandState,
  statuses: Record<string, PhaseRunState>,
): ExpandState {
  const next: ExpandState = {
    overrides: { ...state.overrides },
    auto: { ...state.auto },
    prev: { ...state.prev },
  };
  for (const [phase, status] of Object.entries(statuses)) {
    const prev = next.prev[phase];
    if (prev === status) continue;          // 非跃迁（轮询重复）不动任何东西
    next.prev[phase] = status;
    if (AUTO_EXPAND_STATES.has(status)) {
      delete next.overrides[phase];         // 跃迁清除 override（failed 即强制展开）
      next.auto[phase] = true;
    }
  }
  return next;
}

export function toggleManual(state: ExpandState, phase: string): ExpandState {
  const expanded = isExpanded(state, phase);
  return {
    ...state,
    overrides: { ...state.overrides, [phase]: expanded ? "collapsed" : "expanded" },
  };
}

export function isExpanded(state: ExpandState, phase: string): boolean {
  const o = state.overrides[phase];
  if (o === "expanded") return true;
  if (o === "collapsed") return false;
  return state.auto[phase] === true;
}

// ── 追尾滚动 ────────────────────────────────────

export const FOLLOW_THRESHOLD_PX = 24;

export function shouldFollow(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_THRESHOLD_PX;
}

// ── log:entry 分发 ──────────────────────────────
// logger 的 phase tag 用的是业务 label（如「设计」），WS 增量行需要映射回
// phase name 才能挂到正确 section。解析不出来返回 null（宁可不分发也不错挂）。

export function resolveLogPhase(
  tag: string | undefined,
  labelToName: Record<string, string>,
  names: ReadonlySet<string>,
): string | null {
  if (!tag) return null;
  if (names.has(tag)) return tag;
  return labelToName[tag] ?? null;
}

// ── 重跑轮数 ────────────────────────────────────

export function phaseRounds(events: Array<{ phase: string }>, phase: string): number {
  let n = 0;
  for (const e of events) if (e.phase === phase) n += 1;
  return n;
}

// ── 耗时格式化 ──────────────────────────────────

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// ── 日志 level（从 PhaseLogsViewer 平移，该组件随旧 tab 删除）──

export const LEVEL_RE = /\s\[(INFO|WARN|ERROR|DEBUG)\]\s/;
export type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";
export const ALL_LEVELS: Level[] = ["INFO", "WARN", "ERROR", "DEBUG"];

export function extractLevel(line: string): Level | null {
  const m = line.match(LEVEL_RE);
  return (m?.[1] as Level) ?? null;
}

export const LEVEL_TEXT: Record<Level, string> = {
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-destructive",
  DEBUG: "text-muted-foreground",
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/web-run-view-logic.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/src/lib/run-view-logic.ts tests/web-run-view-logic.test.ts
git commit -m "feat(web): GA 执行视图纯逻辑（展开状态机/追尾/日志分发/轮数）"
```

---

### Task 6: RunPhaseSection 组件（单 phase 折叠日志）

**Files:**
- Create: `src/web/src/components/RunPhaseSection.tsx`

- [ ] **Step 1: 实现组件**

```tsx
// src/web/src/components/RunPhaseSection.tsx
// GA 式执行视图的单个 phase 折叠 section：header（状态/耗时/ⓘ/chevron）+
// 日志区（懒加载 + running 时轮询/WS 增量 + 底部追尾）。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Info, RotateCcw, Loader2 } from "lucide-react";
import { api } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  shouldFollow, fmtDuration, extractLevel, LEVEL_TEXT, type Level,
} from "@/lib/run-view-logic";
import { PhaseStatusIcon, type PhaseVisualState } from "@/components/RunPhaseNav";

const LIVE_POLL_INTERVAL_MS = 4000;

export interface RunPhaseSectionProps {
  taskId: string;
  name: string;                    // 内核 phase name
  label?: string;                  // 业务标签
  runState: PhaseVisualState;
  rounds: number;                  // 执行轮数（>1 显 ×N）
  durationText: string;            // 已格式化耗时（含 P50 / 已等 等后缀），"—" 表示未开始
  expanded: boolean;
  onToggle: () => void;
  onInfo: () => void;              // 开 PhaseDetailDrawer
  liveLines: string[];             // WS 分发来的增量行（仅 running 用）
  filterQuery: string;
  filterLevels: Set<Level>;
  errorNote?: string;              // failed 时的错误摘要
  onRetry?: () => void;            // failed 时的重试
}

export function RunPhaseSection(props: RunPhaseSectionProps) {
  const {
    taskId, name, label, runState, rounds, durationText,
    expanded, onToggle, onInfo, liveLines, filterQuery, filterLevels,
    errorNote, onRetry,
  } = props;

  const [content, setContent] = useState<string | null>(null);  // null = 未加载
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [paused, setPaused] = useState(false);
  const [missed, setMissed] = useState(0);

  const isRunning = runState === "running";

  const fetchLog = (lines: number) => {
    setLoading(true);
    setLoadErr(null);
    api.getPhaseLog(taskId, name, lines)
      .then((res) => { setContent(res.content); loadedRef.current = true; })
      .catch((e: unknown) => setLoadErr((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  // 懒加载：首次展开才拉（pending 不拉）
  useEffect(() => {
    if (!expanded || loadedRef.current || runState === "pending" || runState === "idle") return;
    fetchLog(isRunning ? 200 : 500);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [expanded, runState]);

  // running 时 4s 轮询全量替换（兜底 WS 断线；替换自带 WS 增量行，故清空 liveBuffer 由父级做）
  useEffect(() => {
    if (!expanded || !isRunning) return;
    const t = setInterval(() => fetchLog(500), LIVE_POLL_INTERVAL_MS);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [expanded, isRunning, taskId, name]);

  // 行合并 + 过滤
  const lines = useMemo(() => {
    const base = (content ?? "").split("\n");
    const all = isRunning ? [...base, ...liveLines] : base;
    const q = filterQuery.trim().toLowerCase();
    return all.filter((line) => {
      if (!line.trim()) return false;
      const lvl = extractLevel(line);
      if (lvl && !filterLevels.has(lvl)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [content, liveLines, isRunning, filterQuery, filterLevels]);

  const matchCount = filterQuery.trim() ? lines.length : null;

  // 追尾：新行到达时若在跟随态滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      setMissed(0);
    } else {
      setMissed((n) => n + 1);
    }
  }, [lines.length, expanded]);

  // 折叠再展开 → 重置跟随
  useEffect(() => {
    if (expanded) { followRef.current = true; setPaused(false); setMissed(0); }
  }, [expanded]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const f = shouldFollow(el.scrollTop, el.scrollHeight, el.clientHeight);
    followRef.current = f;
    setPaused(!f);
    if (f) setMissed(0);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setPaused(false);
    setMissed(0);
  };

  return (
    <div className={cn(
      "rounded-xl border border-border bg-card",
      runState === "failed" && "border-l-2 border-l-destructive",
    )}>
      {/* header：整行可点折叠 */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <PhaseStatusIcon state={runState} />
        <span className="min-w-0 truncate text-[13px] font-medium">{label ?? name}</span>
        {label && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{name}</span>}
        {rounds > 1 && (
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={`第 ${rounds} 次执行`}>
            ×{rounds}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {matchCount != null && <span className="mr-2 text-accent">· {matchCount} 处</span>}
          {durationText}
        </span>
        {onRetry && runState === "failed" && (
          <Button
            variant="outline" size="sm" className="shrink-0"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重试此阶段
          </Button>
        )}
        <span
          role="button"
          tabIndex={0}
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onInfo(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onInfo(); } }}
          title="阶段定义（agent / timeout / 驳回）"
        >
          <Info className="h-3.5 w-3.5" />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2">
          {runState === "failed" && errorNote && (
            <p className="mb-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">{errorNote}</p>
          )}
          {runState === "pending" || runState === "idle" ? (
            <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">尚未开始</p>
          ) : loading && content == null ? (
            <p className="flex items-center gap-2 py-4 font-mono text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载日志…
            </p>
          ) : loadErr ? (
            <p className="py-3 font-mono text-[11px] text-destructive">
              日志加载失败：{loadErr}
              <Button variant="ghost" size="sm" className="ml-2" onClick={() => fetchLog(500)}>重试</Button>
            </p>
          ) : lines.length === 0 ? (
            <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">
              {filterQuery.trim() || filterLevels.size < 4 ? "无匹配行" : "本阶段无日志输出"}
            </p>
          ) : (
            <div className="relative">
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="scrollbar-thin max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed"
              >
                {lines.map((line, i) => {
                  const lvl = extractLevel(line);
                  return (
                    <div key={i} className={cn("whitespace-pre-wrap break-words", lvl ? LEVEL_TEXT[lvl] : "text-foreground")}>
                      {line}
                    </div>
                  );
                })}
              </div>
              {isRunning && (
                paused ? (
                  <button
                    type="button"
                    onClick={jumpToLatest}
                    className="absolute bottom-2 right-2 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[10px] text-accent shadow-sm hover:border-accent"
                  >
                    已暂停{missed > 0 ? ` · ${missed} 条新日志` : ""} ↓ 跳到最新
                  </button>
                ) : (
                  <span className="absolute bottom-2 right-2 rounded-full bg-card/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    跟随中 · 上滚暂停
                  </span>
                )
              )}
            </div>
          )}
          {runState === "awaiting" && (
            <p className="mt-2 font-mono text-[10px] text-warning">↑ 在顶部「等待你拍板」横幅里通过 / 驳回</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck（暂会因 RunPhaseNav 未建而报错——与 Task 7 联动，此步只确认本文件无独立语法错，可延后到 Task 7 末尾一起验）**

- [ ] **Step 3: Commit（与 Task 7 合并提交，见 Task 7 Step 4）**

---

### Task 7: RunPhaseNav 组件（左导航 + 窄容器横条 + phaseVisual）

**Files:**
- Create: `src/web/src/components/RunPhaseNav.tsx`

- [ ] **Step 1: 实现组件**

```tsx
// src/web/src/components/RunPhaseNav.tsx
// GA 式执行视图的 phase 导航：宽容器 = 左侧竖排列表；窄容器 = 横向 chip 条。
// 纯定位器：点击只负责「展开 + 滚到 section」，不承载折叠/重试/决策动作。
import { Circle, CheckCircle2, XCircle, Hand, Loader2, History } from "lucide-react";
import { cn } from "@/lib/utils";

export type PhaseVisualState = "idle" | "pending" | "running" | "done" | "failed" | "awaiting";

/** 左导航与 section header 共用的状态视觉（同源同款，spec B3） */
export function PhaseStatusIcon({ state, className }: { state: PhaseVisualState; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  switch (state) {
    case "running": return <Loader2 className={cn(cls, "animate-spin text-accent")} />;
    case "done": return <CheckCircle2 className={cn(cls, "text-success")} />;
    case "failed": return <XCircle className={cn(cls, "text-destructive")} />;
    case "awaiting": return <Hand className={cn(cls, "text-warning")} />;
    default: return <Circle className={cn(cls, "text-muted-foreground/50")} />;
  }
}

export interface NavPhaseItem {
  name: string;
  label?: string;
  state: PhaseVisualState;
  durationText: string;          // "—" 表示未开始
  group?: string;                // 所属并行组名（顶层 phase 为 undefined）
}

export interface NavGroupHeader { group: string; label?: string; }

/** 导航条目序列：并行组以 header 项打头，子项带 group 字段 */
export type NavEntry = { kind: "phase"; item: NavPhaseItem } | { kind: "group"; header: NavGroupHeader };

interface RunPhaseNavProps {
  entries: NavEntry[];
  activePhase: string | null;
  onSelect: (phase: string) => void;
  onSelectTransitions: () => void;
  transitionsCount: number;
}

/** 宽容器左导航（竖排）。父级需 hidden/@3xl:block 控制显隐。 */
export function RunPhaseNavSidebar({ entries, activePhase, onSelect, onSelectTransitions, transitionsCount }: RunPhaseNavProps) {
  return (
    <nav className="w-60 shrink-0 self-start" aria-label="阶段导航">
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">阶段 · PHASES</p>
      <ul className="space-y-0.5">
        {entries.map((e) =>
          e.kind === "group" ? (
            <li key={`g-${e.header.group}`} className="pt-1.5">
              <p className="font-mono text-[10px] text-muted-foreground">
                {e.header.label ?? e.header.group} · PARALLEL
              </p>
            </li>
          ) : (
            <li key={e.item.name} className={cn(e.item.group && "ml-3 border-l border-border pl-2")}>
              <button
                type="button"
                onClick={() => onSelect(e.item.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/8",
                  activePhase === e.item.name && "border-l-2 border-l-accent bg-accent/8",
                )}
              >
                <PhaseStatusIcon state={e.item.state} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{e.item.label ?? e.item.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{e.item.durationText}</span>
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          onClick={onSelectTransitions}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent/8 hover:text-foreground"
        >
          <History className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-[13px]">状态转移</span>
          <span className="shrink-0 font-mono text-[11px]">{transitionsCount}</span>
        </button>
      </div>
    </nav>
  );
}

/** 窄容器横向 chip 条。父级需 @3xl:hidden 控制显隐。 */
export function RunPhaseNavStrip({ entries, activePhase, onSelect }: Omit<RunPhaseNavProps, "onSelectTransitions" | "transitionsCount">) {
  return (
    <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="阶段导航">
      {entries.filter((e): e is Extract<NavEntry, { kind: "phase" }> => e.kind === "phase").map((e) => (
        <button
          key={e.item.name}
          type="button"
          onClick={() => onSelect(e.item.name)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            activePhase === e.item.name
              ? "border-accent bg-accent/10 text-foreground"
              : "border-border text-muted-foreground hover:border-accent/60",
            e.item.group && "border-dashed",
          )}
        >
          <PhaseStatusIcon state={e.item.state} className="h-3.5 w-3.5" />
          {e.item.label ?? e.item.name}
          {e.item.durationText !== "—" && (
            <span className="font-mono text-[10px] text-muted-foreground">{e.item.durationText}</span>
          )}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 0 错误（Task 6 的 RunPhaseSection 此时也应通过）

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/RunPhaseSection.tsx src/web/src/components/RunPhaseNav.tsx
git commit -m "feat(web): GA 执行视图的 section 与导航组件"
```

---

### Task 8: TaskRunView 容器组件

**Files:**
- Create: `src/web/src/components/TaskRunView.tsx`

- [ ] **Step 1: 实现容器**

要点：flatten workflowDetail.phases（含 parallel）；展开状态机接 `applyStatusTransitions`；WS `log:entry` 按 `resolveLogPhase` 分发到 per-phase 缓冲（轮询全量替换时由 RunPhaseSection 的 content 覆盖，缓冲只在 running 期累加、phase 离开 running 时清空）；工具栏 + 左导航 + section 流 + transitions section；容器查询 `@container` 切换 Sidebar/Strip；scroll-spy 用 IntersectionObserver。

```tsx
// src/web/src/components/TaskRunView.tsx
// GitHub Actions job 形态的任务执行视图：左 phase 导航 + 右折叠日志 section 流。
// 数据全部由 TaskDetail 注入（task / workflowDetail / phaseRunStatuses / events / stats / logs）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api, type TaskPhaseEvent } from "@/hooks/useApi";
import { LogTimeline } from "@/components/LogTimeline";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  resolveLogPhase, phaseRounds, fmtDuration,
  ALL_LEVELS, type Level, type PhaseRunState,
} from "@/lib/run-view-logic";
import { RunPhaseNavSidebar, RunPhaseNavStrip, type NavEntry, type PhaseVisualState } from "@/components/RunPhaseNav";
import { RunPhaseSection } from "@/components/RunPhaseSection";

interface FlatPhase { name: string; label?: string; group?: string; groupLabel?: string; }

/** workflowDetail.phases（含 parallel 块）拍平成线性序列，保留组归属 */
function flattenPhases(phases: unknown[]): FlatPhase[] {
  const out: FlatPhase[] = [];
  for (const raw of (phases as Array<Record<string, any>> | undefined) ?? []) {
    if (raw?.parallel) {
      const g = String(raw.parallel.name ?? "parallel");
      const gl = typeof raw.parallel.label === "string" ? raw.parallel.label : undefined;
      for (const sub of (raw.parallel.phases as Array<Record<string, any>> | undefined) ?? []) {
        if (sub?.name) out.push({ name: String(sub.name), label: typeof sub.label === "string" ? sub.label : undefined, group: g, groupLabel: gl });
      }
    } else if (raw?.name) {
      out.push({ name: String(raw.name), label: typeof raw.label === "string" ? raw.label : undefined });
    }
  }
  return out;
}

interface TaskRunViewProps {
  taskId: string;
  taskStatus: string;
  workflowPhases: unknown[];                       // workflowDetail.phases（raw）
  phaseRunStatuses: Record<string, string>;        // TaskDetail 现有推导（idle/pending/running/done/failed/awaiting）
  phaseEvents: TaskPhaseEvent[];
  phaseStats?: Record<string, { count: number; p50_ms: number }>;
  logs: Array<{ to_status?: string; created_at?: string; note?: string }>;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
  onInfoPhase: (phase: string) => void;            // 开 PhaseDetailDrawer
}

export function TaskRunView(props: TaskRunViewProps) {
  const { taskId, taskStatus, workflowPhases, phaseRunStatuses, phaseEvents, phaseStats, logs, subscribe, onInfoPhase } = props;
  const toast = useToast();

  const flat = useMemo(() => flattenPhases(workflowPhases), [workflowPhases]);
  const names = useMemo(() => new Set(flat.map((p) => p.name)), [flat]);
  const labelToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of flat) if (p.label) m[p.label] = p.name;
    return m;
  }, [flat]);

  // phase 状态归一
  const stateOf = (name: string): PhaseRunState =>
    (["idle", "pending", "running", "done", "failed", "awaiting"].includes(phaseRunStatuses[name] ?? "")
      ? (phaseRunStatuses[name] as PhaseRunState)
      : "idle");

  // 展开状态机
  const [expand, setExpand] = useState(createExpandState);
  useEffect(() => {
    const statuses: Record<string, PhaseRunState> = {};
    for (const p of flat) statuses[p.name] = stateOf(p.name);
    setExpand((prev) => applyStatusTransitions(prev, statuses));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [phaseRunStatuses, flat]);

  // WS 增量分发（per-phase 缓冲；phase 离开 running 时清空）
  const [liveByPhase, setLiveByPhase] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const unsub = subscribe(`log:${taskId}`, (event: any) => {
      if (event?.type !== "log:entry") return;
      const phase = resolveLogPhase(event.payload?.phase, labelToName, names);
      if (!phase) return;
      setLiveByPhase((prev) => ({
        ...prev,
        [phase]: [...(prev[phase] ?? []).slice(-300), String(event.payload?.message ?? "")],
      }));
    });
    return unsub;
  }, [taskId, subscribe, labelToName, names]);
  useEffect(() => {
    // 离开 running 的 phase 清缓冲（轮询全量已包含其内容）
    setLiveByPhase((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (stateOf(k) !== "running") delete next[k];
      return next;
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [phaseRunStatuses]);

  // 工具栏
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set(ALL_LEVELS));
  const toggleLevel = (l: Level) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l); else next.add(l);
      return next;
    });

  // 每秒走字（running elapsed）
  const [, setTick] = useState(0);
  const anyRunning = flat.some((p) => stateOf(p.name) === "running") || taskStatus.startsWith("awaiting_");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  // 耗时文案
  const durationOf = (name: string): string => {
    const evs = phaseEvents.filter((e) => e.phase === name);
    const last = evs[evs.length - 1];
    if (!last) return "—";
    const startMs = last.started_at < 1e12 ? last.started_at * 1000 : last.started_at;
    const endMs = last.ended_at ? (last.ended_at < 1e12 ? last.ended_at * 1000 : last.ended_at) : null;
    const st = stateOf(name);
    if (st === "running") {
      const base = fmtDuration(Date.now() - startMs);
      const p50 = phaseStats?.[name]?.p50_ms;
      return p50 ? `${base} · 常约${fmtDuration(p50)}` : base;
    }
    if (st === "awaiting") {
      const ran = endMs ? fmtDuration(endMs - startMs) : "—";
      return `${ran} · 已等 ${fmtDuration(Date.now() - (endMs ?? startMs))}`;
    }
    if (endMs) return fmtDuration(endMs - startMs);
    return "—";
  };

  // failed 错误摘要：最近一条带 note 的 transition
  const errorNote = useMemo(
    () => [...logs].find((l) => l?.note)?.note ?? undefined,
    [logs],
  );

  const retryPhase = async () => {
    try {
      const r = await api.restartTask(taskId);
      toast.success(`已重启 · 从 ${r.phase} 阶段重新执行`);
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    }
  };

  // 导航 entries（并行组带 header）
  const entries = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = [];
    let lastGroup: string | undefined;
    for (const p of flat) {
      if (p.group && p.group !== lastGroup) out.push({ kind: "group", header: { group: p.group, label: p.groupLabel } });
      lastGroup = p.group;
      out.push({
        kind: "phase",
        item: { name: p.name, label: p.label, state: stateOf(p.name) as PhaseVisualState, durationText: durationOf(p.name), group: p.group },
      });
    }
    return out;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [flat, phaseRunStatuses, phaseEvents, phaseStats]);

  // 点击导航：展开 + 滚动定位
  const [activePhase, setActivePhase] = useState<string | null>(null);
  const clickGuardRef = useRef(0);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [transitionsOpen, setTransitionsOpen] = useState(false);
  const transitionsRef = useRef<HTMLDivElement>(null);

  const selectPhase = (name: string) => {
    setActivePhase(name);
    clickGuardRef.current = Date.now() + 600;     // 点击高亮优先 600ms，防 scroll-spy 抖动
    setExpand((prev) => (isExpanded(prev, name) ? prev : toggleManual(prev, name)));
    requestAnimationFrame(() => {
      sectionRefs.current[name]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const selectTransitions = () => {
    setTransitionsOpen(true);
    requestAnimationFrame(() => transitionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // scroll-spy
  useEffect(() => {
    const obs = new IntersectionObserver(
      (items) => {
        if (Date.now() < clickGuardRef.current) return;
        const top = items
          .filter((i) => i.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const name = top?.target.getAttribute("data-phase");
        if (name) setActivePhase(name);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const el of Object.values(sectionRefs.current)) if (el) obs.observe(el);
    return () => obs.disconnect();
  }, [entries.length]);

  const renderSection = (p: FlatPhase) => (
    <div key={p.name} ref={(el) => { sectionRefs.current[p.name] = el; }} data-phase={p.name}>
      <RunPhaseSection
        taskId={taskId}
        name={p.name}
        label={p.label}
        runState={stateOf(p.name) as PhaseVisualState}
        rounds={phaseRounds(phaseEvents, p.name)}
        durationText={durationOf(p.name)}
        expanded={isExpanded(expand, p.name)}
        onToggle={() => setExpand((prev) => toggleManual(prev, p.name))}
        onInfo={() => onInfoPhase(p.name)}
        liveLines={liveByPhase[p.name] ?? []}
        filterQuery={query}
        filterLevels={levels}
        errorNote={stateOf(p.name) === "failed" ? errorNote : undefined}
        onRetry={stateOf(p.name) === "failed" ? retryPhase : undefined}
      />
    </div>
  );

  // section 流：按 flat 顺序，相邻同组包浅容器
  const sectionFlow: React.ReactNode[] = [];
  for (let i = 0; i < flat.length; ) {
    const p = flat[i];
    if (p.group) {
      const groupItems: FlatPhase[] = [];
      const g = p.group;
      while (i < flat.length && flat[i].group === g) { groupItems.push(flat[i]); i += 1; }
      sectionFlow.push(
        <div key={`grp-${g}`} className="space-y-2 rounded-xl border border-border bg-muted/20 p-2">
          <p className="px-1 font-mono text-[10px] text-muted-foreground">{groupItems[0].groupLabel ?? g} · PARALLEL</p>
          {groupItems.map(renderSection)}
        </div>,
      );
    } else {
      sectionFlow.push(renderSection(p));
      i += 1;
    }
  }

  const LEVEL_BTN: Record<Level, string> = { INFO: "text-info", WARN: "text-warning", ERROR: "text-destructive", DEBUG: "text-muted-foreground" };

  return (
    <div className="@container mb-4">
      {/* 窄容器：横向 chip 条 */}
      <div className="mb-3 @3xl:hidden">
        <RunPhaseNavStrip entries={entries} activePhase={activePhase} onSelect={selectPhase} />
      </div>

      <div className="flex items-start gap-5">
        {/* 宽容器：左导航 */}
        <div className="sticky top-4 hidden @3xl:block">
          <RunPhaseNavSidebar
            entries={entries}
            activePhase={activePhase}
            onSelect={selectPhase}
            onSelectTransitions={selectTransitions}
            transitionsCount={logs.length}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* sticky 工具栏 */}
          <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-background/95 px-1 py-2 backdrop-blur">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索日志（作用于已展开阶段）…"
                className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-2 font-mono text-xs focus:border-accent focus:outline-none"
              />
            </div>
            <div className="flex shrink-0 items-center gap-0 overflow-hidden rounded-md border border-border">
              {ALL_LEVELS.map((lvl) => {
                const on = levels.has(lvl);
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => toggleLevel(lvl)}
                    aria-pressed={on}
                    className={cn(
                      "border-r border-border px-2.5 py-1.5 font-mono text-[10px] font-medium transition-colors last:border-r-0",
                      on ? cn("bg-foreground/5", LEVEL_BTN[lvl]) : "text-muted-foreground opacity-40 hover:opacity-100",
                    )}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>

          {sectionFlow}

          {/* 状态转移（审计视图，沉底折叠） */}
          <div ref={transitionsRef}>
            <Card>
              <button
                type="button"
                onClick={() => setTransitionsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
              >
                <span className="bp-label">⏱ 状态转移 · TRANSITIONS</span>
                <span className="font-mono text-[10px] text-muted-foreground">{logs.length}</span>
              </button>
              {transitionsOpen && (
                <div className="border-t border-border p-4">
                  <LogTimeline logs={logs} />
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/TaskRunView.tsx
git commit -m "feat(web): TaskRunView — GA 式执行视图容器（导航/分发/工具栏/状态转移）"
```

---

### Task 9: TaskDetail 接线 + 孤儿组件清理

**Files:**
- Modify: `src/web/src/pages/TaskDetail.tsx`
- Delete: `src/web/src/components/TaskPhaseTimeline.tsx`、`src/web/src/components/PhaseLogsViewer.tsx`（grep 确认仅 TaskDetail 引用后）

- [ ] **Step 1: TaskDetail.tsx 删旧**

- 删 import：`PhasePipeline`、`TaskPhaseTimeline`、`PhaseLogsViewer`、`LogTimeline`（移入 TaskRunView）、icons `Radio/History/FileText/MousePointerClick`
- 删 state/ref/effect：`hoveredPhase`、`liveLogs`、`liveLogRef`、`stickToTopRef`、baseline 拉取 effect（L69-89）、`log:${taskId}` 订阅（L117-121，保留 `task:` 订阅）、`onLogScroll`、追顶 effect（L128-139）
- 删 JSX：流水线 Card（L448-469）、`<TaskPhaseTimeline …/>`（L378-384）
- `TaskDetailTabs` 缩为 sandbox + agent-calls 两个 tab：删 `phase-logs`/`transitions`/`live` 的 trigger 与 content、`unreadLive` 逻辑、`DetailTab` 类型缩为 `"sandbox" | "agent-calls"`、props 里 logs/liveLogs/liveLogRef/stickToTopRef/onLogScroll 全删

- [ ] **Step 2: TaskDetail.tsx 接入 TaskRunView + 布局重排**

在 banners（GateBanner/AskBanner 之后）与 Tabs 之间插入；基本信息 Card 移到 Tabs 之后：

```tsx
{/* 执行视图（GA 式）：左 phase 导航 + 右折叠日志流 */}
{workflowDetail?.phases && (
  <TaskRunView
    taskId={taskId}
    taskStatus={task.status}
    workflowPhases={workflowDetail.phases}
    phaseRunStatuses={phaseRunStatuses}
    phaseEvents={phaseEvents}
    phaseStats={phaseStats}
    logs={logs}
    subscribe={subscribe}
    onInfoPhase={setDrawerPhase}
  />
)}

<TaskDetailTabs taskId={taskId} />

{/* 基本信息 — 移到执行视图之后（metadata 是低频查看） */}
<Card className="mb-4">…（原 L409-446 整块原样下移）…</Card>
```

import 区加：`import { TaskRunView } from "@/components/TaskRunView";`

- [ ] **Step 3: 孤儿清理**

Run: `grep -rn "TaskPhaseTimeline\|PhaseLogsViewer" src/web/src --include="*.tsx" --include="*.ts"`
Expected: 仅组件自身文件命中 → 删除两个文件。若有其他引用，保留文件并在计划完成报告中注明。

- [ ] **Step 4: 验证 + 构建**

Run: `bun run typecheck && bun test && bun run build:web`
Expected: 全绿 + 构建成功

- [ ] **Step 5: Commit**

```bash
git add -A src/web/src
git commit -m "feat(web): 执行界面改为 GitHub Actions 形态，移除旧 pipeline/耗时轴/日志 tabs"
```

---

### Task 10: 端到端 dogfood 验证

- [ ] **Step 1: 构建后用真实 daemon 验证**

daemon 正在运行（端口 6180）。`bun run build:web` 后刷新浏览器：
1. 项目详情页：tab 计数正确、时间分组出现、卡片可点进需求页、空 tab 文案正确
2. 任务详情页（有 running 任务最佳）：左导航状态/耗时、running section 自动展开并滚动、上滚暂停 pill、搜索/level 过滤、ⓘ 开 drawer、状态转移折叠 section
3. 需求详情页 running 步（embedded）：窄容器显示横向 chip 条而非左导航

- [ ] **Step 2: 把宽/窄两形态截图或行为问题记录修复**

发现问题→修复→重跑 `bun run typecheck && bun test`。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A && git commit -m "fix(web): GA 执行视图 dogfood 修正"
```

---

## Self-Review 备忘

- spec「awaiting 等待时长走字」由 durationOf 的 awaiting 分支覆盖；「驳回分隔行」依赖日志文件本身的轮次内容，前端以 ×N badge + 全量日志呈现（spec 的分隔行插入需要后端写日志时落「第 N 次执行」标记——runner 已在每轮 phase 开始写 banner 行，验证时确认；若无则前端不伪造，仅 badge）
- PhasePipeline 组件文件保留（工作流编辑器引用）
- `@3xl` 容器断点 ≈ 768px，对应 spec 的 embedded 窄容器阈值
