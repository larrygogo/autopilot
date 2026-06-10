// 流水线风列表的共享件：状态色调、行卡片、时间分组容器。
// Tasks 页（需求+任务混合）与 ProjectDetail 页（纯需求）共用。
import { useState, type ReactNode, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2, Hand, Search, Clock, FileText, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import { relTime, tsToMs, bucketOf, BUCKET_ORDER, BUCKET_LABEL, type TimeBucket } from "@/lib/pipeline-time";
import { reqCardSpec, type ReqCardAction } from "@/lib/requirement-card";

export interface PipelineTask {
  id: string;
  title: string;
  workflow: string;
  status: string;
  requirement_id?: string | null;
  requirement?: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  pr_url?: string | null;
  dangling?: boolean;
}

// 卡片状态色调：头像图标色 + 状态点 bg
export const TONE = {
  accent: { text: "text-accent", dot: "bg-accent" },
  warning: { text: "text-warning", dot: "bg-warning" },
  destructive: { text: "text-destructive", dot: "bg-destructive" },
  success: { text: "text-success", dot: "bg-success" },
  info: { text: "text-info", dot: "bg-info" },
  muted: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
} as const;
export type Tone = keyof typeof TONE;

export function taskMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string } {
  if (status.startsWith("running_")) return { Icon: Loader2, tone: "accent", label: "运行中" };
  if (status.startsWith("awaiting_")) return { Icon: Hand, tone: "warning", label: "等待人工" };
  if (status === "failed" || status.startsWith("failed_")) return { Icon: AlertCircle, tone: "destructive", label: "失败" };
  if (status.startsWith("pending_")) return { Icon: Clock, tone: "muted", label: "待执行" };
  if (status === "done") return { Icon: CheckCircle2, tone: "success", label: "已完成" };
  return { Icon: XCircle, tone: "muted", label: "已取消" };
}

/** 需求状态 → 卡片视觉。覆盖全生命周期（项目页的需求没有任务行代表后段）。 */
export function reqMeta(status: string): { Icon: typeof Loader2; tone: Tone; label: string; spin?: boolean } {
  if (status === "queued") return { Icon: Clock, tone: "accent", label: "待执行" };
  if (status === "running") return { Icon: Loader2, tone: "accent", label: "执行中", spin: true };
  if (status === "fix_revision") return { Icon: Loader2, tone: "accent", label: "修复中", spin: true };
  if (status === "awaiting_review") return { Icon: Hand, tone: "warning", label: "待 PR review" };
  if (status === "awaiting_approval") return { Icon: Hand, tone: "warning", label: "待审批" };
  if (status === "ready") return { Icon: Hand, tone: "warning", label: "待入队" };
  if (status === "clarifying") return { Icon: Search, tone: "info", label: "调查中" };
  if (status === "drafting") return { Icon: FileText, tone: "muted", label: "草稿" };
  if (status === "done") return { Icon: CheckCircle2, tone: "success", label: "已完成" };
  if (status === "failed") return { Icon: AlertCircle, tone: "destructive", label: "失败" };
  if (status === "cancelled") return { Icon: XCircle, tone: "muted", label: "已取消" };
  return { Icon: FileText, tone: "muted", label: status };
}

/** id → 名称映射（页面注入）：行卡 secondary 显示项目名 / 仓库别名 / 工作流中文 label */
export interface PipelineNameMaps {
  /** project_id → 项目名 */
  projects?: Record<string, string>;
  /** workspace_id → 仓库别名 */
  workspaces?: Record<string, string>;
  /** workflow name → 中文 label */
  workflows?: Record<string, string>;
}

export interface TimedRow { key: string; ts: number; node: ReactNode; }

