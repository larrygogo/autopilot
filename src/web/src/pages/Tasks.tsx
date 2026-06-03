import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, AlertCircle, CheckCircle2, XCircle, Clock, Search, X, FileText, List } from "lucide-react";
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
  /** task.requirement 字段（extra 里的需求描述文本，不是 id） */
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
 * 前三段是需求阶段（草稿 / 调查中 / 待审批），审批通过后衍生任务，
 * 后六段是任务阶段（进行中 / 等待人工 / 失败 / 待执行 / 完成 / 取消）。
 * Now 仍独立留给"需要你拍板"的决策收件箱，本页是"所有在途工作"的全景。
 */
interface Group {
  key: string;
  label: string;
  icon: typeof Loader2;
  iconClass: string;
  borderClass: string;
  /** 需求阶段还是任务阶段 —— 决定行渲染方式 */
  kind: "req" | "task";
  reqs?: Requirement[];
  tasks?: Task[];
}

/** 终态组（done/cancelled）默认截断条数，超过时显示「看全部 N 条」按钮 */
const TERMINAL_PREVIEW_LIMIT = 20;

export function Tasks() {
  const { subscribe } = useWebSocket();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // P0 断点修复：用过一段时间后任务积累到几十条，搜不到 / 筛不动。
  // 全量本地过滤即可（数量 <几百 时 perf 完全够），不上后端。
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(null);
  /** 终态组（done/cancelled）独立的"展开全部"开关 */
  const [expandedTerminal, setExpandedTerminal] = useState<Record<string, boolean>>({});
  /** 当前激活的状态 tab（默认「全部」总览） */
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

  // WS：task:* 与 requirement:* 变化（创建 / 更新 / transition / 删除）自动 refetch
  useEffect(() => {
    const unsubT = subscribe("task:*", () => refresh());
    const unsubR = subscribe("requirement:*", () => refresh());
    return () => { unsubT(); unsubR(); };
  }, [subscribe]);

  // distinct workflow 列表（用于 chip 筛选）— 来自当前 tasks
  const allWorkflows = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.workflow) set.add(t.workflow);
    return [...set].sort();
  }, [tasks]);

  // search + workflow chip 过滤后的任务集
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

  // 需求只按搜索过滤（workflow chip 不适用于需求）
  const filteredRequirements = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // workflow 筛选激活时，用户聚焦任务视角 —— 需求段隐藏，避免干扰
    if (workflowFilter) return [];
    if (!q) return requirements;
    return requirements.filter((r) =>
      (r.id ?? "").toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q),
    );
  }, [requirements, searchQuery, workflowFilter]);

  const groups = useMemo<Group[]>(() => {
    // ── 需求阶段（前置） ──
    const draft: Requirement[] = [];
    const investigating: Requirement[] = [];
    const awaitingApproval: Requirement[] = [];
    for (const r of filteredRequirements) {
      if (r.status === "draft") draft.push(r);
      else if (r.status === "investigating") investigating.push(r);
      else if (r.status === "awaiting_approval") awaitingApproval.push(r);
    }
    const sortReq = (arr: Requirement[]) => arr.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

    // ── 任务阶段 ──
    const running: Task[] = [];
    const awaiting: Task[] = [];
    const failed: Task[] = [];
    const pending: Task[] = [];
    const done: Task[] = [];
    const cancelled: Task[] = [];
    for (const t of filteredTasks) {
      const s = t.status;
      if (s.startsWith("running_")) running.push(t);
      else if (s.startsWith("awaiting_")) awaiting.push(t);
      else if (s === "failed" || s.startsWith("failed_")) failed.push(t);
      else if (s.startsWith("pending_")) pending.push(t);
      else if (s === "done") done.push(t);
      else if (s === "cancelled" || s === "canceled") cancelled.push(t);
    }
    const sortDesc = (arr: Task[]) =>
      arr.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    // 终态组（done/cancelled）：默认 slice(0, 20)，展开后给完整列表；活跃组不截断
    const sliceTerminal = (key: string, arr: Task[]) =>
      expandedTerminal[key] ? sortDesc(arr) : sortDesc(arr).slice(0, TERMINAL_PREVIEW_LIMIT);

    return [
      { key: "draft", label: "草稿", icon: FileText, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/30", kind: "req", reqs: sortReq(draft) },
      { key: "investigating", label: "调查中", icon: Search, iconClass: "text-info", borderClass: "border-l-info", kind: "req", reqs: sortReq(investigating) },
      { key: "awaiting_approval", label: "待审批", icon: Hand, iconClass: "text-warning", borderClass: "border-l-warning", kind: "req", reqs: sortReq(awaitingApproval) },
      { key: "running", label: "进行中", icon: Loader2, iconClass: "text-accent animate-spin", borderClass: "border-l-accent", kind: "task", tasks: sortDesc(running) },
      { key: "awaiting", label: "等待人工", icon: Hand, iconClass: "text-warning", borderClass: "border-l-warning", kind: "task", tasks: sortDesc(awaiting) },
      { key: "failed", label: "失败需关注", icon: AlertCircle, iconClass: "text-destructive", borderClass: "border-l-destructive", kind: "task", tasks: sortDesc(failed) },
      { key: "pending", label: "待执行", icon: Clock, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/40", kind: "task", tasks: sortDesc(pending) },
      { key: "done", label: "已完成", icon: CheckCircle2, iconClass: "text-success", borderClass: "border-l-success", kind: "task", tasks: sliceTerminal("done", done) },
      { key: "cancelled", label: "已取消", icon: XCircle, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/30", kind: "task", tasks: sliceTerminal("cancelled", cancelled) },
    ];
  }, [filteredRequirements, filteredTasks, expandedTerminal]);

  // 各终态任务组的总数（不经截断），用于「看全部 N 条」按钮
  const terminalTotalCount = useMemo(() => {
    const out: Record<string, number> = { done: 0, cancelled: 0 };
    for (const t of filteredTasks) {
      if (t.status === "done") out.done += 1;
      else if (t.status === "cancelled" || t.status === "canceled") out.cancelled += 1;
    }
    return out;
  }, [filteredTasks]);

  /** 某组的计数（需求组取 reqs 长度；任务终态组取未截断总数） */
  const groupCount = (g: Group) =>
    g.kind === "req" ? (g.reqs?.length ?? 0) : (terminalTotalCount[g.key] ?? g.tasks?.length ?? 0);

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

      {/* 工具栏：搜索框 + workflow chip 过滤 — 只在有数据时显示 */}
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
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="rounded-md font-mono text-[10px] "
              >
                清除筛选
              </Button>
            )}
          </div>
          {allWorkflows.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">
                工作流
              </span>
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
          <p className="font-mono text-[10px] text-destructive mb-1">
            ERROR
          </p>
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

      {/* 有数据但过滤后空 — 引导清除筛选 */}
      {!loading && !error && hasAny && !filteredAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">没匹配的结果</p>
          <p className="mt-1 font-mono text-xs ">
            当前筛选条件下没有需求或任务
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={clearFilters}
            className="mt-3 rounded-md font-mono text-[10px] "
          >
            清除筛选
          </Button>
        </div>
      )}

      {/* 流水线：需求阶段 + 任务阶段 tab 分类，每类下整行列表 */}
      {!loading && !error && filteredAny && (
        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden">
            <TabsTrigger value="all" className="gap-1.5">
              <List className="h-3.5 w-3.5 text-foreground/70" />
              全部
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {groups.reduce((n, g) => n + groupCount(g), 0)}
              </span>
            </TabsTrigger>
            {groups.map((g) => {
              const Icon = g.icon;
              return (
                <TabsTrigger key={g.key} value={g.key} className="gap-1.5">
                  <Icon className={cn("h-3.5 w-3.5", g.iconClass)} />
                  {g.label}
                  <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {groupCount(g)}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {/* 全部：所有需求 + 任务行，按阶段顺序平铺 */}
          <TabsContent value="all">
            <ul className="space-y-1.5">
              {groups.flatMap((g) =>
                g.kind === "req"
                  ? (g.reqs ?? []).map((r) => (
                      <li key={`r-${r.id}`}>
                        <RequirementRow req={r} borderClass={g.borderClass} />
                      </li>
                    ))
                  : (g.tasks ?? []).map((t) => (
                      <li key={`t-${t.id}`}>
                        <TaskRow task={t} borderClass={g.borderClass} />
                      </li>
                    )),
              )}
            </ul>
          </TabsContent>
          {groups.map((g) => {
            const total = terminalTotalCount[g.key];
            const truncated = (g.key === "done" || g.key === "cancelled") && typeof total === "number" && total > (g.tasks?.length ?? 0);
            const items = g.kind === "req" ? (g.reqs ?? []) : (g.tasks ?? []);
            return (
              <TabsContent key={g.key} value={g.key}>
                {items.length > 0 ? (
                  <ul className="space-y-1.5">
                    {g.kind === "req"
                      ? g.reqs!.map((r) => (
                          <li key={r.id}>
                            <RequirementRow req={r} borderClass={g.borderClass} />
                          </li>
                        ))
                      : g.tasks!.map((t) => (
                          <li key={t.id}>
                            <TaskRow task={t} borderClass={g.borderClass} />
                          </li>
                        ))}
                  </ul>
                ) : (
                  <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">
                    {g.kind === "req" ? "此阶段暂无需求" : "此分类下暂无任务"}
                  </p>
                )}
                {truncated && (
                  <button
                    type="button"
                    onClick={() => setExpandedTerminal((prev) => ({ ...prev, [g.key]: true }))}
                    className="mt-2 w-full rounded-lg border border-dashed border-border py-1.5 text-center font-mono text-[10px] text-muted-foreground hover:border-accent/60 hover:text-foreground"
                  >
                    看全部 {total} 条 →
                  </button>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}

function RequirementRow({ req, borderClass }: { req: Requirement; borderClass: string }) {
  return (
    <Link
      to={`/requirements/${req.id}`}
      className={cn(
        "flex items-center gap-4 rounded-lg border border-l-4 border-border bg-card px-4 py-2.5 transition-colors hover:border-accent",
        borderClass,
      )}
    >
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{req.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{req.title}</span>
      {req.task_id && (
        <span
          className="hidden shrink-0 font-mono text-[10px] text-muted-foreground md:inline"
          title={`已派生任务 ${req.task_id}`}
        >
          {req.task_id} →
        </span>
      )}
    </Link>
  );
}

function TaskRow({ task, borderClass }: { task: Task; borderClass: string }) {
  const phaseFromStatus = parsePhase(task.status);
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        "flex items-center gap-4 rounded-lg border border-l-4 border-border bg-card px-4 py-2.5 transition-colors hover:border-accent",
        borderClass,
      )}
    >
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{task.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
      <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
        {task.workflow}
        {phaseFromStatus && <span> · {phaseFromStatus}</span>}
      </span>
      {task.requirement_id && (
        <span
          className="hidden shrink-0 font-mono text-[10px] text-muted-foreground md:inline"
          title={`关联需求 ${task.requirement_id}`}
        >
          ← {task.requirement_id}
        </span>
      )}
    </Link>
  );
}

function parsePhase(status: string): string | null {
  const m = status.match(/^(?:running|pending|awaiting|failed)_(.+)$/);
  return m ? m[1] : null;
}
