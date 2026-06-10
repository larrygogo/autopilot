import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, RotateCcw, Wrench, ShieldAlert } from "lucide-react";
import { api, type TaskOutcome } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { statusVisual, toneToTextClass } from "@/lib/status-style";
import { classifyFailure, type FailureProfile } from "@/lib/failure-classifier";

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface TaskOutcomeCardProps {
  taskId: string;
  /** 用户在终态切换时强制重拉 */
  reloadKey?: unknown;
  /** task → requirement 关系（用于"重跑"） */
  requirementId: string | null;
  workflow: string;
  /** task.status；失败时用于解析失败 phase 名（如 failed_design → design） */
  taskStatus?: string;
  /** 嵌入需求页时：需求终态卡已展示「取消原因 + 来源徽标 + 不可重启指引」，
   *  这里只保留增量信息（驳回计数 + reviewer 原话），避免同屏双份 */
  embedded?: boolean;
}

/** 从 task.status 解析失败的 phase 名（failed_design → design）；非失败状态返回 null */
function parseFailedPhase(status: string | undefined): string | null {
  if (!status) return null;
  if (status.startsWith("failed_")) return status.slice("failed_".length);
  return null;
}

export function TaskOutcomeCard({ taskId, reloadKey, requirementId, workflow, taskStatus, embedded = false }: TaskOutcomeCardProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getTaskOutcome(taskId)
      .then(setOutcome)
      .catch(() => setOutcome(null))
      .finally(() => setLoading(false));
  }, [taskId, reloadKey]);

  if (loading || !outcome) return null;

  const vis = statusVisual(outcome.status);
  const statusIcon = vis.glyph;
  const statusLabel = vis.label;
  const statusColor = toneToTextClass(vis.tone);

  // 失败时识别失败画像，决定按钮 variant 优先级。
  // cancelled 不走 classifyFailure：分类器是失败指纹语义，对「驳回 N 次取消」会误判成未知错误。
  const failureProfile: FailureProfile | null = outcome.status === "failed"
    ? classifyFailure(outcome.terminal_reason)
    : null;

  // 自动止损（驳回触顶取消）vs 手动取消："API cancel" 是 cancelTaskAction 写死的 note 契约
  const isAutoCancel = outcome.status === "cancelled"
    && outcome.terminal_reason !== null
    && outcome.terminal_reason !== "API cancel";

  async function handleRetry() {
    if (!requirementId) {
      toast.error("无法重跑", "任务未关联需求");
      return;
    }
    setRetrying(true);
    try {
      // 复用原 task 重跑：req failed → queued → scheduler 复用同一 task 重置重跑（不新建）。
      // 不再 api.startTask 新建 —— 那会产生游离空 task（requirement/workspace 都没带）。
      await api.enqueueRequirement(requirementId);
      toast.success("已重新入队，复用原任务重跑");
      // task id 不变，停留当前工作页，WS 会推状态更新
    } catch (e: unknown) {
      toast.error("重跑失败", (e as Error)?.message ?? String(e));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="mb-4 border border-border bg-card">
      <header className="border-b border-border px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">产出物</span>
      </header>
      <div className="space-y-3 px-3 py-3 text-sm">
        <div className={"flex items-center gap-2 font-mono " + statusColor}>
          <span className="text-base">{statusIcon}</span>
          <span className="font-bold">{statusLabel}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">总耗时 {formatDuration(outcome.total_duration_ms)}</span>
        </div>

        {outcome.status === "failed" && failureProfile && (
          <div className="space-y-2 border border-destructive/40 bg-destructive/5 p-2.5">
            <div className="flex items-center gap-2">
              <span className="border border-destructive/60 px-1.5 py-0.5 font-mono text-[9px] text-destructive">
                {failureProfile.label}
              </span>
              <span className="font-mono text-[9px] text-muted-foreground">
                自动识别 · 仅供参考
              </span>
            </div>
            {outcome.terminal_reason && (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive opacity-90">
                {outcome.terminal_reason}
              </pre>
            )}
            <p className="text-xs leading-relaxed text-foreground/85">{failureProfile.hint}</p>
          </div>
        )}

        {/* 取消原因：中性灰调（取消是止损决定，不是错误）。自动止损时带警示标签 + 驳回详情。
            embedded（需求页内嵌）时需求终态卡已有徽标/原因/不可重启指引，只渲染驳回增量信息 */}
        {outcome.status === "cancelled" && (() => {
          const hasRejectionDetail =
            (outcome.rejection_counts && Object.keys(outcome.rejection_counts).length > 0)
            || !!outcome.rejection_reason;
          if (embedded && !hasRejectionDetail) return null;
          return (
            <div className="space-y-2 rounded-lg bg-muted/50 p-2.5">
              {!embedded && (
                <>
                  <div className="flex items-center gap-2">
                    <span className={
                      "rounded border px-1.5 py-0.5 font-mono text-[9px] "
                      + (isAutoCancel ? "border-warning/60 text-warning" : "border-border text-muted-foreground")
                    }>
                      {isAutoCancel ? "自动止损" : "手动取消"}
                    </span>
                    <span className="font-mono text-[9px] text-muted-foreground" title="trigger: cancel">
                      trigger: cancel
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-foreground/85">
                    {outcome.terminal_reason ?? "已取消 · 原因未记录"}
                  </p>
                </>
              )}
              {outcome.rejection_counts && Object.keys(outcome.rejection_counts).length > 0 && (
                <div className="font-mono text-[11px] text-muted-foreground">
                  驳回计数 {Object.entries(outcome.rejection_counts).map(([k, v]) => `${k} ×${v}`).join(" · ")}
                </div>
              )}
              {outcome.rejection_reason && (
                // 需求卡的指引承诺「reviewer 原话见执行记录」，嵌入时默认展开兑现它
                <details open={embedded}>
                  <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground hover:text-foreground">
                    最近一次驳回原因（reviewer 原话）
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
                    {outcome.rejection_reason}
                  </pre>
                </details>
              )}
              {!embedded && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  已取消的任务无法重启 —— 如需继续，请回需求页重新发起。
                </p>
              )}
            </div>
          );
        })()}

        {outcome.pr_url && (
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">PR</div>
            <a href={outcome.pr_url} target="_blank" rel="noreferrer" className="text-accent underline break-all">
              #{outcome.pr_number ?? "?"} {outcome.pr_url}
            </a>
          </div>
        )}

        {outcome.diff_stat && (
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">改动统计</div>
            <div className="font-mono">
              {outcome.diff_stat.files} files changed · <span className="text-success">+{outcome.diff_stat.insertions}</span> / <span className="text-destructive">-{outcome.diff_stat.deletions}</span>
            </div>
          </div>
        )}

        {outcome.top_phases.length > 0 && (
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">耗时分布（top 3）</div>
            <ul className="font-mono">
              {outcome.top_phases.map((p) => (
                <li key={p.phase} className="flex justify-between">
                  <span>{p.phase}</span>
                  <span className="tabular-nums text-muted-foreground">{formatDuration(p.duration_ms)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {outcome.pr_url && (
            <Button variant="outline" size="sm" onClick={() => window.open(outcome.pr_url!, "_blank")} className="rounded-md font-mono text-[11px] ">
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> 看 PR
            </Button>
          )}
          {/* credential 类失败：建议先去 Setup 检查 provider 配置（重跑大概率还失败） */}
          {failureProfile?.primary === "check_config" && (
            <Button
              variant="default"
              size="sm"
              onClick={() => navigate("/setup")}
              className="rounded-md font-mono text-[11px] "
            >
              <ShieldAlert className="mr-1 h-3.5 w-3.5" /> 去 SETUP 检查
            </Button>
          )}
          {/* 失败时给"去工作流修复"出口：跳到独立工作流详情页 /workflows/:name?phase=&fromTask=，
              引导用户点对应 phase drawer。prompt 类失败时升级为 default variant，优先去改 prompt */}
          {outcome.status === "failed" && parseFailedPhase(taskStatus) && (
            <Button
              variant={failureProfile?.primary === "fix_prompt" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                const phase = parseFailedPhase(taskStatus);
                navigate(`/workflows/${encodeURIComponent(workflow)}?phase=${encodeURIComponent(phase!)}&fromTask=${encodeURIComponent(taskId)}`);
              }}
              className="rounded-md font-mono text-[11px] "
            >
              <Wrench className="mr-1 h-3.5 w-3.5" /> 去工作流修复
            </Button>
          )}
          {/* 重跑只在失败时给：cancelled 是终态无法重入队，done 不需要重跑。
              避免在已取消/已完成的工作页点"重跑"误起游离空 task。 */}
          {requirementId && outcome.status === "failed" && (
            // retry/unknown 类让"重跑"是 default；其他类型（fix_prompt / check_config / view_logs / phase_crash）
            // 都降级 outline，引导用户先做更对的事
            <Button
              variant={
                failureProfile?.primary === "retry" ? "default" : "outline"
              }
              size="sm"
              disabled={retrying}
              onClick={handleRetry}
              className="rounded-md font-mono text-[11px] "
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> {retrying ? "重跑中..." : "重跑"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
