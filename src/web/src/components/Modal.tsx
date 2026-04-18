import React from "react";
import {
  Dialog as ShadcnDialog,
  DialogContent as ShadcnDialogContent,
  DialogHeader as ShadcnDialogHeader,
  DialogTitle as ShadcnDialogTitle,
  DialogFooter as ShadcnDialogFooter,
} from "@/components/ui/dialog";
import { Button as ShadcnButton } from "@/components/ui/button";

interface ConfirmProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
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
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const [busy, setBusy] = React.useState(false);

  const handleConfirm = async () => {
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
        <ShadcnDialogFooter>
          <ShadcnButton variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelText}
          </ShadcnButton>
          <ShadcnButton
            variant={danger ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmText}
          </ShadcnButton>
        </ShadcnDialogFooter>
      </ShadcnDialogContent>
    </ShadcnDialog>
  );
}
