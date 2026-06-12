// L2a 区块级加载骨架：替代区块内裸 spinner（「载有骨架」）。
// 规范见 docs/web-components.md §4。
import { cn } from "@/lib/utils";

export function SkeletonRows({
  count = 3,
  variant = "row",
  className,
}: {
  count?: number;
  /** row = 列表行式占位；card = 目录卡片式占位 */
  variant?: "row" | "card";
  className?: string;
}) {
  if (variant === "card") {
    return (
      <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="h-[150px] animate-pulse rounded-xl border border-border bg-muted/40" />
        ))}
      </div>
    );
  }
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl border border-border bg-muted/40" />
      ))}
    </div>
  );
}
