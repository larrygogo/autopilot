// L2a 错误态卡：为什么（业务话）+ 内核错误原文（mono 折叠）+ 重试出口。
// 「业务标签叠加内核名」原则在错误展示上的落点：detail 默认折叠但永不丢弃。
// 规范见 docs/web-components.md §2.2 / §4。
import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function ErrorState({
  title,
  detail,
  onRetry,
  size = "section",
  className,
}: {
  /** 业务话的「为什么」（如「加载工作流详情失败」） */
  title: string;
  /** 内核错误原文（mono，默认折叠展示） */
  detail?: string;
  onRetry?: () => void;
  size?: "page" | "section";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      className={cn(
        "border-destructive/40",
        size === "page" ? "px-6 py-8" : "px-4 py-5",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <AlertCircle className={cn(size === "page" ? "h-7 w-7" : "h-5 w-5", "text-destructive")} />
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            错误详情
          </button>
        )}
        {detail && open && (
          <pre className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-left font-mono text-[11px] text-muted-foreground scrollbar-thin">
            {detail}
          </pre>
        )}
        {onRetry && (
          <Button variant="outline" size="sm" className="mt-1.5" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
        )}
      </div>
    </Card>
  );
}
