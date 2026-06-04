import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, Clock, XCircle, Circle, Pencil } from "lucide-react";
import { pickPhaseLabel } from "@/lib/workflow-labels";
import { cn } from "@/lib/utils";
import { Term } from "@/components/Term";

// ──────────────────────────────────────────────
// 阶段详情 Drawer：点击流水线节点时弹出，按上下文显示不同内容。
//
// mode="preview"：工作流定义视角 — 展示 yaml 字段（label/agent/timeout/reject/gate）+ 对应 ts 函数代码
// mode="status"： 任务运行视角 — 展示当前状态（pending/running/done/failed）、耗时、最近错误
// ──────────────────────────────────────────────

export type PhaseRunStatus = "pending" | "running" | "done" | "failed" | "skipped" | "idle";

export interface DrawerPhaseInfo {
  name: string;
  label?: string;
  agent?: string;
  timeout?: number;
  reject?: string | null;
  gate?: boolean;
  gate_message?: string;
  max_rejections?: number;
  jump_trigger?: string;
  jump_target?: string;
  /** 零代码模式（phase.prompt）下的 prompt 内容 — drawer 里直接展示，否则用户只看得到字段表 */
  prompt?: string;
}

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: DrawerPhaseInfo | null;
  /** 提供时显示「去编辑器修改」按钮，回调里调用方负责滚动到 PhaseEditor 等 */
  onLocateInEditor?: (phaseName: string) => void;
}

interface PreviewProps extends BaseProps {
  mode: "preview";
  /** 若提供，会从完整 workflow.ts 文本里切出本阶段对应的函数代码 */
  tsFunctionCode?: string | null;
}

interface StatusProps extends BaseProps {
  mode: "status";
  /** 任务运行时当前阶段处于何种状态 */
  runStatus: PhaseRunStatus;
  /** 已耗时（ms），仅 running 时使用 */
  elapsedMs?: number;
  /** 最近的错误信息（仅 failed） */
  errorMessage?: string;
}

export type PhaseDetailDrawerProps = PreviewProps | StatusProps;

