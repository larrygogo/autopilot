import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AddPhaseForm, type NewPhaseData } from "./AddPhaseDialog";
import { AddParallelForm, type NewParallelData } from "./AddParallelDialog";

export type { NewPhaseData } from "./AddPhaseDialog";
export type { NewParallelData } from "./AddParallelDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
  /** 顶层条目数（阶段插入默认位 + 并行块插入位） */
  topCount: number;
  /** 顶层条目显示名（插入位下拉） */
  topLabels: string[];
  onConfirmPhase: (data: NewPhaseData) => void | Promise<void>;
  onConfirmParallel: (data: NewParallelData) => void | Promise<void>;
}

/**
 * 合并「新增阶段 / 新增并行块」为单弹窗 + 顶部 tab 切换。
 * 两种表单体（AddPhaseForm / AddParallelForm）按 mode 条件渲染，各自维护状态；
 * 切 tab 会重挂另一个表单（状态重置，符合预期）。
 */
export function AddStepDialog({
  open,
  onClose,
  existingNames,
  topCount,
  topLabels,
  onConfirmPhase,
  onConfirmParallel,
}: Props) {
  const [mode, setMode] = useState<"phase" | "parallel">("phase");

  // 每次打开默认回到「阶段」tab
  useEffect(() => {
    if (open) setMode("phase");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className={mode === "parallel" ? "sm:max-w-lg" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>新增</DialogTitle>
          <DialogDescription>
            {mode === "phase" ? "添加一个新阶段到工作流中。" : "一次可填多个并发执行的子阶段。"}
          </DialogDescription>
        </DialogHeader>

        {/* tab 切换 */}
        <div className="flex gap-2">
          {(["phase", "parallel"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors",
                mode === m
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/40",
              )}
            >
              {m === "phase" ? "阶段" : "并行块"}
            </button>
          ))}
        </div>

        {mode === "phase" ? (
          <AddPhaseForm
            onClose={onClose}
            onConfirm={onConfirmPhase}
            existingNames={existingNames}
            count={topCount}
          />
        ) : (
          <AddParallelForm
            onClose={onClose}
            onConfirm={onConfirmParallel}
            existingNames={existingNames}
            topCount={topCount}
            topLabels={topLabels}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
