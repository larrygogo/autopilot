import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 蓝图风输入框：
 * - 全方角 + 1.5px 实线边框
 * - 聚焦时边框变 accent 色（锈红 / 古金）
 * - mono 字体放给标签自己决定（这里保持 sans 主体）
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-none border-[1.5px] border-foreground/35 bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground placeholder:font-mono placeholder:text-xs placeholder:tracking-wider file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:border-accent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-none border-[1.5px] border-foreground/35 bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground placeholder:font-mono placeholder:text-xs placeholder:tracking-wider focus-visible:outline-none focus-visible:border-accent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
