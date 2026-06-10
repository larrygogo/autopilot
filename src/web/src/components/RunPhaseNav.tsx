// GA 式执行视图的 phase 导航：宽容器 = 左侧竖排列表；窄容器 = 横向 chip 条。
// 纯定位器：点击只负责「展开 + 滚到 section」，不承载折叠/重试/决策动作。
import { Circle, CheckCircle2, XCircle, Hand, Loader2, History } from "lucide-react";
import { cn } from "@/lib/utils";

export type PhaseVisualState = "idle" | "pending" | "running" | "done" | "failed" | "awaiting" | "aborted";

/** 左导航与 section header 共用的状态视觉（同源同款） */
export function PhaseStatusIcon({ state, className }: { state: PhaseVisualState; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  switch (state) {
    case "running": return <Loader2 className={cn(cls, "animate-spin text-accent")} />;
    case "done": return <CheckCircle2 className={cn(cls, "text-success")} />;
    case "failed": return <XCircle className={cn(cls, "text-destructive")} />;
    case "awaiting": return <Hand className={cn(cls, "text-warning")} />;
    default: return <Circle className={cn(cls, "text-muted-foreground/50")} />;
  }
}

export interface NavPhaseItem {
  name: string;
  label?: string;
  state: PhaseVisualState;
  durationText: string; // "—" 表示未开始
  group?: string;       // 所属并行组名（顶层 phase 为 undefined）
}

export interface NavGroupHeader { group: string; label?: string; }

/** 导航条目序列：并行组以 header 项打头，子项带 group 字段 */
export type NavEntry = { kind: "phase"; item: NavPhaseItem } | { kind: "group"; header: NavGroupHeader };

interface RunPhaseNavProps {
  entries: NavEntry[];
  activePhase: string | null;
  onSelect: (phase: string) => void;
  onSelectTransitions: () => void;
  transitionsCount: number;
}

/** 宽容器左导航（竖排）。父级用容器查询控制显隐。 */
export function RunPhaseNavSidebar({ entries, activePhase, onSelect, onSelectTransitions, transitionsCount }: RunPhaseNavProps) {
  return (
    <nav className="w-60 shrink-0 self-start" aria-label="阶段导航">
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">阶段 · PHASES</p>
      <ul className="space-y-0.5">
        {entries.map((e) =>
          e.kind === "group" ? (
            <li key={`g-${e.header.group}`} className="pt-1.5">
              <p className="font-mono text-[10px] text-muted-foreground">
                {e.header.label ?? e.header.group} · PARALLEL
              </p>
            </li>
          ) : (
            <li key={e.item.name} className={cn(e.item.group && "ml-3 border-l border-border pl-2")}>
              <button
                type="button"
                onClick={() => onSelect(e.item.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/8",
                  activePhase === e.item.name && "border-l-2 border-l-accent bg-accent/8",
                )}
              >
                <PhaseStatusIcon state={e.item.state} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{e.item.label ?? e.item.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{e.item.durationText}</span>
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          onClick={onSelectTransitions}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent/8 hover:text-foreground"
        >
          <History className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-[13px]">状态转移</span>
          <span className="shrink-0 font-mono text-[11px]">{transitionsCount}</span>
        </button>
      </div>
    </nav>
  );
}

/** 窄容器横向 chip 条。父级用容器查询控制显隐。 */
export function RunPhaseNavStrip({ entries, activePhase, onSelect }: Omit<RunPhaseNavProps, "onSelectTransitions" | "transitionsCount">) {
  return (
    <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="阶段导航">
      {entries.filter((e): e is Extract<NavEntry, { kind: "phase" }> => e.kind === "phase").map((e) => (
        <button
          key={e.item.name}
          type="button"
          onClick={() => onSelect(e.item.name)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            activePhase === e.item.name
              ? "border-accent bg-accent/10 text-foreground"
              : "border-border text-muted-foreground hover:border-accent/60",
            e.item.group && "border-dashed",
          )}
        >
          <PhaseStatusIcon state={e.item.state} className="h-3.5 w-3.5" />
          {e.item.label ?? e.item.name}
          {e.item.durationText !== "—" && (
            <span className="font-mono text-[10px] text-muted-foreground">{e.item.durationText}</span>
          )}
        </button>
      ))}
    </div>
  );
}
