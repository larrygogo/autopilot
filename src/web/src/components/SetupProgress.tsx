import { cn } from "@/lib/utils";

export interface SetupProgressProps {
  current: 1 | 2 | 3;
  labels?: [string, string, string];
}

const DEFAULT_LABELS: [string, string, string] = ["Provider", "Agent", "Codebase"];

export function SetupProgress({ current, labels = DEFAULT_LABELS }: SetupProgressProps) {
  return (
    <ol className="mb-6 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.12em]">
      {labels.map((label, idx) => {
        const step = (idx + 1) as 1 | 2 | 3;
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
            {step < 3 && <span className="text-muted-foreground">———</span>}
          </li>
        );
      })}
    </ol>
  );
}
