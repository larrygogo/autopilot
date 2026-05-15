import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, Hand, AlertCircle, CheckCircle2, XCircle, Play, Clock } from "lucide-react";
import { api } from "@/hooks/useApi";
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
export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    done: true,
    cancelled: true,
  });

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.listTasks()
      .then((list) => setTasks(list as Task[]))
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const groups = useMemo<Group[]>(() => {
    const running: Task[] = [];
    const awaiting: Task[] = [];
    const failed: Task[] = [];
    const pending: Task[] = [];
    const done: Task[] = [];
    const cancelled: Task[] = [];
    for (const t of tasks) {
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
    return [
      { key: "running", label: "进行中", icon: Loader2, iconClass: "text-accent animate-spin", borderClass: "border-l-accent", tasks: sortDesc(running) },
      { key: "awaiting", label: "等待人工", icon: Hand, iconClass: "text-warning", borderClass: "border-l-warning", tasks: sortDesc(awaiting) },
      { key: "failed", label: "失败需关注", icon: AlertCircle, iconClass: "text-destructive", borderClass: "border-l-destructive", tasks: sortDesc(failed) },
      { key: "pending", label: "待执行", icon: Clock, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/40", tasks: sortDesc(pending) },
      { key: "done", label: "已完成", icon: CheckCircle2, iconClass: "text-success", borderClass: "border-l-success", collapsed: true, tasks: sortDesc(done).slice(0, 20) },
      { key: "cancelled", label: "已取消", icon: XCircle, iconClass: "text-muted-foreground", borderClass: "border-l-foreground/30", collapsed: true, tasks: sortDesc(cancelled).slice(0, 20) },
    ];
  }, [tasks]);

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        eyebrow="SHEET · TASKS · BOARD"
        title="任务看板"
        subtitle="按状态分组 · 跟踪每个 AI 任务的进度"
        meta={[{ k: "总数", v: tasks.length }]}
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {error && (
        <Card className="mb-4 border-l-4 border-l-destructive px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive mb-1">
            ERROR
          </p>
          <p className="text-sm">{error}</p>
        </Card>
      )}

      {loading && tasks.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.12em]">加载任务...</p>
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="font-display text-lg">还没有任务</p>
          <p className="mt-1 font-mono text-xs uppercase tracking-[0.12em]">
            从 <Link to="/start" className="underline">开始</Link> 页创建第一个任务
          </p>
        </div>
      )}

      <div className="mt-6 space-y-5">
        {groups.map((g) => {
          if (g.tasks.length === 0 && (g.key === "done" || g.key === "cancelled")) return null;
          const isCollapsed = collapsed[g.key] ?? false;
          const Icon = g.icon;
          return (
            <section key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="mb-2 flex w-full items-center gap-2 border-b border-dashed border-foreground/30 pb-2 text-left"
              >
                <Icon className={cn("h-4 w-4", g.iconClass)} />
                <h2 className="font-display text-base font-bold uppercase tracking-wider">
                  {g.label}
                </h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ({g.tasks.length})
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
        "flex items-center gap-4 border-[1.5px] border-l-4 border-foreground/30 bg-card px-4 py-2.5 transition-colors hover:border-accent",
        borderClass,
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {task.id}
      </span>
      <span className="font-display text-sm font-medium truncate flex-1">{task.title}</span>
      <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground shrink-0">
        {task.workflow}
        {phaseFromStatus && <span> · {phaseFromStatus}</span>}
      </span>
      {task.requirement_id && (
        <span
          className="hidden md:inline font-mono text-[10px] tracking-[0.08em] text-muted-foreground shrink-0"
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
