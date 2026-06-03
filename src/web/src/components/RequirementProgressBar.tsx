import { Check, Loader2, AlertCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 需求 4 步进度条 — 从用户视角合并底层 10+ 状态成 4 个里程碑。
 *
 * 1. 调研（drafting / clarifying）       —— AI 在分析需求，可能提问
 * 2. 审批（ready / awaiting_approval）    —— 等用户拍板
 * 3. 跑任务（queued / running / awaiting_review / fix_revision）—— Task 在跑
 * 4. 完成（done）                          —— 收工
 *
 * 失败 / 取消是分支态，整条进度变红色 ✗ 标记当前所处步骤。
 */

type Step = 1 | 2 | 3 | 4;
type StepState = "done" | "current" | "pending" | "failed" | "cancelled";

interface StepDef {
  step: Step;
  label: string;
  sublabel: string;
}

const STEPS: StepDef[] = [
  { step: 1, label: "调研", sublabel: "AI 分析需求" },
  { step: 2, label: "审批", sublabel: "等你拍板" },
  { step: 3, label: "跑任务", sublabel: "AI 执行工作流" },
  { step: 4, label: "完成", sublabel: "看产出物" },
];

function statusToStep(status: string): Step {
  if (status === "drafting" || status === "clarifying") return 1;
  if (status === "ready" || status === "awaiting_approval") return 2;
  if (
    status === "queued" ||
    status === "running" ||
    status === "awaiting_review" ||
    status === "fix_revision" ||
    status === "failed"
  ) {
    return 3;
  }
  if (status === "done") return 4;
  return 1; // 兜底
}

function classifyStep(currentStep: Step, step: Step, status: string): StepState {
  if (status === "cancelled" && step >= currentStep) return "cancelled";
  if (status === "failed" && step === currentStep) return "failed";
  if (step < currentStep) return "done";
  if (step === currentStep) return "current";
  return "pending";
}

export function RequirementProgressBar({ status }: { status: string }) {
  const currentStep = statusToStep(status);
  const isCancelled = status === "cancelled";
  const isFailed = status === "failed";

  return (
    <div className="my-4 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="bp-label text-muted-foreground">
          流程
        </span>
        <span className="text-[11px] text-muted-foreground">
          {STEPS[currentStep - 1]?.label}
        </span>
      </div>
      <ol className="flex items-stretch gap-1.5">
        {STEPS.map((s) => {
          const state = classifyStep(currentStep, s.step, status);
          return <StepCell key={s.step} def={s} state={state} />;
        })}
      </ol>
      {(isCancelled || isFailed) && (
        <p className="mt-2 text-[11px] text-destructive">
          {isCancelled ? "已取消" : "执行失败 — 可重启或调 prompt"}
        </p>
      )}
    </div>
  );
}

function StepCell({ def, state }: { def: StepDef; state: StepState }) {
  const Icon =
    state === "done"
      ? Check
      : state === "current"
      ? Loader2
      : state === "failed"
      ? AlertCircle
      : state === "cancelled"
      ? XCircle
      : null;

  return (
    <li
      className={cn(
        "flex flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
        state === "done" && "border-success/50 bg-success/8 text-success",
        state === "current" && "border-accent bg-accent/10 text-accent",
        state === "pending" && "border-border bg-card text-muted-foreground",
        state === "failed" && "border-destructive bg-destructive/8 text-destructive",
        state === "cancelled" && "border-border bg-muted/30 text-muted-foreground line-through",
      )}
    >
      {Icon ? (
        <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "current" && "animate-spin")} />
      ) : (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-[10px]">
          {def.step}
        </span>
      )}
      <div className="min-w-0">
        <div className="text-[11px] font-bold">
          {def.label}
        </div>
        <div className="text-[9px] opacity-70 truncate">
          {def.sublabel}
        </div>
      </div>
    </li>
  );
}
