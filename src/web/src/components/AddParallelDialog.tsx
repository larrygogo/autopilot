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
import { Plus, Trash2 } from "lucide-react";

export interface NewParallelData {
  name: string;
  failStrategy: string;
  children: Array<{ name: string; timeout: number }>;
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

interface ChildRow {
  name: string;
  timeout: number;
}

const DEFAULT_CHILDREN: ChildRow[] = [
  { name: "", timeout: 900 },
  { name: "", timeout: 900 },
];

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
  const [children, setChildren] = useState<ChildRow[]>(DEFAULT_CHILDREN);
  const [insertAfter, setInsertAfter] = useState(topCount - 1);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setFailStrategy("cancel_all");
    setChildren(DEFAULT_CHILDREN.map((c) => ({ ...c })));
    setInsertAfter(topCount - 1);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const nameValid = NAME_RE.test(name);
  const nameUnique = !existingNames.includes(name);
  const nameError =
    name && !nameValid
      ? "须以小写字母开头，仅含小写字母 / 数字 / _"
      : name && !nameUnique
        ? "名称已被占用"
        : null;

  // 子阶段校验：每行 name 合法 + 全表唯一（含 dialog 内部行间）+ 不跟外部冲突 + timeout > 0
  const childErrors: (string | null)[] = children.map((c, i) => {
    if (!c.name) return null; // 空行不算错；提交时按"至少 1 个填了"的规则
    if (!NAME_RE.test(c.name)) return "格式非法";
    if (existingNames.includes(c.name)) return "名称已被占用";
    if (c.name === name) return "不能跟并行块同名";
    // 行间重复
    if (children.findIndex((other, j) => j !== i && other.name === c.name) >= 0) {
      return "与本表其它子阶段重名";
    }
    if (!Number.isFinite(c.timeout) || c.timeout <= 0) return "timeout 须为正整数";
    return null;
  });

  const filledChildren = children.filter((c) => c.name.trim() !== "");
  const allChildrenValid =
    filledChildren.length > 0 &&
    childErrors.every((e, i) => e === null && (children[i].name.trim() === "" || true)) &&
    filledChildren.every((c) => NAME_RE.test(c.name) && c.timeout > 0);

  const canSubmit = nameValid && nameUnique && allChildrenValid && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm({
        name,
        failStrategy,
        children: filledChildren.map((c) => ({ name: c.name, timeout: c.timeout })),
        insertAfter,
      });
      reset();
    } finally {
      setBusy(false);
    }
  };

  const updateChild = (idx: number, patch: Partial<ChildRow>) => {
    setChildren((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const addChildRow = () => {
    setChildren((prev) => [...prev, { name: "", timeout: 900 }]);
  };

  const removeChildRow = (idx: number) => {
    setChildren((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

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
            一次可以填多个并发执行的子阶段；后续也可在阶段编辑器中追加。
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>子阶段（至少 1 个）</Label>
              <Button variant="ghost" size="sm" onClick={addChildRow} disabled={busy}>
                <Plus className="h-3.5 w-3.5" />
                添加子阶段
              </Button>
            </div>
            <div className="space-y-1.5">
              {children.map((c, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex-1 space-y-0.5">
                    <Input
                      placeholder={`子阶段 ${i + 1} 名，例如 frontend`}
                      className={
                        childErrors[i]
                          ? "h-8 font-mono text-sm border-destructive focus-visible:ring-destructive"
                          : "h-8 font-mono text-sm"
                      }
                      value={c.name}
                      onChange={(e) => updateChild(i, { name: e.target.value })}
                    />
                    {childErrors[i] && (
                      <p className="text-[10px] text-destructive">{childErrors[i]}</p>
                    )}
                  </div>
                  <Input
                    type="number"
                    min={1}
                    placeholder="900"
                    value={c.timeout}
                    onChange={(e) => updateChild(i, { timeout: parseInt(e.target.value, 10) || 0 })}
                    className="h-8 w-24 font-mono text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeChildRow(i)}
                    disabled={children.length <= 1 || busy}
                    title={children.length <= 1 ? "至少保留 1 行" : "删除此行"}
                    className="h-8 px-2"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              第二列是超时秒数（默认 900）；删除空行不影响提交，只有填了 name 的行会被创建
            </p>
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
