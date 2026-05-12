import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageLoader } from "@/components/PageLoader";
import { api } from "@/hooks/useApi";

const Projects = lazy(() => import("./Projects").then((m) => ({ default: m.Projects })));

const TABS = [
  { key: "projects", label: "项目" },
  { key: "history", label: "历史" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isValidTab(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

interface HistoryTask {
  id: string;
  title: string;
  workflow: string;
  status: string;
  updated_at: string;
  pr_url?: string | null;
}

function HistoryTab() {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [done, failed] = await Promise.all([
          api.listTasks({ status: "done" }) as Promise<HistoryTask[]>,
          api.listTasks({ status: "failed" }) as Promise<HistoryTask[]>,
        ]);
        if (cancelled) return;
        const merged = [...done, ...failed].sort((a, b) =>
          (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
        );
        setTasks(merged);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground font-mono text-xs uppercase tracking-[0.12em]">加载中...</div>;
  }
  if (error) {
    return (
      <div className="mt-4 border-[1.5px] border-l-4 border-foreground/30 border-l-destructive bg-card px-4 py-3 rounded-none">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive mb-1">ERROR</p>
        <p className="text-sm text-foreground">{error}</p>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <p className="font-display text-lg">暂无历史</p>
        <p className="mt-1 font-mono text-xs uppercase tracking-[0.12em]">完成的任务会出现在这里</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link
            to={`/tasks/${t.id}`}
            className="flex items-center gap-4 border-[1.5px] border-foreground/30 bg-card px-4 py-2.5 rounded-none hover:border-accent transition-colors"
          >
            <span className={`font-mono text-[10px] uppercase tracking-[0.18em] ${t.status === "done" ? "text-success" : "text-destructive"}`}>
              {t.status === "done" ? "DONE" : "FAILED"}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t.id}
            </span>
            <span className="font-display text-sm font-medium truncate flex-1">{t.title}</span>
            <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground shrink-0">
              {t.workflow}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Library() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const active: TabKey = isValidTab(raw) ? raw : "projects";

  const handleChange = (next: string) => {
    const np = new URLSearchParams(params);
    np.set("tab", next);
    setParams(np, { replace: true });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">库 · LIBRARY</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          项目 / 历史任务
        </p>
      </header>

      <Tabs value={active} onValueChange={handleChange}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <Suspense fallback={<PageLoader />}>
          <TabsContent value="projects">
            <Projects />
          </TabsContent>
          <TabsContent value="history">
            <HistoryTab />
          </TabsContent>
        </Suspense>
      </Tabs>
    </div>
  );
}
