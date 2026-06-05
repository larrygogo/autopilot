import React from "react";
import {
  Dialog as ShadcnDialog,
  DialogContent as ShadcnDialogContent,
  DialogHeader as ShadcnDialogHeader,
  DialogTitle as ShadcnDialogTitle,
  DialogFooter as ShadcnDialogFooter,
} from "@/components/ui/dialog";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfirmProps {
  open: boolean;
  title: React.ReactNode;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /**
   * 高危确认：传入后在弹窗内渲染一个输入框，用户必须原样输入该词（如项目名）
   * 才能点亮确认按钮。用于「删除项目」这类不可逆且代价高的操作。
   */
  confirmWord?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  confirmWord,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const [busy, setBusy] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  // 每次打开重置输入，避免上次残留
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const wordOk = !confirmWord || typed.trim() === confirmWord.trim();

  const handleConfirm = async () => {
    if (!wordOk) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ShadcnDialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onCancel();
      }}
    >
      <ShadcnDialogContent className="sm:max-w-sm">
        <ShadcnDialogHeader>
          <ShadcnDialogTitle>{title}</ShadcnDialogTitle>
        </ShadcnDialogHeader>
        <div className="text-sm text-foreground">{message}</div>
        {confirmWord && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              请输入{" "}
              <code className="rounded bg-muted px-1 font-mono text-foreground">{confirmWord}</code>{" "}
              以确认：
            </label>
            <Input
              autoFocus
              value={typed}
              placeholder={confirmWord}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && wordOk && !busy) void handleConfirm();
              }}
            />
          </div>
        )}
        <ShadcnDialogFooter>
          <ShadcnButton variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelText}
          </ShadcnButton>
          <ShadcnButton
            variant={danger ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={busy || !wordOk}
          >
            {busy ? "处理中…" : confirmText}
          </ShadcnButton>
        </ShadcnDialogFooter>
      </ShadcnDialogContent>
    </ShadcnDialog>
  );
}
