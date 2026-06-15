import { useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Hand, Loader2, Archive, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { tsToMs } from "@/lib/pipeline-time";
import { projectReqTab, type ProjectReqTab } from "@/lib/requirement-buckets";
import { TimeGroupedList, RequirementRow, type TimedRow, type PipelineNameMaps } from "@/components/PipelineList";
import type { Requirement } from "@/hooks/useApi";

const BUCKETS: { key: ProjectReqTab; label: string; Icon: typeof Loader2; iconClass: string }[] = [
  { key: "human", label: "等待人工", Icon: Hand, iconClass: "text-warning" },
  { key: "running", label: "运行中", Icon: Loader2, iconClass: "text-accent" },
  { key: "archived", label: "归档", Icon: Archive, iconClass: "text-muted-foreground" },
];

/**
 * 需求流水线视图 —— 流水线页（全部项目）与项目详情页（单项目）共用，**唯一差别是传入的
 * requirements 范围**。每个需求一行（RequirementRow）；执行 / run 细节进需求详情页看，不在此
 * 铺 task 行（需求中心，与隐藏 task id / 点击进需求 / 深链需求一脉相承）。
 *
 * 4 段 tab：全部（= 等待人工 + 运行中，**不含归档**）/ 等待人工 / 运行中 / 归档（已完成 / 已取消）。
 */
export function RequirementPipeline({
  requirements,
  now,
  nameMaps,
  emptyHint = "暂无内容",
}: {
  requirements: Requirement[];
  now: number;
  nameMaps?: PipelineNameMaps;
  emptyHint?: string;
}) {
  const [tab, setTab] = useState("all");

  const buckets = useMemo(() => {
    const b: Record<ProjectReqTab, Requirement[]> = { human: [], running: [], archived: [] };
    for (const r of requirements) b[projectReqTab(r.status)].push(r);
    return b;
  }, [requirements]);

  const rowsOf = (list: Requirement[]): TimedRow[] =>
    list
      .map((r) => ({ key: r.id, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} maps={nameMaps} /> }))
      .sort((a, b) => b.ts - a.ts);

  // 全部 = 活跃（等待人工 + 运行中），不含归档
  const allRows = useMemo(() => rowsOf([...buckets.human, ...buckets.running]), [buckets, now]);

  const Empty = () => (
    <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">{emptyHint}</p>
  );

  return (
    <Tabs value={tab} onValueChange={setTab} className="mt-6">
      <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden">
        <TabsTrigger value="all" className="gap-1.5">
          <List className="h-3.5 w-3.5 text-foreground/70" />
          全部
          <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{allRows.length}</span>
        </TabsTrigger>
        {BUCKETS.map((b) => (
          <TabsTrigger key={b.key} value={b.key} className="gap-1.5">
            <b.Icon className={cn("h-3.5 w-3.5", b.iconClass)} />
            {b.label}
            <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{buckets[b.key].length}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="all">
        {allRows.length > 0 ? <TimeGroupedList rows={allRows} now={now} /> : <Empty />}
      </TabsContent>
      {BUCKETS.map((b) => {
        const rows = rowsOf(buckets[b.key]);
        return (
          <TabsContent key={b.key} value={b.key}>
            {rows.length > 0 ? <TimeGroupedList rows={rows} now={now} /> : <Empty />}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
