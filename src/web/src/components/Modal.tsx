import React, { useEffect, useRef } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** 禁止遮罩点击关闭（例如保存中） */
  dismissable?: boolean;
}

export function Modal({ open, onClose, title, children, actions, size = "md", dismissable = true }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 把最新的 onClose / dismissable 存 ref，避免 ESC 监听 effect 因依赖变化重跑，
  // 从而意外抢走输入框焦点。
  const onCloseRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { dismissableRef.current = dismissable; }, [dismissable]);

  // 仅在 open 变化时：锁 body 滚动 + 对对话框容器抢焦点一次
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // ESC 监听：同样只随 open 变化注册/卸载
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissableRef.current) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="modal-overlay" onClick={() => dismissable && onClose()} />
      <div
        ref={dialogRef}
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          {dismissable && (
            <button
              type="button"
              className="modal-close"
              aria-label="关闭"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </>
  );
}

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
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissable={!busy}
      actions={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            className={`btn ${danger ? "btn-danger-solid" : "btn-primary"}`}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? "处理中..." : confirmText}
          </button>
        </>
      }
    >
      {message}
    </Modal>
  );
}
