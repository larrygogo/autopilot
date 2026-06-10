import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { STEPS, STEP_ORDER, statusToStep, type ReqStep } from "@/lib/requirement-steps";

// 可点击的步骤进度条：6 步圆圈数字 + 连接线，当前步高亮、已走过打勾、未到达浅灰。
// 选中步加下划线。所有步骤（含未到达）均可点击，点击回调 onSelect。
export function StepBar({
  status,
  selected,
  onSelect,
}: {
  status: string;
  selected: ReqStep;
  onSelect: (step: ReqStep) => void;
}) {
  const current = statusToStep(status);
  const currentIdx = STEP_ORDER.indexOf(current);
  const aborted = status === "failed" || status === "cancelled";

  return (
    <ol className="flex items-center gap-1.5">
      {STEPS.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const isSelected = s.key === selected;
        const isAbortedTail = active && s.key === "done" && aborted;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <button
              type="button"
              onClick={() => onSelect(s.key)}
              aria-current={isSelected ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/50",
                isSelected && "bg-muted/60",
              )}
            >
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
                  isSelected
                    ? "font-semibold text-foreground underline underline-offset-4"
                    : isAbortedTail
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
            </button>
            {i < STEPS.length - 1 && (
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
