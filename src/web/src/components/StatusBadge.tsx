import React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Tone = NonNullable<BadgeProps["variant"]>;

function resolveTone(status: string): Tone {
  if (status === "done") return "success";
  if (status === "cancelled" || status === "canceled") return "muted";
  if (status === "failed" || status === "error") return "destructive";
  if (status.startsWith("awaiting")) return "warning";
  if (status.startsWith("running")) return "warning";
  if (status.startsWith("pending")) return "info";
  return "muted";
}

// 状态英文 → 中文映射；未命中则保留原值
const STATUS_LABELS: Record<string, string> = {
  pending: "待启动",
  queued: "已排队",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  error: "错误",
  cancelled: "已取消",
  canceled: "已取消",
  awaiting_approval: "等待审批",
  awaiting_review: "等待审阅",
  awaiting_input: "等待输入",
  investigating: "调查中",
  draft: "草稿",
};

function localizeStatus(status: string): string {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  // 通用前缀处理：awaiting_xxx / running_xxx / pending_xxx
  if (status.startsWith("awaiting_")) return `等待·${status.slice(9)}`;
  if (status.startsWith("running_")) return `运行·${status.slice(8)}`;
  if (status.startsWith("pending_")) return `待启动·${status.slice(8)}`;
  return status;
}

export function StatusBadge({
  status,
  className,
  compact = false,
}: {
  status: string;
  className?: string;
  compact?: boolean;
}) {
  const tone = resolveTone(status);
  const localized = localizeStatus(status);
  // 只有"业务标签"和"原内核名"不同时才挂 tooltip —— 否则 hover 不增信息（产品分层定位：
  // Web 是决策者面板，业务标签为主；懂行的自己可 hover 反查内核名）
  const hasInternalDiff = localized !== status;
  const badge = (
    <Badge
      variant={tone}
      className={cn(
        "font-mono",
        compact ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]",
        hasInternalDiff && "cursor-help",
        className,
      )}
    >
      {localized}
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
