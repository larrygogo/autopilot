import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, Search, X, List, Archive, AlertCircle, CheckCircle2, XCircle, Clock, FileText } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHero } from "@/components/PageHero";
import { cn } from "@/lib/utils";

interface Task {
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

/**
 * 流水线 — 一条工作从「需求」到「任务」的全生命周期全景视图。
 *
 * 状态简化为 4 段（按"球在谁那边"）：
 *  - 全部
 *  - 等待人工：草稿/待审批(需求) + 任务等待人工 + 失败需关注（需要你介入）
 *  - 运行中：调查中(需求) + 进行中/待执行(任务)（AI 自动推进）
 *  - 归档：已完成/已取消
 * Now 仍独立留给"需要你拍板"的决策收件箱，本页是"所有在途工作"的全景。
 */

// 卡片状态色调：头像图标色 + 状态点 bg
const TONE = {
  accent: { text: "text-accent", dot: "bg-accent" },
  warning: { text: "text-warning", dot: "bg-warning" },
  destructive: { text: "text-destructive", dot: "bg-destructive" },
  success: { text: "text-success", dot: "bg-success" },
  info: { text: "text-info", dot: "bg-info" },
  muted: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
} as const;
type Tone = keyof typeof TONE;

function taskMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string } {
  if (status.startsWith("running_")) return { Icon: Loader2, tone: "accent", label: "运行中" };
  if (status.startsWith("awaiting_")) return { Icon: Hand, tone: "warning", label: "等待人工" };
  if (status === "failed" || status.startsWith("failed_")) return { Icon: AlertCircle, tone: "destructive", label: "失败" };
  if (status.startsWith("pending_")) return { Icon: Clock, tone: "muted", label: "待执行" };
  if (status === "done") return { Icon: CheckCircle2, tone: "success", label: "已完成" };
  return { Icon: XCircle, tone: "muted", label: "已取消" };
}
function reqMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string } {
  if (status === "queued") return { Icon: Clock, tone: "accent", label: "待执行" };
  if (status === "awaiting_approval") return { Icon: Hand, tone: "warning", label: "待审批" };
  if (status === "ready") return { Icon: Hand, tone: "warning", label: "待入队" };
  if (status === "clarifying") return { Icon: Search, tone: "info", label: "调查中" };
  if (status === "drafting") return { Icon: FileText, tone: "muted", label: "草稿" };
  return { Icon: FileText, tone: "muted", label: status };
}

/** 相对时间（中文）：刚刚 / N分钟前 / N小时前 / N天前 / N周前 / N个月前 */
function relTime(ms: number, now: number): string {
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

// ──────────── 列表内按时间分组（今天 / 昨天 / 一周内 / 一月内 / 更早） ────────────
type TimeBucket = "today" | "yesterday" | "week" | "month" | "earlier";
const BUCKET_ORDER: TimeBucket[] = ["today", "yesterday", "week", "month", "earlier"];
const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: "今天", yesterday: "昨天", week: "一周内", month: "一月内", earlier: "更早",
};

