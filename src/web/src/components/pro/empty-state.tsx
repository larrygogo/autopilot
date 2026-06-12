// L2a 空态卡：空态必须告诉用户「下一步做什么」——action 槽非装饰。
// 规范见 docs/web-components.md §2.2 / §4。
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const SIZE = {
  /** 整页空态（页面主内容区为空） */
  page: { wrap: "px-6 py-12", icon: "h-8 w-8", title: "text-sm font-medium", hint: "text-xs" },
  /** 区块空态（卡片/面板内） */
  section: { wrap: "px-4 py-8", icon: "h-6 w-6", title: "text-sm font-medium", hint: "text-xs" },
  /** 行内空态（小面板/列表槽位） */
  inline: { wrap: "px-3 py-4", icon: "h-4 w-4", title: "text-xs", hint: "text-[11px]" },
} as const;

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  size = "section",
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  /** 引导动作（CTA 按钮等）。能给下一步动作的必须给。 */
  action?: ReactNode;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const s = SIZE[size];
  const body = (
    <div className={cn("flex flex-col items-center gap-2 text-center", s.wrap, className)}>
      {Icon && <Icon className={cn(s.icon, "text-muted-foreground/60")} />}
      <p className={cn(s.title, "text-foreground")}>{title}</p>
      {hint && <p className={cn(s.hint, "max-w-sm text-muted-foreground")}>{hint}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
  // inline 不套 Card（通常已在某个容器内）；page/section 自带卡片轮廓
  return size === "inline" ? body : <Card className="p-0">{body}</Card>;
}
