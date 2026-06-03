import * as React from "react";
import { TERMS, type TermKey } from "@/lib/terminology";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 业务标签 + 内核名 叠加展示。
 *
 * 三种形态（按 designer 规范）：
 *  - inline       (默认)：业务标签 + 虚线下划线，hover 弹 tooltip 出内核名 + 说明。用于 banner / 正文术语
 *  - withSubtitle：业务标签 + 下方 mono 小字内核名常驻可见。用于详情字段 label、对话框标题
 *  - plain：仅业务标签，无叠加。用于按钮文案、toast 等瞬时反馈
 */
interface TermProps {
  name: TermKey;
  variant?: "inline" | "withSubtitle" | "plain";
  className?: string;
}

export function Term({ name, variant = "inline", className }: TermProps) {
  const term = TERMS[name];

  if (variant === "plain") {
    return <span className={className}>{term.label}</span>;
  }

  if (variant === "withSubtitle") {
    return (
      <span className={cn("inline-flex flex-col leading-tight", className)}>
        <span>{term.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {term.internalName}
        </span>
      </span>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "border-b border-dotted border-muted-foreground/60 cursor-help",
              className,
            )}
          >
            {term.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-normal">
          <div className="space-y-0.5">
            <p>
              <span className="font-semibold">{term.label}</span>
              <span className="opacity-60"> · </span>
              <span>{term.internalName}</span>
            </p>
            <p className="opacity-70">{term.description}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
