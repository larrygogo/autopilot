import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 蓝图风 Dialog：
 * - 全方角 + 2px 厚边框
 * - 内嵌四角对齐标记（registration marks）
 * - 标题 display 字体 + 大写 + 字距
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** 四角对齐标记（registration marks）—— 蓝图标志元素。mobile 下隐藏让出内容宽。 */
function RegMarks() {
  const base = "hidden sm:block absolute w-3.5 h-3.5 opacity-60 pointer-events-none";
  const v = "absolute left-1/2 top-0 bottom-0 w-px bg-foreground -translate-x-1/2";
  const h = "absolute top-1/2 left-0 right-0 h-px bg-foreground -translate-y-1/2";
  return (
    <>
      <span className={cn(base, "top-2 left-2")}>
        <span className={v} />
        <span className={h} />
      </span>
      <span className={cn(base, "top-2 right-2")}>
        <span className={v} />
        <span className={h} />
      </span>
      <span className={cn(base, "bottom-2 left-2")}>
        <span className={v} />
        <span className={h} />
      </span>
      <span className={cn(base, "bottom-2 right-2")}>
        <span className={v} />
        <span className={h} />
      </span>
    </>
  );
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean; hideRegMarks?: boolean }
>(({ className, children, hideClose, hideRegMarks, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-none border-2 border-foreground bg-card p-4 sm:p-8 sm:w-full duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain",
        "shadow-[6px_6px_0_0_var(--color-foreground)]",
        className,
      )}
      {...props}
    >
      {!hideRegMarks && <RegMarks />}
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-none p-1 border border-transparent opacity-70 transition-all hover:opacity-100 hover:border-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-left pb-3 border-b border-dashed border-foreground/30",
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 pt-3 border-t border-dashed border-foreground/30",
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "font-display text-xl font-bold uppercase tracking-wide leading-none",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
