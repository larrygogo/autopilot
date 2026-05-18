import React from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { statusVisual } from "@/lib/status-style";

/**
 * 状态徽章 —— task / phase / requirement 通用。
 *
 * 走 status-style.ts 的 statusVisual() 拿 tone + label，Badge variant 名直接用 tone。
 * 当中文标签和原 status 字符串不同时挂 hover tooltip 展原 status（产品分层定位：
 * Web 是决策者面板，业务标签为主；懂行的自己可 hover 反查内核名）。
 */
export function StatusBadge({
  status,
  className,
  compact = false,
}: {
  status: string;
  className?: string;
  compact?: boolean;
}) {
  const vis = statusVisual(status);
  const hasInternalDiff = vis.label !== status;
  const badge = (
    <Badge
      variant={vis.tone}
      className={cn(
        "font-mono",
        compact ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]",
        hasInternalDiff && "cursor-help",
        className,
      )}
    >
      {vis.label}
    </Badge>
  );
  if (!hasInternalDiff) return badge;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="font-mono text-[10px]">{status}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
