import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * 蓝图风按钮：
 * - 全方角（rounded-none）
 * - 1.5px 实线边框
 * - hover 时硬阴影 + 微抬升
 * - mono 字体 + 字距 + 大写（技术注记感）
 *
 * size 规范（关键）：所有 size 同高（h-9 = 36px）
 *   - default / sm / icon 一律 h-9，仅 padding 与字号不同
 *   - lg 用于真正的英雄按钮（h-11 = 44px），少用
 *   - 这样业务代码混用 size 不会破坏同行对齐
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none border-[1.5px] font-mono uppercase tracking-[0.12em] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background border-foreground hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[3px_3px_0_0_var(--color-accent)]",
        destructive:
          "bg-destructive text-destructive-foreground border-destructive hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[3px_3px_0_0_var(--color-foreground)]",
        outline:
          "border-foreground/40 bg-transparent text-foreground hover:bg-foreground/5 hover:border-foreground",
        secondary:
          "bg-secondary text-secondary-foreground border-foreground/30 hover:border-foreground hover:bg-secondary/70",
        ghost:
          "border-transparent text-foreground hover:bg-foreground/8 hover:border-foreground/30",
        link:
          "border-transparent text-accent normal-case underline-offset-4 hover:underline tracking-normal",
      },
      size: {
        /** 标准高度（h-9 = 36px）—— 大部分场景 */
        default: "h-9 px-4 text-xs",
        /** 紧凑：同高，字更小 padding 更紧（表格 / 工具栏） */
        sm: "h-9 px-3 text-[11px]",
        /** 英雄按钮：唯一例外的更大尺寸，少用 */
        lg: "h-11 px-6 text-sm tracking-[0.15em]",
        /** icon-only：同高方块 */
        icon: "h-9 w-9 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