/** 把行列表分桶渲染（带时段小标题）。入参应已按时间倒序。 */
export function TimeGroupedList({ rows, now }: { rows: TimedRow[]; now: number }) {
  const byBucket = new Map<TimeBucket, TimedRow[]>();
  for (const r of rows) {
    const b = bucketOf(r.ts, now);
    const arr = byBucket.get(b);
    if (arr) arr.push(r);
    else byBucket.set(b, [r]);
  }
  const sections = BUCKET_ORDER.filter((b) => byBucket.has(b));
  return (
    <div className="space-y-4">
      {sections.map((b) => {
        const items = byBucket.get(b)!;
        return (
          <div key={b}>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {BUCKET_LABEL[b]}
              <span className="font-mono text-[10px] text-muted-foreground/60">{items.length}</span>
            </p>
            <ul className="space-y-2">
              {items.map((r) => <li key={r.key}>{r.node}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Claude Code 风卡片外壳：头像图标 + 标题 + 相对时间 + 状态行 + 可选预览 + 可选特化区 */
export function RowCard({
  to, Icon, tone, spin, title, time, statusLabel, secondary, preview, extra,
}: {
  to: string;
  Icon: typeof Loader2;
  tone: Tone;
  spin?: boolean;
  title: string;
  time: string;
  statusLabel: string;
  secondary?: string;
  preview?: string | null;
  /** 状态特化区（提示条 / 行内动作），渲染在 preview 之后 */
  extra?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <Link
      to={to}
      className="block rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:border-accent"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className={cn("h-[18px] w-[18px]", t.text, spin && "animate-spin")} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-snug">{title}</p>
            <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">{time}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} />
            <span className={cn("shrink-0 font-medium", t.text)}>{statusLabel}</span>
            {secondary && <span className="truncate font-mono text-[11px]">· {secondary}</span>}
          </div>
          {preview && (
            <div className="mt-2.5 rounded-lg bg-muted/50 px-3 py-2">
              <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{preview}</p>
            </div>
          )}
          {extra}
        </div>
      </div>
    </Link>
  );
}

export function RequirementRow({ req, now, maps }: { req: Requirement; now: number; maps?: PipelineNameMaps }) {
  const { Icon, tone, label, spin } = reqMeta(req.status);
  const wfName = req.workflow ?? "dev";
  const secondary = [
    req.id,
    maps?.projects?.[req.project_id],
    req.workspace_id ? maps?.workspaces?.[req.workspace_id] : null,
    maps?.workflows?.[wfName] ?? (maps?.workflows ? wfName : null), // 有映射但无 label 时退回内核名
  ].filter(Boolean).join(" · ");
  const card = reqCardSpec(req);
  return (
    <RowCard
      to={`/requirements/${req.id}`}
      Icon={Icon}
      tone={tone}
      spin={spin}
      title={req.title}
      time={relTime(tsToMs(req.updated_at), now)}
      statusLabel={label}
      secondary={secondary}
      preview={card.preview}
      extra={(card.notice || card.actions.length > 0) && (
        <div className="mt-2.5 space-y-2">
          {card.notice && (
            <p className={cn(
              "rounded-lg px-3 py-2 text-[12px] leading-relaxed",
              card.notice.tone === "error"
                ? "bg-destructive/8 text-destructive"
                : "bg-muted/50 text-muted-foreground",
            )}>
              {card.notice.text}
            </p>
          )}
          {card.actions.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {card.actions.map((a) => (
                <ReqCardActionButton key={a.key} req={req} action={a} />
              ))}
            </div>
          )}
        </div>
      )}
    />
  );
}

/**
 * 需求卡片的行内快捷动作。动作语义与需求详情页同源（approve=enqueue、
 * reject=回 drafting、retry=重新入队、retryClarify=POST retry-clarify）。
 * 成功后不手动刷列表 —— 两页都订阅 requirement:*，WS 推送自动刷新。
 */
function ReqCardActionButton({ req, action }: { req: Requirement; action: ReqCardAction }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const destructive = action.key === "reject";

  const run = async (e: MouseEvent) => {
    // 卡片整体是 Link，行内按钮必须拦截冒泡与默认跳转
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;

    if (action.key === "answer") { navigate(`/requirements/${req.id}`); return; }
    if (action.key === "viewTask") { if (req.task_id) navigate(`/tasks/${req.task_id}`); return; }
    if (action.key === "openPr") { if (req.pr_url) window.open(req.pr_url, "_blank", "noopener"); return; }

    setBusy(true);
    try {
      if (action.key === "approve") {
        await api.enqueueRequirement(req.id);
        toast.success(`已审批通过 · ${req.id} 进入队列`);
      } else if (action.key === "retry") {
        await api.enqueueRequirement(req.id);
        toast.success(`已重新入队 · ${req.id}`);
      } else if (action.key === "reject") {
        await api.transitionRequirement(req.id, "drafting");
        toast.success(`已驳回 · ${req.id} 返回草稿`);
      } else if (action.key === "retryClarify") {
        const res = await fetch(`/api/requirements/${encodeURIComponent(req.id)}/retry-clarify`, { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(`已重试澄清 · ${req.id}`);
      }
    } catch (err: unknown) {
      toast.error("操作失败", (err as Error)?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className={cn(
        "rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors disabled:opacity-50",
        destructive
          ? "border-destructive/40 text-destructive hover:border-destructive hover:bg-destructive/8"
          : "border-border text-foreground hover:border-accent hover:bg-accent/8",
      )}
    >
      {busy ? "处理中…" : action.label}
    </button>
  );
}

export function TaskRow({ task, now, maps }: { task: PipelineTask; now: number; maps?: PipelineNameMaps }) {
  const { Icon, tone, label } = taskMeta(task.status);
  const phase = parsePhase(task.status);
  const secondary = [
    maps?.workflows?.[task.workflow] ?? task.workflow, // 工作流中文 label（无映射退回内核名）
    phase || null,
    task.requirement_id ? `← ${task.requirement_id}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <RowCard
      to={`/tasks/${task.id}`}
      Icon={Icon}
      tone={tone}
      spin={task.status.startsWith("running_")}
      title={task.title}
      time={relTime(tsToMs(task.updated_at), now)}
      statusLabel={label}
      secondary={secondary}
      preview={task.requirement ?? null}
    />
  );
}

export function parsePhase(status: string): string | null {
  const m = status.match(/^(?:running|pending|awaiting|failed)_(.+)$/);
  return m ? m[1] : null;
}
