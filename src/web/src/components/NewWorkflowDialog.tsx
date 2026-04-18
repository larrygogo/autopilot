import React, { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (name: string) => void;
}

const NAME_RE = /^[a-z][a-z0-9_\-]{0,39}$/;
const PHASE_RE = /^[a-z][a-z0-9_]*$/;

export function NewWorkflowDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [firstPhase, setFirstPhase] = useState("step1");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setDescription("");
    setFirstPhase("step1");
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const nameValid = NAME_RE.test(name);
  const phaseValid = PHASE_RE.test(firstPhase);
  const canSubmit = nameValid && phaseValid && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.createWorkflow({
        name,
        description: description.trim() || undefined,
        firstPhase,
      });
      toast.success(`工作流 ${name} 已创建`);
      onCreated?.(name);
      reset();
      onClose();
    } catch (e: any) {
      toast.error("创建失败", e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submitting) close();
      }}
    >
      <DialogContent className="sm:max-w-lg" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>新建工作流</DialogTitle>
          <DialogDescription>
            脚手架会在 AUTOPILOT_HOME/workflows/ 下生成目录，含 workflow.yaml 与 workflow.ts。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="new-wf-name">
              名称 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-wf-name"
              className="font-mono"
              placeholder="例如：code_review"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <p
              className={
                name && !nameValid
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {name && !nameValid
                ? "需以小写字母开头，仅含小写字母 / 数字 / _ / -，长度 ≤ 40"
                : "工作流目录名，将创建 AUTOPILOT_HOME/workflows/<name>/"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-wf-desc">描述（可选）</Label>
            <Input
              id="new-wf-desc"
              placeholder="一句话说明这个工作流的用途"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-wf-phase">首阶段名</Label>
            <Input
              id="new-wf-phase"
              className="font-mono"
              value={firstPhase}
              onChange={(e) => setFirstPhase(e.target.value)}
            />
            <p
              className={
                firstPhase && !phaseValid
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {firstPhase && !phaseValid
                ? "需以小写字母开头，仅含小写字母 / 数字 / _"
                : "脚手架会生成对应的 run_<name> 阶段函数"}
            </p>
          </div>

          <div className="rounded-md border bg-muted/40 px-3 py-2.5">
            <p className="mb-1 text-xs text-muted-foreground">将生成文件：</p>
            <ul className="space-y-0.5 font-mono text-xs leading-relaxed">
              <li>
                AUTOPILOT_HOME/workflows/
                <span className="text-primary">{name || "<name>"}</span>/workflow.yaml
              </li>
              <li>
                AUTOPILOT_HOME/workflows/
                <span className="text-primary">{name || "<name>"}</span>/workflow.ts
              </li>
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            提示：
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              ⌘/Ctrl + Enter
            </kbd>{" "}
            快速提交。创建后可在「高级 (YAML)」中继续编辑。
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={submitting}>
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
