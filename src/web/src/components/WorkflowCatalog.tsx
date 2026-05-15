import { useEffect, useMemo, useState } from "react";
import { Plus, Download } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { statusVisual, toneToTextClass } from "@/lib/status-style";

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

  return (
    <div>
      {workflows.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">还没有工作流</p>
          <Button onClick={onNew} className="mt-3 rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
            <Plus className="mr-1 h-3.5 w-3.5" /> 从模板创建第一个
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {workflows.map((wf) => {
            const stat = usage.get(wf.name);
            const si = stat ? statusIcon(stat.latestStatus) : statusIcon(undefined);
            return (
              <Card key={wf.name} className="p-4">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <h3 className="font-mono text-sm font-bold truncate">{wf.label || wf.name}</h3>
                    {wf.label && (
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {wf.name}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {wf.description || "（无描述）"}
                </p>
                <div className="mt-3 flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
                  <span>被 {stat?.count ?? 0} 个任务用过</span>
                  {stat?.latestAt && (
                    <>
                      <span>·</span>
                      <span className={cn("flex items-center gap-1", si.color)}>
                        <span>{si.icon}</span>
                        <span className="text-muted-foreground">
                          {formatRelativeTime(stat.latestAt)}
                        </span>
                      </span>
                    </>
                  )}
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => exportBundle(wf.name)}
                    title="导出 JSON 文件（包含 yaml + ts，便于分享 / 备份）"
                    className="rounded-none font-mono text-[10px] uppercase tracking-[0.12em]"
                  >
                    <Download className="h-3 w-3" />
                    导出
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onClone(wf.name)}
                    className="rounded-none font-mono text-[10px] uppercase tracking-[0.12em]"
                  >
                    克隆
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onSelect(wf.name)}
                    className="rounded-none font-mono text-[10px] uppercase tracking-[0.12em]"
                  >
                    查看详情 →
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
