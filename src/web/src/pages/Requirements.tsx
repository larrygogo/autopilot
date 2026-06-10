// 全局需求列表页（/requirements）：4 段 tab + 时间分组。
// 与流水线页（/tasks）并列，流水线展示需求+任务全景，需求页聚焦纯需求分类决策视图。
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, Archive, List, Search, X } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHero } from "@/components/PageHero";
import { TimeGroupedList, RequirementRow, type TimedRow } from "@/components/PipelineList";
import { tsToMs } from "@/lib/pipeline-time";
import { requirementTab } from "@/lib/requirement-buckets";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "human",    label: "等待人工", Icon: Hand,    iconClass: "text-warning" },
  { key: "running",  label: "运行中",   Icon: Loader2, iconClass: "text-accent" },
  { key: "archived", label: "归档",     Icon: Archive, iconClass: "text-muted-foreground" },
] as const;

export function Requirements() {
  const { subscribe } = useWebSocket();
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState("all");

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.listRequirements()
      .then(setRequirements)
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const unsub = subscribe("requirement:*", () => refresh());
    return unsub;
  }, [subscribe]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return requirements;
    return requirements.filter(
      (r) => r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q),
    );
  }, [requirements, searchQuery]);

  const now = Date.now();

  const buckets = useMemo(() => {
    const human: Requirement[] = [];
    const running: Requirement[] = [];
    const archived: Requirement[] = [];
    for (const r of filtered) {
      const t = requirementTab(r.status);
      if (t === "human") human.push(r);
      else if (t === "running") running.push(r);
      else archived.push(r);
    }
    return { human, running, archived };
  }, [filtered]);

  const toRows = (list: Requirement[]): TimedRow[] =>
    list
      .map((r) => ({ key: r.id, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} /> }))
      .sort((a, b) => b.ts - a.ts);

  const allRows = useMemo(
    () => [...toRows(buckets.human), ...toRows(buckets.running), ...toRows(buckets.archived)]
      .sort((a, b) => b.ts - a.ts),
    [buckets, now],
  );

  const hasAny = requirements.length > 0;
  const filteredAny = filtered.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        eyebrow="SHEET · REQUIREMENTS"
        title="需求"
        subtitle="全局需求视图 · 按进展分类"
        meta={[
          { k: "全部", v: requirements.length },
          { k: "等待人工", v: buckets.human.length },
          { k: "运行中", v: buckets.running.length },
        ]}
      />

      {hasAny && (
        <div className="mt-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索需求 ID / 标题"
              className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-7 font-mono text-xs focus:border-accent focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <Card className="mb-4 border-l-4 border-l-destructive px-4 py-3 mt-4">
          <p className="font-mono text-[10px] text-destructive mb-1">ERROR</p>
          <p className="text-sm">{error}</p>
        </Card>
      )}

      {loading && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs">加载需求...</p>
        </div>
      )}

      {!loading && !error && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">还没有需求</p>
          <p className="mt-1 font-mono text-xs">
            到{" "}
            <Link to="/library" className="underline">
              项目
            </Link>{" "}
            下创建第一个需求
          </p>
        </div>
      )}

      {!loading && !error && hasAny && !filteredAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">没有匹配的需求</p>
          <Button variant="outline" size="sm" onClick={() => setSearchQuery("")} className="mt-3 font-mono text-[10px]">
            清除搜索
          </Button>
        </div>
      )}

      {!loading && !error && filteredAny && (
        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="all" className="gap-1.5">
              <List className="h-3.5 w-3.5 text-foreground/70" />
              全部
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {allRows.length}
              </span>
            </TabsTrigger>
            {TABS.map(({ key, label, Icon, iconClass }) => {
              const rows = toRows(buckets[key as keyof typeof buckets]);
              return (
                <TabsTrigger key={key} value={key} className="gap-1.5">
                  <Icon className={cn("h-3.5 w-3.5", iconClass)} />
                  {label}
                  <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {rows.length}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="all">
            {allRows.length > 0 ? (
              <TimeGroupedList rows={allRows} now={now} />
            ) : (
              <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">暂无需求</p>
            )}
          </TabsContent>

          {TABS.map(({ key }) => {
            const rows = toRows(buckets[key as keyof typeof buckets]);
            return (
              <TabsContent key={key} value={key}>
                {rows.length > 0 ? (
                  <TimeGroupedList rows={rows} now={now} />
                ) : (
                  <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">
                    此分类下暂无需求
                  </p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}
