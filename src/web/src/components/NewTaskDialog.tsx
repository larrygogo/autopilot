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

interface Workflow {
  name: string;
  description?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}

export function NewTaskDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWf, setLoadingWf] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setRequirement("");
    setLoadingWf(true);
    api
      .listWorkflows()
      .then((list) => {
        setWorkflows(list);
        if (list.length > 0 && !workflow) setWorkflow(list[0].name);
      })
      .catch((e) => toast.error("加载工作流失败", e?.message ?? String(e)))
      .finally(() => setLoadingWf(false));
  }, [open]);

  const canSubmit = !!workflow && !!title.trim() && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const task = await api.startTask({
        title: title.trim(),
        requirement: requirement.trim() || undefined,
        workflow,
      });
      toast.success(`任务已创建：${task.id}`);
      onCreated?.(task.id);
      onClose();
    } catch (e: any) {
      toast.error("创建任务失败", e?.message ?? String(e));
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
          <DialogDescription>选择工作流，填写本次任务的标题和需求详情。</DialogDescription>
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
            <p className="text-xs text-muted-foreground">
              留空则 agent 只看标题。Task ID 由系统自动生成。
            </p>
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
            {submitting ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
