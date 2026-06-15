// L2a 表单对话框骨架：标题/描述 + 字段区(children) + 内联错误条 + busy footer。
// 防双提交、busy 中禁关闭、Ctrl/⌘+Enter 提交；错误内联展示（toast 只作成功回执）。
// ⚠ 只是骨架——字段用 FormField 组装，不做 schema 驱动（docs/web-components.md §2.2）。
import { useState, type FormEvent, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitText = "保存",
  cancelText = "取消",
  danger,
  submitDisabled,
  onSubmit,
  children,
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  submitText?: string;
  cancelText?: string;
  /** 危险操作（提交按钮 destructive） */
  danger?: boolean;
  /** 额外的提交禁用条件（必填未填等） */
  submitDisabled?: boolean;
  /** 抛错 = 失败：错误内联展示、对话框保持打开；正常返回 = 成功：自动关闭 */
  onSubmit: () => Promise<void>;
  children: ReactNode;
  contentClassName?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || submitDisabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onOpenChange(false);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return; // busy 中禁 ESC/遮罩关闭
        if (!v) setError(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className={cn("sm:max-w-md", contentClassName)}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-4 py-4">{children}</div>
          {error && (
            <p className="mb-3 rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelText}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={danger ? "destructive" : "default"}
              disabled={busy || submitDisabled}
            >
              {busy ? "处理中…" : submitText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
