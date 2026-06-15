// 工作流目录：与项目库同款的实体目录模板（EntityCards）。
// 整卡点击 = 查看详情；导出 / 克隆收进右上 ⋯ 菜单；grid / list 视图记住偏好。
import { useEffect, useMemo, useState } from "react";
import { Plus, Download, Copy, MoreHorizontal, GitBranch } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { statusVisual, toneToTextClass } from "@/lib/status-style";
import { EmptyState, EntityGrid, EntityList, ViewToggle, useViewMode, type EntityCardItem } from "@/components/pro";

interface WorkflowInfo {
  name: string;
  label?: string;
  description: string;
  source?: "db" | "file";
}

interface TaskItem {
  id: string;
  workflow: string;
  status: string;
  updated_at?: string;
}

interface UsageStat {
  count: number;
  latestAt?: number;  // epoch ms
  latestStatus?: string;
}

interface Props {
  workflows: WorkflowInfo[];
  onSelect: (name: string) => void;
  onClone: (sourceName: string) => void;
  onNew: () => void;
}

function statusIcon(status: string | undefined): { icon: string; color: string } {
  const vis = statusVisual(status);
  return { icon: vis.glyph, color: toneToTextClass(vis.tone) };
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "刚才";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

export function WorkflowCatalog({ workflows, onSelect, onClone, onNew }: Props) {
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [view, setView] = useViewMode("workflows.catalog.view");

  useEffect(() => {
    api.listTasks()
      .then((list) => setTasks(list as TaskItem[]))
      .catch(() => setTasks([]));
  }, []);

  async function exportBundle(name: string) {
    try {
      const bundle = await api.exportWorkflowBundle(name);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.workflow.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${name}.workflow.json`);
    } catch (e: unknown) {
      toast.error("导出失败", (e as Error)?.message ?? String(e));
    }
  }

  const usage = useMemo<Map<string, UsageStat>>(() => {
    const map = new Map<string, UsageStat>();
    for (const t of tasks) {
      if (!t.workflow) continue;
      const cur = map.get(t.workflow) ?? { count: 0 };
      cur.count += 1;
      const ts = t.updated_at ? new Date(t.updated_at).getTime() : NaN;
      if (Number.isFinite(ts) && (!cur.latestAt || ts > cur.latestAt)) {
        cur.latestAt = ts;
        cur.latestStatus = t.status;
      }
      map.set(t.workflow, cur);
    }
    return map;
  }, [tasks]);

  const workflowMenu = (name: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`工作流 ${name} 操作`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem className="gap-2" onSelect={() => void exportBundle(name)}>
          <Download className="h-3.5 w-3.5" />
          导出 JSON
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2" onSelect={() => onClone(name)}>
          <Copy className="h-3.5 w-3.5" />
          克隆
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const items: EntityCardItem[] = workflows.map((wf) => {
    const stat = usage.get(wf.name);
    const si = stat ? statusIcon(stat.latestStatus) : statusIcon(undefined);
    return {
      key: wf.name,
      title: wf.label || wf.name,
      subtitle: wf.name,
      description: wf.description || "（无描述）",
      meta: (
        <span className="flex items-center gap-2">
          <span>被 {stat?.count ?? 0} 个任务用过</span>
          {stat?.latestAt && (
            <>
              <span>·</span>
              <span className={cn("flex items-center gap-1", si.color)}>
                <span>{si.icon}</span>
                <span className="text-muted-foreground">{formatRelativeTime(stat.latestAt)}</span>
              </span>
            </>
          )}
        </span>
      ),
      menu: workflowMenu(wf.name),
      icon: GitBranch,
      onOpen: () => onSelect(wf.name),
    };
  });

  if (workflows.length === 0) {
    return (
      <EmptyState
        size="page"
        icon={GitBranch}
        title="还没有工作流"
        hint="从内置模板克隆一个，或用 AI 按描述生成"
        action={
          <Button onClick={onNew} className="rounded-md text-[11px]">
            <Plus className="mr-1 h-3.5 w-3.5" /> 从模板创建第一个
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="bp-label text-muted-foreground">共 {workflows.length} 个工作流</p>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {view === "grid" ? <EntityGrid items={items} /> : <EntityList items={items} />}
    </div>
  );
}
