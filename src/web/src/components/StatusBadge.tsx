import React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
  return (
    <Badge
      variant={tone}
      className={cn(
        "font-mono",
        compact ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]",
        className,
      )}
    >
      {status}
    </Badge>
  );
}
