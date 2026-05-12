import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * 蓝图风 Badge：
 * - 全方角 + 实色或细描边
 * - mono 字体 + 大写 + 字距，像工程图上的注记标签
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-none border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
  {
    variants: {
      variant: {
        default: "border-foreground bg-foreground text-background",
        secondary: "border-foreground/30 bg-secondary text-secondary-foreground",
        outline: "border-foreground/40 bg-transparent text-foreground",
        success: "border-success bg-success/15 text-success",
        warning: "border-warning bg-warning/15 text-warning",
        info: "border-info bg-info/15 text-info",
        destructive: "border-destructive bg-destructive/15 text-destructive",
        muted: "border-foreground/20 bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
