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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface NewParallelData {
  name: string;
  failStrategy: string;
  firstChild: string;
  firstChildTimeout: number;
  insertAfter: number; // -1 = head, otherwise 0-based index of top-level
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const STRATEGIES = ["cancel_all", "continue"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: NewParallelData) => void | Promise<void>;
  /** 所有已有阶段名（含并行块内），防重名 */
  existingNames: string[];
  /** 顶层条目数量 */
  topCount: number;
  /** 顶层条目显示名（用于"在 X 之后"） */
  topLabels: string[];
}

export function AddParallelDialog({
  open,
  onClose,
  onConfirm,
  existingNames,
  topCount,
  topLabels,
}: Props) {
  const [name, setName] = useState("");
  const [failStrategy, setFailStrategy] = useState<string>("cancel_all");
  const [firstChild, setFirstChild] = useState("");
  const [firstChildTimeout, setFirstChildTimeout] = useState(900);
  const [insertAfter, setInsertAfter] = useState(topCount - 1);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setFailStrategy("cancel_all");
    setFirstChild("");
    setFirstChildTimeout(900);
    setInsertAfter(topCount - 1);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const nameValid = NAME_RE.test(name);
  const nameUnique = !existingNames.includes(name);
  const childValid = NAME_RE.test(firstChild);
  const childUnique = firstChild !== name && !existingNames.includes(firstChild);
  const canSubmit =
    nameValid && nameUnique && childValid && childUnique && firstChildTimeout > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm({ name, failStrategy, firstChild, firstChildTimeout, insertAfter });
      reset();
    } finally {
      setBusy(false);
    }
  };

  const nameError =
    name && !nameValid
      ? "须以小写字母开头，仅含小写字母 / 数字 / _"
      : name && !nameUnique
        ? "名称已被占用"
        : null;

  const childError =
    firstChild && !childValid
      ? "格式非法"
      : firstChild && !childUnique
        ? "名称已被占用"
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新增并行块</DialogTitle>
          <DialogDescription>
            并行块至少需要 1 个子阶段；后续可在阶段编辑器中追加更多。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="add-par-name">
              并行块名 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="add-par-name"
              className={
                nameError
                  ? "font-mono border-destructive focus-visible:ring-destructive"
                  : "font-mono"
              }
              placeholder="例如：development"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <p
              className={
                nameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"
              }
            >
              {nameError ?? "在状态图中作为分叉节点名；不会生成 run_ 函数"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>失败策略</Label>
            <Select value={failStrategy} onValueChange={setFailStrategy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold">cancel_all</span>
              ：任一子阶段失败则全部中止；
              <span className="font-semibold">continue</span>
              ：失败后其他子阶段继续运行。
            </p>
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
                {topLabels.map((l, i) => (
                  <SelectItem key={i} value={String(i)}>
                    在「{l}」之后
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <p className="text-xs text-muted-foreground">
            并行块必须至少包含 1 个子阶段。请填写第一个子阶段：
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-par-child">
                子阶段名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="add-par-child"
                className={
                  childError
                    ? "font-mono border-destructive focus-visible:ring-destructive"
                    : "font-mono"
                }
                placeholder="例如：frontend"
                value={firstChild}
                onChange={(e) => setFirstChild(e.target.value)}
              />
              {childError && <p className="text-xs text-destructive">{childError}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-par-timeout">超时（秒）</Label>
              <Input
                id="add-par-timeout"
                type="number"
                min={1}
                value={firstChildTimeout}
                onChange={(e) => setFirstChildTimeout(parseInt(e.target.value, 10) || 0)}
              />
            </div>
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
