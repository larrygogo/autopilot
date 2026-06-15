import React from "react";
import { cn } from "@/lib/utils";

/**
 * Supabase 式页头 —— 单行中号标题 + 副标 + 右侧操作区。
 *
 * 左侧：sans 标题（text-2xl）+ 副标 + 描述
 * 右侧：actions 按钮 + 可选 metadata（key/value 紧凑行）
 *
 * 早期的衬线 4xl~5xl hero + 装饰线已收敛（产品后台不是落地页）。
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
  /** 主标题，单行中号字 */
  title: React.ReactNode;
  /** 副标题，弱化灰 */
  subtitle?: React.ReactNode;
  /** 描述段，最多 2 行 */
  description?: React.ReactNode;
  /** 右侧 metadata，格式 [{k, v}, ...]；空数组不渲染 */
  meta?: Array<{ k: React.ReactNode; v: React.ReactNode }>;
  /** 右侧操作区（按钮等） */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-wrap items-start justify-between gap-x-8 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 bp-label text-muted-foreground/70">{eyebrow}</div>
        )}
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
        {description && (
          <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        {meta && meta.length > 0 && (
          <div className="flex flex-col items-end gap-0.5 text-xs">
            {meta.map((row, i) => (
              <div key={i} className="flex items-baseline gap-2">
                <span className="text-muted-foreground">{row.k}</span>
                <span className="text-foreground">{row.v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
