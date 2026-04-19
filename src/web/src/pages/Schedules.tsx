import React, { useEffect, useState, useCallback } from "react";
import {
  CalendarClock,
  Repeat,
  Play,
  Trash2,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { api, type Schedule } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface Props {
  onSelectTask?: (taskId: string) => void;
  subscribe?: (channel: string, onEvent: (event: any) => void) => () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function typeBadge(s: Schedule) {
  if (s.type === "once") {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <CalendarClock className="h-3 w-3" /> 一次性
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      <Repeat className="h-3 w-3" /> 周期性
    </Badge>
  );
}

export function Schedules({ onSelectTask, subscribe }: Props) {
  const toast = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .listSchedules()
      .then(setSchedules)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!subscribe) return;
    const unsub = subscribe("schedule:*", () => {
      refresh();
    });
    return unsub;
  }, [subscribe, refresh]);

  const toggleEnabled = async (s: Schedule, enabled: boolean) => {
    setBusy(s.id);
    try {
      await api.updateSchedule(s.id, { enabled });
      refresh();
    } catch (e: any) {
      toast.error("切换失败", e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (s: Schedule) => {
    setBusy(s.id);
    try {
      const res = await api.runScheduleNow(s.id);
      toast.success(`已触发一次：${s.name}（任务 ID: ${res.taskId}）`);
      refresh();
    } catch (e: any) {
      toast.error("触发失败", e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: Schedule) => {
    if (!confirm(`确定删除定时任务「${s.name}」？此操作不可撤销。`)) return;
    setBusy(s.id);
    try {
      await api.deleteSchedule(s.id);
      toast.success(`已删除：${s.name}`);
      refresh();
    } catch (e: any) {
      toast.error("删除失败", e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">定时任务</h2>
          <p className="text-sm text-muted-foreground">
            按计划自动创建任务。一次性触发后自动停用；周期性可通过开关随时暂停。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {loadError && (
        <Card className="border-destructive/50 p-4">
          <p className="text-sm text-destructive">加载失败：{loadError}</p>
        </Card>
      )}

      {!loading && schedules.length === 0 && !loadError && (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            暂无定时任务。在「新建任务」弹窗中打开「定时任务」开关即可创建。
          </p>
        </Card>
      )}

      <div className="space-y-2">
        {schedules.map((s) => (
          <Card key={s.id} className={cn("p-4", !s.enabled && "opacity-70")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium truncate">{s.name}</span>
                  {typeBadge(s)}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {s.id}
                  </Badge>
                  {!s.enabled && (
                    <Badge variant="outline" className="text-muted-foreground">
                      已停用
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                    <span>
                      工作流：<span className="font-mono text-foreground">{s.workflow}</span>
                    </span>
                    <span>
                      时区：<span className="font-mono text-foreground">{s.timezone}</span>
                    </span>
                    {s.type === "cron" && s.cron_expr && (
                      <span>
                        Cron：<span className="font-mono text-foreground">{s.cron_expr}</span>
                      </span>
                    )}
                  </div>
                  <div>任务标题：<span className="text-foreground">{s.title}</span></div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Switch
                  checked={s.enabled === 1}
                  disabled={busy === s.id}
                  onCheckedChange={(v) => toggleEnabled(s, v)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => runNow(s)}
                  disabled={busy === s.id}
                  title="立即执行一次"
                >
                  <Play className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => remove(s)}
                  disabled={busy === s.id}
                  title="删除"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Separator className="my-3" />

            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div>
                <div className="text-muted-foreground">下次执行</div>
                <div className="font-medium">{formatDate(s.next_run_at)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">上次执行</div>
                <div className="font-medium">{formatDate(s.last_run_at)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">已触发</div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.run_count} 次</span>
                  {s.last_task_id && onSelectTask && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto gap-1 p-0 text-xs"
                      onClick={() => onSelectTask(s.last_task_id!)}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {s.last_task_id}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
