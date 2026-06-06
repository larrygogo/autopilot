import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// 需求阶段导轨：把需求生命周期的 5 个大阶段显性成一条进度轨，
// 当前阶段高亮。把"流程分了很多"的焦虑收敛成"看得见走到哪了"。
//
// status（细粒度状态机）→ stage（粗粒度阶段）的归并是这一页信息架构的核心：
// 主区只渲染「当前 stage」该看的内容，不再全阶段平铺。
// ──────────────────────────────────────────────

export type ReqStage = "clarify" | "ready" | "execute" | "review" | "done";

const STAGES: { key: ReqStage; label: string }[] = [
  { key: "clarify", label: "澄清" },
  { key: "ready", label: "待发" },
  { key: "execute", label: "执行" },
  { key: "review", label: "验收" },
  { key: "done", label: "完成" },
];

/** 细粒度 status → 5 大阶段。真理来源：src/core/requirements.ts ALLOWED_TRANSITIONS。 */
export function statusToStage(status: string): ReqStage {
  switch (status) {
    case "drafting":
    case "clarifying":
      return "clarify";
    case "ready":
    case "awaiting_approval":
    case "queued":
      return "ready";
    case "running":
    case "fix_revision":
      return "execute";
    case "awaiting_review":
      return "review";
    case "done":
    case "failed":
    case "cancelled":
    default:
      return "done";
  }
}

export function StageRail({ status }: { status: string }) {
  const current = statusToStage(status);
  const currentIdx = STAGES.findIndex((s) => s.key === current);
  // 异常终态：最后一节用红色表达「未正常完成」
  const aborted = status === "failed" || status === "cancelled";

  return (
    <ol className="flex items-center gap-1.5">
      {STAGES.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const isAbortedTail = active && current === "done" && aborted;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors",
                  isAbortedTail
                    ? "border-destructive bg-destructive text-destructive-foreground"
                    : done
                      ? "border-success/40 bg-success/15 text-success"
                      : active
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-card text-muted-foreground",
                )}
              >
                {isAbortedTail ? (
                  <X className="h-3.5 w-3.5" />
                ) : done ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-xs transition-colors",
                  isAbortedTail
                    ? "font-medium text-destructive"
                    : active
                      ? "font-medium text-foreground"
                      : done
                        ? "text-muted-foreground"
                        : "text-muted-foreground/60",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <span
                className={cn(
                  "h-px flex-1 transition-colors",
                  i < currentIdx ? "bg-success/40" : "bg-border",
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
