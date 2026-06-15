// L2a 键值描述列表：详情页 meta 展示的唯一形态。
// 规范见 docs/web-components.md §2.2。
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DescItem {
  label: ReactNode;
  value: ReactNode;
  /** 值用 mono 字体（id / 内核名 / 路径） */
  mono?: boolean;
}

const COLS = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3",
  4: "grid-cols-1 gap-x-6 sm:grid-cols-2 md:grid-cols-4",
} as const;

export function DescList({
  items,
  columns = 4,
  dense,
  className,
}: {
  items: DescItem[];
  columns?: keyof typeof COLS;
  dense?: boolean;
  className?: string;
}) {
  return (
    <dl className={cn("grid gap-x-6", COLS[columns], dense ? "gap-y-1" : "gap-y-2", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">{it.label}</dt>
          <dd className={cn("truncate text-sm", it.mono && "font-mono")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
