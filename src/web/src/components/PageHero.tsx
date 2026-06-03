import React from "react";
import { cn } from "@/lib/utils";

/**
 * Claude 风列表页 hero —— 暖衬线大标题 + 副标 + 中文描述。
 *
 * 左侧：衬线显示名（Source Serif 4）+ 副标 + 中文描述
 * 右侧：可选 metadata 列表（key/value 表格）+ actions
 *
 * 仅用于列表页 / 仪表盘顶部。主标题刻意保留 font-display 衬线。
 */
export function PageHero({
  eyebrow,
  title,
  subtitle,
  description,
  meta,
  actions,
  className,
}: {
  /** 顶部小型 eyebrow 注记 */
  eyebrow?: React.ReactNode;
  /** 主标题，衬线大号字 */
  title: React.ReactNode;
  /** 副标题，accent 色 */
  subtitle?: React.ReactNode;
  /** 描述段，最多 2 行 */
  description?: React.ReactNode;
  /** 右上 metadata 表格，格式 [{k, v}, ...]；空数组不渲染 */
  meta?: Array<{ k: React.ReactNode; v: React.ReactNode }>;
  /** 右侧操作区（按钮等） */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-8 grid gap-x-8 gap-y-4 border-b border-border pb-5 lg:grid-cols-[1.5fr_1fr]",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-3 flex items-center gap-3 bp-label">
            <span className="h-px w-6 bg-border" aria-hidden="true" />
            <span>{eyebrow}</span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
        )}
        <h1 className="font-display text-4xl font-bold sm:text-5xl leading-[1.05]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 text-sm font-medium text-accent">
            {subtitle}
          </p>
        )}
        {description && (
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:items-end">
        {meta && meta.length > 0 && (
          <div className="w-full rounded-lg border border-border bg-card/40 font-mono text-[11px]">
            {meta.map((row, i) => (
              <div
                key={i}
                className={cn(
                  "grid grid-cols-[100px_1fr]",
                  i !== meta.length - 1 && "border-b border-border",
                )}
              >
                <div className="border-r border-border bg-muted/50 px-3 py-1.5 text-muted-foreground">
                  {row.k}
                </div>
                <div className="px-3 py-1.5 text-foreground">{row.v}</div>
              </div>
            ))}
          </div>
        )}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
