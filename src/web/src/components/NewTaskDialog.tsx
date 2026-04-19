import React, { useEffect, useState } from "react";
import { api } from "@/hooks/useApi";
import { useToast } from "./Toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Clock, CalendarClock, Repeat } from "lucide-react";

interface Workflow {
  name: string;
  description?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
  onScheduled?: (scheduleId: string) => void;
}

type ScheduleKind = "once" | "cron";

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "每天 09:00", expr: "0 9 * * *" },
  { label: "每工作日 09:00", expr: "0 9 * * 1-5" },
  { label: "每周一 09:00", expr: "0 9 * * 1" },
  { label: "每小时整点", expr: "0 * * * *" },
  { label: "每 15 分钟", expr: "*/15 * * * *" },
];

function defaultOnceLocal(): string {
  // 默认：当前时间 +1 小时，保留到分钟，格式 YYYY-MM-DDTHH:mm（datetime-local 输入格式）
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

export function NewTaskDialog({ open, onClose, onCreated, onScheduled }: Props) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWf, setLoadingWf] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // ── 定时相关 ──
  const [scheduled, setScheduled] = useState(false);
  const [kind, setKind] = useState<ScheduleKind>("once");
  const [runAtLocal, setRunAtLocal] = useState<string>(defaultOnceLocal());
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [scheduleName, setScheduleName] = useState("");
  const [resolvedTz, setResolvedTz] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setRequirement("");
    setScheduled(false);
    setKind("once");
    setRunAtLocal(defaultOnceLocal());
    setCronExpr("0 9 * * *");
    setScheduleName("");
    setLoadingWf(true);
    api
      .listWorkflows()
      .then((list) => {
        setWorkflows(list);
        if (list.length > 0 && !workflow) setWorkflow(list[0].name);
      })
      .catch((e) => toast.error("加载工作流失败", e?.message ?? String(e)))
      .finally(() => setLoadingWf(false));
    api
      .getDefaults()
      .then((res) => setResolvedTz(res.resolved_timezone))
      .catch(() => {});
  }, [open]);

  const canSubmit =
    !!workflow &&
    !!title.trim() &&
    !submitting &&
    (!scheduled || (kind === "once" ? !!runAtLocal : !!cronExpr.trim()));

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (!scheduled) {
        const task = await api.startTask({
          title: title.trim(),
          requirement: requirement.trim() || undefined,
          workflow,
        });
        toast.success(`任务已创建：${task.id}`);
        onCreated?.(task.id);
        onClose();
      } else {
        const name = scheduleName.trim() || title.trim();
        const body = {
          name,
          type: kind,
          workflow,
          title: title.trim(),
          requirement: requirement.trim() || null,
          run_at: kind === "once" ? new Date(runAtLocal).toISOString() : null,
          cron_expr: kind === "cron" ? cronExpr.trim() : null,
          enabled: true,
        };
        const sch = await api.createSchedule(body);
        const when =
          sch.next_run_at
            ? `下次：${new Date(sch.next_run_at).toLocaleString()}`
            : "未计算下次时间";
        toast.success(`定时任务已创建：${sch.name}（${when}）`);
        onScheduled?.(sch.id);
        onClose();
      }
    } catch (e: any) {
      toast.error(scheduled ? "创建定时任务失败" : "创建任务失败", e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>
            选择工作流，填写标题和需求；可选启用定时，一次性或周期性自动创建任务。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>
              工作流 <span className="text-destructive">*</span>
            </Label>
            {loadingWf ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : workflows.length === 0 ? (
              <p className="text-sm text-destructive">
                未发现工作流。请先在 <code className="font-mono">AUTOPILOT_HOME/workflows/</code> 下添加。
              </p>
            ) : (
              <Select value={workflow} onValueChange={setWorkflow}>
                <SelectTrigger>
                  <SelectValue placeholder="选择工作流" />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((wf) => (
                    <SelectItem key={wf.name} value={wf.name}>
                      <span className="font-medium">{wf.name}</span>
                      {wf.description ? (
                        <span className="ml-2 text-muted-foreground">— {wf.description}</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-task-title">
              标题 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-task-title"
              placeholder="一句话概括任务（任务列表里展示）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-task-requirement">需求详情（可选）</Label>
            <Textarea
              id="new-task-requirement"
              placeholder="在这里写完整需求 / 上下文 / 验收标准…&#10;支持多行 + Markdown，agent 会读取这里的内容作为执行依据。"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              className="min-h-[160px] font-mono text-xs"
            />
          </div>

          {/* 定时任务区块 */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="scheduled-switch" className="cursor-pointer">
                  定时任务
                </Label>
              </div>
              <Switch
                id="scheduled-switch"
                checked={scheduled}
                onCheckedChange={setScheduled}
              />
            </div>

            {scheduled && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <Label htmlFor="sch-name">定时名称（可选）</Label>
                  <Input
                    id="sch-name"
                    placeholder="默认取任务标题"
                    value={scheduleName}
                    onChange={(e) => setScheduleName(e.target.value)}
                  />
                </div>

                <Tabs value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="once" className="gap-1.5">
                      <CalendarClock className="h-3.5 w-3.5" /> 一次性
                    </TabsTrigger>
                    <TabsTrigger value="cron" className="gap-1.5">
                      <Repeat className="h-3.5 w-3.5" /> 周期性
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="once" className="space-y-1.5 pt-3">
                    <Label htmlFor="sch-runat">执行时刻</Label>
                    <Input
                      id="sch-runat"
                      type="datetime-local"
                      value={runAtLocal}
                      onChange={(e) => setRunAtLocal(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      到点自动创建一个新任务；仅执行一次。
                    </p>
                  </TabsContent>

                  <TabsContent value="cron" className="space-y-3 pt-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="sch-cron">Cron 表达式（5 字段：分 时 日 月 周）</Label>
                      <Input
                        id="sch-cron"
                        placeholder="0 9 * * *"
                        value={cronExpr}
                        onChange={(e) => setCronExpr(e.target.value)}
                        className="font-mono"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {CRON_PRESETS.map((p) => (
                        <Button
                          key={p.expr}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setCronExpr(p.expr)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      到点自动创建一个新任务；每次触发独立执行，上一次是否完成不影响。
                    </p>
                  </TabsContent>
                </Tabs>

                <p className="text-xs text-muted-foreground">
                  执行时区：
                  <span className="ml-1 font-mono">{resolvedTz || "—"}</span>
                  <span className="ml-2">
                    （在{" "}
                    <span className="font-medium">设置 → 常规偏好</span>
                    {" "}修改默认时区）
                  </span>
                </p>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            提示：<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘/Ctrl + Enter</kbd> 快速提交
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting
              ? scheduled
                ? "创建中…"
                : "创建中…"
              : scheduled
                ? "创建定时任务"
                : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