/** 归一化到 ms：需求的 ts 是数字 epoch，任务的是 ISO 字符串；秒级时间戳自动 *1000 */
function tsToMs(ts: string | number | null | undefined): number {
  if (ts == null) return 0;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function bucketOf(ms: number, now: number): TimeBucket {
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

interface TimedRow { key: string; ts: number; node: ReactNode; }

/** 把行列表分桶渲染（带时段小标题）。入参应已按时间倒序。 */
function TimeGroupedList({ rows, now }: { rows: TimedRow[]; now: number }) {
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

interface PipelineTab {
  key: string;
  label: string;
  icon: typeof Loader2;
  iconClass: string;
  reqs: Requirement[];
  tasks: Task[];
}

export function Tasks() {
  const { subscribe } = useWebSocket();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(null);
  /** 当前激活的 tab（默认「全部」总览） */
  const [tab, setTab] = useState<string>("all");

  const refresh = () => {
    setLoading(true);
    setError(null);
    Promise.all([api.listTasks(), api.listRequirements()])
      .then(([tlist, rlist]) => {
        setTasks(tlist as Task[]);
        setRequirements(rlist as Requirement[]);
      })
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  // WS：task:* 与 requirement:* 变化自动 refetch
  useEffect(() => {
    const unsubT = subscribe("task:*", () => refresh());
    const unsubR = subscribe("requirement:*", () => refresh());
    return () => { unsubT(); unsubR(); };
  }, [subscribe]);

  const allWorkflows = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.workflow) set.add(t.workflow);
    return [...set].sort();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q && !workflowFilter) return tasks;
    return tasks.filter((t) => {
      if (workflowFilter && t.workflow !== workflowFilter) return false;
      if (!q) return true;
      return (
        (t.id ?? "").toLowerCase().includes(q) ||
        (t.title ?? "").toLowerCase().includes(q) ||
        (t.workflow ?? "").toLowerCase().includes(q) ||
        (t.requirement_id ?? "").toLowerCase().includes(q)
      );
    });
  }, [tasks, searchQuery, workflowFilter]);

  // 需求只按搜索过滤；workflow chip 激活时聚焦任务视角，隐藏需求段
  const filteredRequirements = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (workflowFilter) return [];
    if (!q) return requirements;
    return requirements.filter((r) =>
      (r.id ?? "").toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q),
    );
  }, [requirements, searchQuery, workflowFilter]);

  // 4 段分类：等待人工 / 运行中 / 归档（需求只显示 draft/investigating/awaiting_approval 前置阶段）
  const tabs = useMemo<PipelineTab[]>(() => {
    const reqHuman: Requirement[] = [];
    const reqRunning: Requirement[] = [];
    for (const r of filteredRequirements) {
      // 已派生任务的需求由任务行代表，避免一件工作显示两条
      if (r.task_id) continue;
      const s = r.status;
      if (s === "cancelled" || s === "done") continue; // 终态需求不单列
      if (s === "queued") reqRunning.push(r); // 已审批、即将起任务
      else reqHuman.push(r); // drafting/clarifying/ready/awaiting_approval/failed 等 → 球在你这
    }
    const taskHuman: Task[] = [];
    const taskRunning: Task[] = [];
    const archived: Task[] = [];
    for (const t of filteredTasks) {
      const s = t.status;
      if (s.startsWith("awaiting_") || s === "failed" || s.startsWith("failed_")) taskHuman.push(t);
      else if (s.startsWith("running_") || s.startsWith("pending_")) taskRunning.push(t);
      else if (s === "done" || s === "cancelled" || s === "canceled") archived.push(t);
    }
    return [
      { key: "human", label: "等待人工", icon: Hand, iconClass: "text-warning", reqs: reqHuman, tasks: taskHuman },
      { key: "running", label: "运行中", icon: Loader2, iconClass: "text-accent", reqs: reqRunning, tasks: taskRunning },
      { key: "archived", label: "归档", icon: Archive, iconClass: "text-muted-foreground", reqs: [], tasks: archived },
    ];
  }, [filteredRequirements, filteredTasks]);

  const now = Date.now();

  /** 把一个 tab 的需求+任务合成按时间倒序的行列表 */
  const rowsOf = (t: PipelineTab): TimedRow[] =>
    [
      ...t.reqs.map((r) => ({ key: `r-${r.id}`, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} /> })),
      ...t.tasks.map((tk) => ({ key: `t-${tk.id}`, ts: tsToMs(tk.updated_at), node: <TaskRow task={tk} now={now} /> })),
    ].sort((a, b) => b.ts - a.ts);

  const allRows = useMemo(() => tabs.flatMap(rowsOf).sort((a, b) => b.ts - a.ts), [tabs]);
  const tabCount = (t: PipelineTab) => t.reqs.length + t.tasks.length;

  const hasAny = tasks.length > 0 || requirements.length > 0;
  const filteredAny = filteredTasks.length > 0 || filteredRequirements.length > 0;
  const filterActive = !!searchQuery.trim() || !!workflowFilter;
  const clearFilters = () => {
    setSearchQuery("");
    setWorkflowFilter(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        eyebrow="SHEET · PIPELINE"
        title="流水线"
        subtitle="需求 → 任务 全生命周期 · 一条工作从提出到跑完"
        meta={[
          { k: "需求", v: requirements.length },
          { k: "任务", v: tasks.length },
          ...(filterActive ? [{ k: "匹配", v: filteredTasks.length + filteredRequirements.length }] : []),
        ]}
      />

      {/* 工具栏：搜索框 + workflow chip 过滤 */}
      {hasAny && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜需求 / 任务 ID / 标题 / 工作流"
                className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-7 font-mono text-xs focus:border-accent focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="清空搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {filterActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="rounded-md font-mono text-[10px] ">
                清除筛选
              </Button>
            )}
          </div>
          {allWorkflows.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">工作流</span>
              {allWorkflows.map((w) => {
                const active = workflowFilter === w;
                return (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWorkflowFilter(active ? null : w)}
                    className={cn(
                      "border px-2 py-0.5 font-mono text-[10px] transition-colors",
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-muted-foreground hover:border-accent/60 hover:text-foreground",
                    )}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && (
        <Card className="mb-4 border-l-4 border-l-destructive px-4 py-3">
          <p className="font-mono text-[10px] text-destructive mb-1">ERROR</p>
          <p className="text-sm">{error}</p>
        </Card>
      )}

      {loading && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs ">加载流水线...</p>
        </div>
      )}

      {!loading && !error && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">还没有需求或任务</p>
          <p className="mt-1 font-mono text-xs ">
            去 <Link to="/library" className="underline">项目</Link> 挂个需求，或从 <Link to="/start" className="underline">开始</Link> 页直接起任务
          </p>
        </div>
      )}

      {!loading && !error && hasAny && !filteredAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">没匹配的结果</p>
          <p className="mt-1 font-mono text-xs ">当前筛选条件下没有需求或任务</p>
          <Button variant="outline" size="sm" onClick={clearFilters} className="mt-3 rounded-md font-mono text-[10px] ">
            清除筛选
          </Button>
        </div>
      )}

      {/* 流水线：全部 + 等待人工 / 运行中 / 归档，列表内按时间分时段 */}
      {!loading && !error && filteredAny && (
        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden">
            <TabsTrigger value="all" className="gap-1.5">
              <List className="h-3.5 w-3.5 text-foreground/70" />
              全部
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{allRows.length}</span>
            </TabsTrigger>
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
                  <Icon className={cn("h-3.5 w-3.5", t.iconClass)} />
                  {t.label}
                  <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{tabCount(t)}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="all">
            {allRows.length > 0 ? (
              <TimeGroupedList rows={allRows} now={now} />
            ) : (
              <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">流水线暂无内容</p>
            )}
          </TabsContent>

          {tabs.map((t) => {
            const rows = rowsOf(t);
            return (
              <TabsContent key={t.key} value={t.key}>
                {rows.length > 0 ? (
                  <TimeGroupedList rows={rows} now={now} />
                ) : (
                  <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">此分类下暂无内容</p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}

/** Claude Code 风卡片外壳：头像图标 + 标题 + 相对时间 + 状态行 + 可选预览 */
function RowCard({
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
              <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                {preview}
              </p>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

function RequirementRow({ req, now }: { req: Requirement; now: number }) {
  const { Icon, tone, label } = reqMeta(req.status);
  const secondary = [req.id, req.task_id ? `${req.task_id} →` : null].filter(Boolean).join(" · ");
  return (
    <RowCard
      to={`/requirements/${req.id}`}
      Icon={Icon}
      tone={tone}
      title={req.title}
      time={relTime(tsToMs(req.updated_at), now)}
      statusLabel={label}
      secondary={secondary}
    />
  );
}

function TaskRow({ task, now }: { task: Task; now: number }) {
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

function parsePhase(status: string): string | null {
  const m = status.match(/^(?:running|pending|awaiting|failed)_(.+)$/);
  return m ? m[1] : null;
}
