import React from "react";
import { cn } from "@/lib/utils";

/**
 * 蓝图风列表页 hero —— 模仿 docs/architecture.html 的 title-block。
 *
 * 左侧：大写显示名 + 副标 + 中文描述
 * 右侧：可选 metadata 列表（key/value 表格）+ actions
 *
 * 仅用于列表页 / 仪表盘顶部。
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
  /** 顶部小型大写注记，如 "DRAWING N° AP-TASKS · ALL" */
  eyebrow?: React.ReactNode;
  /** 主标题，display 字体大写大号字 */
  title: React.ReactNode;
  /** 副标题，accent 色，display 字体中号 */
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
        "mb-8 grid gap-x-8 gap-y-4 border-b-[1.5px] border-foreground/30 pb-5 lg:grid-cols-[1.5fr_1fr]",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="h-px w-6 bg-foreground/40" aria-hidden="true" />
            <span>{eyebrow}</span>
            <span className="h-px flex-1 bg-foreground/20" aria-hidden="true" />
          </div>
        )}
        <h1 className="font-display text-4xl font-bold uppercase tracking-wider sm:text-5xl leading-[0.95]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 font-display text-sm font-medium uppercase tracking-[0.12em] text-accent">
            {subtitle}
          </p>
        )}
        {description && (
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:items-end">
        {meta && meta.length > 0 && (
          <div className="w-full border-[1.5px] border-foreground/30 bg-card/40 font-mono text-[11px]">
            {meta.map((row, i) => (
              <div
                key={i}
                className={cn(
                  "grid grid-cols-[100px_1fr]",
                  i !== meta.length - 1 && "border-b border-dashed border-foreground/25",
                )}
              >
                <div className="border-r border-dashed border-foreground/25 bg-muted/50 px-3 py-1.5 uppercase tracking-[0.18em] text-muted-foreground">
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
