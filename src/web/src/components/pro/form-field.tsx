// L2a 表单行排版件：Label + 控件 + hint + 错误。纯排版，不做受控/校验框架
//（本项目表单少而浅，schema 驱动是负资产——docs/web-components.md §2.2）。
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FormField({
  label,
  required,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  /** 辅助说明（灰字，错误出现时被 error 替代位置但同时保留） */
  hint?: ReactNode;
  /** 校验错误文案（destructive 色）；控件描边由调用方按需加 aria-invalid */
  error?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
