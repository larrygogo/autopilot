import React, { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface NewPhaseData {
  name: string;
  timeout: number;
  insertAfter: number; // -1 = head, otherwise 0-based index
}

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: NewPhaseData) => void | Promise<void>;
  existingNames: string[];
  /** 当前阶段列表长度，用于插入位置选项 */
  count: number;
}

export function AddPhaseDialog({ open, onClose, onConfirm, existingNames, count }: Props) {
  const [name, setName] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(900);
  const [insertAfter, setInsertAfter] = useState<number>(count - 1);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setTimeoutSec(900);
    setInsertAfter(count - 1);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const nameValid = PHASE_NAME_RE.test(name);
  const nameUnique = !existingNames.includes(name);
  const canSubmit = nameValid && nameUnique && timeoutSec > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm({ name, timeout: timeoutSec, insertAfter });
      reset();
    } finally {
      setBusy(false);
    }
  };

  const nameError =
    name && !nameValid
      ? "须以小写字母开头，仅含小写字母 / 数字 / _"
      : name && !nameUnique
        ? "该阶段名已存在"
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增阶段</DialogTitle>
          <DialogDescription>添加一个新阶段到工作流中。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="add-phase-name">
              阶段名 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="add-phase-name"
              className={
                nameError
                  ? "font-mono border-destructive focus-visible:ring-destructive"
                  : "font-mono"
              }
              placeholder="例如：review"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <p
              className={
                nameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"
              }
            >
              {nameError ?? "将自动生成 run_<阶段名> 函数"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-phase-timeout">超时（秒）</Label>
            <Input
              id="add-phase-timeout"
              type="number"
              min={1}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(parseInt(e.target.value, 10) || 0)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>插入位置</Label>
            <Select
              value={String(insertAfter)}
              onValueChange={(v) => setInsertAfter(parseInt(v, 10))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="-1">插入到开头</SelectItem>
                {existingNames.map((n, i) => (
                  <SelectItem key={n} value={String(i)}>
                    在「{n}」之后
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? "保存中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