export function PhaseDetailDrawer(props: PhaseDetailDrawerProps) {
  const { open, onOpenChange, phase } = props;
  if (!phase) return null;

  const title = pickPhaseLabel(phase);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-baseline gap-2">
            <span className="truncate">{title}</span>
            {title !== phase.name && (
              <code className="font-mono text-[11px] text-muted-foreground">{phase.name}</code>
            )}
          </SheetTitle>
          <SheetDescription>
            {props.mode === "preview" ? "阶段配置预览" : "阶段执行状态"}
          </SheetDescription>
        </SheetHeader>

        {props.mode === "preview" ? (
          <PreviewBody phase={phase} tsFunctionCode={props.tsFunctionCode ?? null} />
        ) : (
          <StatusBody
            phase={phase}
            runStatus={props.runStatus}
            elapsedMs={props.elapsedMs}
            errorMessage={props.errorMessage}
          />
        )}

        {props.onLocateInEditor && (
          <SheetFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                props.onLocateInEditor!(phase.name);
                onOpenChange(false);
              }}
            >
              <Pencil className="h-4 w-4" />
              去编辑器修改
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ──────────────────────────────────────────────
// 预览模式：yaml 字段表 + ts 函数代码
// ──────────────────────────────────────────────

function PreviewBody({
  phase,
  tsFunctionCode,
}: {
  phase: DrawerPhaseInfo;
  tsFunctionCode: string | null;
}) {
  /** 零代码模式（有 phase.prompt 字段）和代码模式（有 ts 函数）互斥；都没的话提示 stub */
  const hasPrompt = typeof phase.prompt === "string" && phase.prompt.trim().length > 0;
  const hasTs = !!tsFunctionCode;

  return (
    <div className="space-y-4 pt-3">
      <FieldGrid phase={phase} />
      {/* prompt 优先显示 — 零代码模式下这才是 phase 的核心配置 */}
      {hasPrompt && (
        <section>
          <div className="mb-1.5 flex items-center gap-2 bp-label text-muted-foreground">
            <span>提示词 · prompt</span>
            <span className="rounded-md border border-accent/40 bg-accent/5 px-1 py-px text-[9px] text-accent">
              零代码
            </span>
          </div>
          <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-card p-3 font-mono text-[11px] leading-relaxed">
            {phase.prompt}
          </pre>
        </section>
      )}
      {hasTs && (
        <section>
          <div className="mb-1.5 bp-label text-muted-foreground">
            执行函数 · workflow.ts
          </div>
          <pre className="scrollbar-thin max-h-72 overflow-auto border border-border bg-card p-3 font-mono text-[11px] leading-relaxed">
            {tsFunctionCode}
          </pre>
        </section>
      )}
      {!hasPrompt && !hasTs && (
        <section>
          <div className="mb-1.5 bp-label text-muted-foreground">
            执行函数 · workflow.ts
          </div>
          <p className="border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            未找到名为 <code className="font-mono">{phase.name}</code> 的导出函数；
            保存阶段时框架会自动追加 stub。
          </p>
        </section>
      )}
    </div>
  );
}

function FieldGrid({ phase }: { phase: DrawerPhaseInfo }) {
  const items: Array<{ label: React.ReactNode; value: React.ReactNode }> = [
    { label: "标识符", value: <code className="font-mono">{phase.name}</code> },
  ];
  if (phase.agent) {
    items.push({ label: "智能体", value: <code className="font-mono">{phase.agent}</code> });
  }
  if (typeof phase.timeout === "number") {
    items.push({ label: "超时", value: fmtTimeout(phase.timeout) });
  }
  if (phase.reject) {
    items.push({
      label: "驳回到",
      value: <code className="font-mono">{phase.reject}</code>,
    });
  }
  if (phase.gate) {
    items.push({
      label: "人工审批",
      value: <Badge variant="warning">需要审批</Badge>,
    });
  }
  if (typeof phase.max_rejections === "number") {
    items.push({ label: "最大驳回", value: phase.max_rejections });
  }
  if (phase.jump_trigger) {
    items.push({
      label: (
        <Term
          name="jump_trigger"
          variant="withSubtitle"
          className="text-foreground text-sm normal-case tracking-normal"
        />
      ),
      value: <code className="font-mono">{phase.jump_trigger}</code>,
    });
  }
  if (phase.jump_target) {
    items.push({
      label: "跳转目标",
      value: <code className="font-mono">{phase.jump_target}</code>,
    });
  }

  return (
    <section>
      <div className="mb-1.5 bp-label text-muted-foreground">
        配置
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        {items.map((it, idx) => (
          <div key={idx} className="contents">
            <dt
              className={cn(
                "pt-0.5",
                typeof it.label === "string"
                  ? "bp-label text-muted-foreground"
                  : "",
              )}
            >
              {it.label}
            </dt>
            <dd className="min-w-0 break-words">{it.value}</dd>
          </div>
        ))}
      </dl>
      {phase.gate && phase.gate_message && (
        <p className="mt-2 border-l-4 border-warning bg-warning/5 px-2 py-1 text-xs text-muted-foreground">
          {phase.gate_message}
        </p>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────
// 状态模式：当前运行情况
// ──────────────────────────────────────────────

function StatusBody({
  phase,
  runStatus,
  elapsedMs,
  errorMessage,
}: {
  phase: DrawerPhaseInfo;
  runStatus: PhaseRunStatus;
  elapsedMs?: number;
  errorMessage?: string;
}) {
  return (
    <div className="space-y-4 pt-3">
      <StatusHero status={runStatus} elapsedMs={elapsedMs} />
      <FieldGrid phase={phase} />
      {runStatus === "failed" && errorMessage && (
        <section>
          <div className="mb-1.5 bp-label text-muted-foreground">
            错误信息
          </div>
          <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words border border-destructive bg-destructive/8 p-3 font-mono text-[11px] leading-relaxed text-destructive">
            {errorMessage}
          </pre>
        </section>
      )}
    </div>
  );
}

function StatusHero({ status, elapsedMs }: { status: PhaseRunStatus; elapsedMs?: number }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "flex items-center gap-3 border p-3",
        meta.containerClass,
      )}
    >
      <Icon className={cn("h-5 w-5 shrink-0", meta.iconClass, status === "running" && "animate-spin")} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-bold", meta.titleClass)}>
          {meta.title}
        </div>
        {status === "running" && elapsedMs != null && (
          <div className="font-mono text-[11px] text-muted-foreground">
            已耗时 {formatElapsed(elapsedMs)}
          </div>
        )}
      </div>
    </div>
  );
}

function statusMeta(status: PhaseRunStatus): {
  title: string;
  icon: typeof Loader2;
  containerClass: string;
  iconClass: string;
  titleClass: string;
} {
  switch (status) {
    case "running":
      return {
        title: "执行中",
        icon: Loader2,
        containerClass: "border-accent bg-accent/8",
        iconClass: "text-accent",
        titleClass: "text-accent",
      };
    case "done":
      return {
        title: "已完成",
        icon: CheckCircle2,
        containerClass: "border-success bg-success/8",
        iconClass: "text-success",
        titleClass: "text-success",
      };
    case "failed":
      return {
        title: "失败",
        icon: AlertCircle,
        containerClass: "border-destructive bg-destructive/8",
        iconClass: "text-destructive",
        titleClass: "text-destructive",
      };
    case "skipped":
      return {
        title: "已跳过",
        icon: XCircle,
        containerClass: "border-border bg-muted/40",
        iconClass: "text-muted-foreground",
        titleClass: "text-muted-foreground",
      };
    case "pending":
      return {
        title: "等待中",
        icon: Clock,
        containerClass: "border-border bg-muted/40",
        iconClass: "text-muted-foreground",
        titleClass: "text-foreground",
      };
    case "idle":
    default:
      return {
        title: "未开始",
        icon: Circle,
        containerClass: "border-border bg-muted/30",
        iconClass: "text-muted-foreground",
        titleClass: "text-muted-foreground",
      };
  }
}

function fmtTimeout(t: number): string {
  if (t < 60) return `${t} 秒`;
  if (t < 3600) return `${Math.round(t / 60)} 分钟`;
  return `${(t / 3600).toFixed(1)} 小时`;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}min`;
}
