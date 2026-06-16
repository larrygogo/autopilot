// 实体目录的共享视图模板（Supabase 式）：grid 固定高卡片 + list 行式 + 视图切换。
// 项目库（Library）与工作流目录（WorkflowCatalog)共用——卡片长相只此一份，
// 各页只提供数据（title/subtitle/description/meta/menu）与跳转行为。
import { useEffect, useState, type ReactNode } from "react";
import { LayoutGrid, List, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface EntityCardItem {
  key: string;
  /** 主标题（业务名） */
  title: ReactNode;
  /** mono 副标（内核名 / id），grid 下显示在标题下方、list 下靠右 */
  subtitle?: ReactNode;
  /** 描述（grid 下 line-clamp-2） */
  description?: ReactNode;
  /** 底部 meta 行（创建时间 / 用量统计…），grid 下沉底、list 下靠右 */
  meta?: ReactNode;
  /** 右上角操作区（⋯ 菜单 / 按钮组），grid 卡右上 / list 行尾共用 */
  menu?: ReactNode;
  /** list 行首图标（grid 下不渲染） */
  icon?: LucideIcon;
  onOpen: () => void;
}

/** grid / list 视图偏好（localStorage 记住） */
export function useViewMode(storageKey: string): ["grid" | "list", (v: "grid" | "list") => void] {
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(storageKey) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, view); } catch { /* ignore */ }
  }, [storageKey, view]);
  return [view, setView];
}

export function ViewToggle({ view, onChange }: { view: "grid" | "list"; onChange: (v: "grid" | "list") => void }) {
  return (
    <div className="flex items-center rounded-md border border-border p-0.5">
      <button
        type="button"
        aria-label="网格视图"
        onClick={() => onChange("grid")}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded transition-colors",
          view === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="列表视图"
        onClick={() => onChange("list")}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded transition-colors",
          view === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <List className="h-4 w-4" />
      </button>
    </div>
  );
}

/** grid：固定高度卡片（右上角操作菜单、描述 2 行截断、meta 沉底） */
export function EntityGrid({ items }: { items: EntityCardItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Card
            key={it.key}
            className="flex h-[150px] cursor-pointer flex-col p-4 transition-colors hover:border-accent"
            onClick={it.onOpen}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold leading-tight">{it.title}</h3>
                {it.subtitle && (
                  <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                    {Icon && <Icon className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{it.subtitle}</span>
                  </div>
                )}
              </div>
              {it.menu}
            </div>
            {it.description && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                {it.description}
              </p>
            )}
            {it.meta && <div className="mt-auto pt-2 text-[11px] text-muted-foreground">{it.meta}</div>}
          </Card>
        );
      })}
    </div>
  );
}

/** list：行式视图（图标 + 标题 + 描述 + 副标/meta 靠右 + 操作） */
export function EntityList({ items }: { items: EntityCardItem[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <ul className="divide-y divide-border">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li
              key={it.key}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
              onClick={it.onOpen}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="shrink-0 text-sm font-bold">{it.title}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {it.description ?? ""}
              </span>
              {it.subtitle && (
                <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                  {it.subtitle}
                </span>
              )}
              {it.meta && (
                <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">{it.meta}</span>
              )}
              {it.menu}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
