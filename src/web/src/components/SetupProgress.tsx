import { cn } from "@/lib/utils";

export interface SetupProgressProps {
  current: number;
  /** 步骤标签，长度即步数（默认 2 步：Provider / Codebase） */
  labels?: string[];
}

const DEFAULT_LABELS: string[] = ["Provider", "Codebase"];

export function SetupProgress({ current, labels = DEFAULT_LABELS }: SetupProgressProps) {
  const total = labels.length;
  return (
    <ol className="mb-6 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.12em]">
      {labels.map((label, idx) => {
        const step = idx + 1;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center border-[1.5px] font-bold",
                isActive && "border-foreground bg-foreground text-background",
                isDone && "border-foreground/60 text-foreground/60",
                !isActive && !isDone && "border-foreground/30 text-foreground/30",
              )}
            >
              {step}
            </span>
            <span className={cn(!isActive && "text-muted-foreground")}>{label}</span>
            {step < total && <span className="text-muted-foreground">———</span>}
          </li>
        );
      })}
    </ol>
  );
}
