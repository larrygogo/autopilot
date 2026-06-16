// L2b 业务复合件（v2 R6）：需求页执行记录区的多 run 横向切换器。
// 不进 pro barrel —— 绑定 Task/run 领域语义。内部由 L1 button + lib/run-label 纯逻辑组装。
//
// 设计约束（designer 已定）：
//  - 横向 segmented tabs，按 seq 升序左→右；默认选中最新（= req.task_id 或 ?run=）
//  - 单 run 时本组件不渲染（调用方判 runs.length>=2 才挂），避免「为将来多 run」预埋外壳噪音
//  - tab 两行：line-1 = kind 图标 + 业务标签；line-2 = 状态点 + 终态结果 + 相对时间
//  - 选中态 bg-muted + text-foreground；非选中透明底 + text-muted-foreground hover 提亮
//  - tab 间 border-border 中性分隔；禁彩色左条 / accent 边
//  - 内核名（TASK · kind · seq）只在 title/tooltip 叠加露出，不替换业务标签
import { Play, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  computeRunLabels,
  runOutcome,
  normKind,
  type RunLike,
  type RunOutcomeTone,
} from "@/lib/run-label";

interface RunSwitcherProps {
  /** 已按 seq 升序的根 run 列表（listTasksByRequirement 契约） */
  runs: RunLike[];
  activeTaskId: string;
  onSelect: (taskId: string) => void;
}

// 状态点色调 → 语义 token（不新增颜色）：done=success / failed=destructive /
// cancelled=中性灰 / active=accent。
const TONE_DOT: Record<RunOutcomeTone, string> = {
  done: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  active: "bg-accent",
};

/** 相对时间（轻量，避免引第三方）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
function relTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function RunSwitcher({ runs, activeTaskId, onSelect }: RunSwitcherProps) {
  const labels = computeRunLabels(runs);

  return (
    <div className="scrollbar-thin flex items-stretch overflow-x-auto border-b border-border" role="tablist">
      {runs.map((r) => {
        const active = r.id === activeTaskId;
        const label = labels.get(r.id) ?? "执行";
        const outcome = runOutcome(r);
        const KindIcon = normKind(r.kind) === "fix" ? Wrench : Play;
        const when = relTime(r.updated_at ?? r.created_at);
        // 内核名叠加：TASK 短 id · kind · seq —— 懂行的可反查
        const kernel = `TASK ${r.id.slice(0, 8)} · ${normKind(r.kind)}${r.seq != null ? ` · seq ${r.seq}` : ""}`;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={kernel}
            onClick={() => onSelect(r.id)}
            className={cn(
              "flex min-w-[8.5rem] shrink-0 flex-col gap-1 border-r border-border px-3.5 py-2 text-left transition-colors last:border-r-0",
              active
                ? "bg-muted text-foreground"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <KindIcon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </span>
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[outcome.tone])} />
              {outcome.prUrl ? (
                <a
                  href={outcome.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-accent hover:underline"
                >
                  {outcome.text}
                </a>
              ) : (
                <span>{outcome.text}</span>
              )}
              {when && <span className="text-muted-foreground/70">· {when}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
