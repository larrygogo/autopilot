import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, Hand, AlertCircle, CheckCircle2, XCircle, Play, Clock, Search, X } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

interface Group {
  key: string;
  label: string;
  icon: typeof Loader2;
  iconClass: string;
  borderClass: string;
  /** 默认是否折叠 */
  collapsed?: boolean;
  tasks: Task[];
}

/**
 * 任务看板 — 按状态分组的全景视图。
 * Now 留给"需要决策"的事，任务的"在跑 / 待执行 / 失败 / 完成"细节在这里看。
 */
/** 终态组（done/cancelled）默认截断条数，超过时显示「看全部 N 条」按钮 */
const TERMINAL_PREVIEW_LIMIT = 20;

export function Tasks() {
  const { subscribe } = useWebSocket();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    done: true,
    cancelled: true,
  });
  // P0 断点修复：用过一段时间后任务积累到几十条，搜不到 / 筛不动。
  // 全量本地过滤即可（任务数 <几百 时 perf 完全够），不上后端。
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(null);
  /** 终态组（done/cancelled）独立的"展开全部"开关 */
  const [expandedTerminal, setExpandedTerminal] = useState<Record<string, boolean>>({});

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.listTasks()
      .then((list) => setTasks(list as Task[]))
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  // WS：task:* 变化（创建 / 更新 / transition / 删除）自动 refetch
  // 节流不需要 —— refresh 已 set loading 防抖
  useEffect(() => {
    const unsub = subscribe("task:*", () => refresh());
    return unsub;
  }, [subscribe]);

  // distinct workflow 列表（用于 chip 筛选）— 来自当前 tasks
  const allWorkflows = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.workflow) set.add(t.workflow);
    return [...set].sort();
  }, [tasks]);

  // search + workflow chip 过滤后的任务集，再交给分组逻辑
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

  const groups = useMemo<Group[]>(() => {
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
    // 各组内按 updated_at 倒序
    const sortDesc = (arr: Task[]) =>
      arr.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    // 终态组（done/cancelled）：默认 slice(0, 20)，展开后给完整列表；activeTasks 组不截断
    const sliceTerminal = (key: string, arr: Task[]) =>
      expandedTerminal[key] ? sortDesc(arr) : sortDesc(arr).slice(0, TERMINAL_PREVIEW_LIMIT);
    return [
      { key: "running", label: "进行中", icon: Loader2, iconClass: "text-accent animate-spin", borderClass: "border-l-accent", tasks: sortDesc(running) },
      { key: "awaiting", label: "等待人工", icon: Hand, iconClass: "text-warning", borderClass: "border-l-warning", tasks: sortDesc(awaiting) },
      { key: "failed", label: "失败需关注", icon: AlertCircle, iconClass: "text-destructive", borderClass: "border-l-destructive", tasks: sortDesc(failed) },
      { key: "pending", label: "待执行", icon: Clock, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/40", tasks: sortDesc(pending) },
      { key: "done", label: "已完成", icon: CheckCircle2, iconClass: "text-success", borderClass: "border-l-success", collapsed: true, tasks: sliceTerminal("done", done) },
      { key: "cancelled", label: "已取消", icon: XCircle, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/30", collapsed: true, tasks: sliceTerminal("cancelled", cancelled) },
    ];
  }, [filteredTasks, expandedTerminal]);

  // 各终态组的总数（不经截断），用于「看全部 N 条」按钮
  const terminalTotalCount = useMemo(() => {
    const out: Record<string, number> = { done: 0, cancelled: 0 };
    for (const t of filteredTasks) {
      if (t.status === "done") out.done += 1;
      else if (t.status === "cancelled" || t.status === "canceled") out.cancelled += 1;
    }
    return out;
  }, [filteredTasks]);

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));

  const filterActive = !!searchQuery.trim() || !!workflowFilter;
  const clearFilters = () => {
    setSearchQuery("");
    setWorkflowFilter(null);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        eyebrow="SHEET · TASKS · BOARD"
        title="任务看板"
        subtitle="按状态分组 · 跟踪每个 AI 任务的进度"
        meta={[
          { k: "总数", v: tasks.length },
          ...(filterActive ? [{ k: "匹配", v: filteredTasks.length }] : []),
        ]}
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {/* P0 工具栏：搜索框 + workflow chip 过滤 — 只在有任务时显示，新用户看不到 */}
      {tasks.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜任务 ID / 标题 / 工作流 / 需求 ID"
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

      {loading && tasks.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs ">加载任务...</p>
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">还没有任务</p>
          <p className="mt-1 font-mono text-xs ">
            从 <Link to="/start" className="underline">开始</Link> 页创建第一个任务
          </p>
        </div>
      )}

      {/* 有任务但过滤后空 — 引导清除筛选 */}
      {!loading && !error && tasks.length > 0 && filteredTasks.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">没匹配的任务</p>
          <p className="mt-1 font-mono text-xs ">
            当前筛选条件下没有任务
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

      <div className="mt-6 space-y-5">
        {groups.map((g) => {
          if (g.tasks.length === 0 && (g.key === "done" || g.key === "cancelled")) return null;
          const isCollapsed = collapsed[g.key] ?? false;
          const Icon = g.icon;
          // 终态组（done/cancelled）若有截断，给"看全部 N 条"按钮
          const total = terminalTotalCount[g.key];
          const truncated = (g.key === "done" || g.key === "cancelled") && typeof total === "number" && total > g.tasks.length;
          return (
            <section key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="mb-2 flex w-full items-center gap-2 border-b border-dashed border-border pb-2 text-left"
              >
                <Icon className={cn("h-4 w-4", g.iconClass)} />
                <h2 className="text-base font-bold">
                  {g.label}
                </h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ({total ?? g.tasks.length})
                </span>
                <span className="ml-auto">
                  {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </span>
              </button>
              {!isCollapsed && g.tasks.length > 0 && (
                <ul className="space-y-1.5">
                  {g.tasks.map((t) => (
                    <li key={t.id}>
                      <TaskRow task={t} borderClass={g.borderClass} />
                    </li>
                  ))}
                </ul>
              )}
              {!isCollapsed && truncated && (
                <button
                  type="button"
                  onClick={() => setExpandedTerminal((prev) => ({ ...prev, [g.key]: true }))}
                  className="mt-2 w-full border border-dashed border-border py-1.5 text-center font-mono text-[10px] text-muted-foreground hover:border-accent/60 hover:text-foreground"
                >
                  看全部 {total} 条 →
                </button>
              )}
              {!isCollapsed && g.tasks.length === 0 && (
                <p className="py-2 font-mono text-[11px] text-muted-foreground">（空）</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskRow({ task, borderClass }: { task: Task; borderClass: string }) {
  const phaseFromStatus = parsePhase(task.status);
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        "flex items-center gap-4 border border-l-4 border-border bg-card px-4 py-2.5 transition-colors hover:border-accent",
        borderClass,
      )}
    >
      <span className="font-mono text-[10px] text-muted-foreground">
        {task.id}
      </span>
      <span className="text-sm font-medium truncate flex-1">{task.title}</span>
      <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground shrink-0">
        {task.workflow}
        {phaseFromStatus && <span> · {phaseFromStatus}</span>}
      </span>
      {task.requirement_id && (
        <span
          className="hidden md:inline font-mono text-[10px] text-muted-foreground shrink-0"
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
