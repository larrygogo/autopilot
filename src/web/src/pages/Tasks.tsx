import { useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/pro";
import { Link } from "react-router-dom";
import { Loader2, Search, X } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { RequirementPipeline } from "@/components/RequirementPipeline";
import { type PipelineNameMaps } from "@/components/PipelineList";

/**
 * 流水线 — 需求全生命周期全景（**全部项目**）。
 *
 * 与「项目详情页的需求列表」共用 <RequirementPipeline>，唯一差别是范围（这里是全部需求）。
 * 每个需求一行（需求中心）；执行 / run 细节进需求详情页看，本页不铺 task 行。
 * 4 段 tab：全部（= 等待人工 + 运行中，不含归档）/ 等待人工 / 运行中 / 归档（已完成 / 已取消）。
 * Now 仍独立留给"需要你拍板"的决策收件箱。
 */
export function Tasks() {
  const { subscribe } = useWebSocket();
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(null);
  /** id → 名称映射（行卡显示项目名/仓库别名/工作流中文），一次性拉取 */
  const [nameMaps, setNameMaps] = useState<PipelineNameMaps>({});

  useEffect(() => {
    Promise.all([
      api.listProjects().catch(() => []),
      api.listWorkspaces().catch(() => []),
      api.listWorkflows().catch(() => []),
    ]).then(([projects, workspaces, workflows]) => {
      setNameMaps({
        projects: Object.fromEntries(projects.map((x) => [x.id, x.name])),
        workspaces: Object.fromEntries(workspaces.map((x) => [x.id, x.alias])),
        workflows: Object.fromEntries(workflows.map((x) => [x.name, x.label ?? x.name])),
      });
    });
  }, []);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.listRequirements()
      .then((rlist) => setRequirements(rlist as Requirement[]))
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  // WS：task:* 影响需求状态（经 bridge），requirement:* 直接变化 —— 两者都 refetch 需求
  useEffect(() => {
    const unsubT = subscribe("task:*", () => refresh());
    const unsubR = subscribe("requirement:*", () => refresh());
    return () => { unsubT(); unsubR(); };
  }, [subscribe]);

  // 工作流名（null = 默认 dev）
  const reqWorkflow = (r: Requirement): string => r.workflow ?? "dev";

  const allWorkflows = useMemo(() => {
    const set = new Set<string>();
    for (const r of requirements) set.add(reqWorkflow(r));
    return [...set].sort();
  }, [requirements]);

  const filteredRequirements = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return requirements.filter((r) => {
      if (workflowFilter && reqWorkflow(r) !== workflowFilter) return false;
      if (!q) return true;
      return (
        (r.id ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q) ||
        reqWorkflow(r).toLowerCase().includes(q)
      );
    });
  }, [requirements, searchQuery, workflowFilter]);

  const now = Date.now();
  const hasAny = requirements.length > 0;
  const filterActive = !!searchQuery.trim() || !!workflowFilter;
  const clearFilters = () => { setSearchQuery(""); setWorkflowFilter(null); };

  return (
    <PageShell
      width="content"
      hero={{
        title: "流水线",
        subtitle: "需求全生命周期 · 一条工作从提出到跑完",
        meta: [
          { k: "需求", v: requirements.length },
          ...(filterActive ? [{ k: "匹配", v: filteredRequirements.length }] : []),
        ],
      }}
    >
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
                placeholder="搜需求标题 / 工作流"
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
                    {nameMaps.workflows?.[w] ?? w}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && (
        <Card className="mb-4 px-4 py-3">
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
          <p className="text-lg font-medium">还没有需求</p>
          <p className="mt-1 font-mono text-xs ">
            去 <Link to="/library" className="underline">项目</Link> 挂个需求，或从 <Link to="/start" className="underline">开始</Link> 页发包
          </p>
        </div>
      )}

      {!loading && !error && hasAny && (
        <RequirementPipeline
          requirements={filteredRequirements}
          now={now}
          nameMaps={nameMaps}
          emptyHint={filterActive ? "没有匹配的需求" : "流水线暂无内容"}
        />
      )}
    </PageShell>
  );
}
