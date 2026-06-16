// L2a 实体详情页头：返回链接 + 标题 + mono 标识符 + 状态徽章 + 操作区。
// `identifier` 槽是「业务标签叠加内核名」产品原则的结构化落点——
// 标题显示业务名，内核 id/name 永远以 mono chip 叠加露出。
// 规范见 docs/web-components.md §2.2。
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function DetailHeader({
  back,
  title,
  identifier,
  status,
  actions,
  className,
}: {
  /** 返回导航（上一级列表页） */
  back: { to: string; label: string };
  title: ReactNode;
  /** 内核标识符（id / name），mono chip 叠加显示 */
  identifier?: ReactNode;
  /** 状态徽章区（StatusBadge 等） */
  status?: ReactNode;
  /** 右侧操作区 */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5", className)}>
      <Link
        to={back.to}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {back.label}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="break-words text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
          {identifier && (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {identifier}
            </code>
          )}
          {status}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
