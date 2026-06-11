/**
 * 需求详情页"下一步"主 CTA banner。
 *
 * 解决的产品断点：
 * 用户在需求生命周期里要走 drafting → clarifying → ready → awaiting_approval →
 * queued → running → done 这条链路，每一步都得停下来在右侧 ACTIONS 卡找下一个按钮。
 * 视觉上"标记已澄清" / "入队执行" / "审批通过" 跟"取消需求""删除需求"权重一样大，
 * 用户每次都要扫一遍才能找到当前该点哪个。
 *
 * 这个组件把"当前状态下唯一最重要的下一步动作"提到主区域顶部：
 *   - 大按钮 + 一句"接下来会发生什么"的辅助文案
 *   - 文案随 status 自动变化（"标为已澄清"→"入队执行"→"审批并开跑"...）
 *   - 终态 / 没有用户动作可做的状态（queued / running / done / cancelled）不渲染
 *
 * 右侧 ACTIONS 卡仍保留作为"完整操作"列表（含次要/危险动作）。
 */

import type { ReactNode } from "react";
import { ArrowRight, ArrowDown, RotateCcw, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NextStepConfig {
  cta: string;
  hint: string;
  Icon: typeof ArrowRight;
  action: "markReady" | "enqueue" | "approve" | "retry" | "scrollToQuestions" | "scrollToFeedback";
  /** failed 状态用 destructive 色调，其他用 accent */
  tone?: "accent" | "destructive";
}

export interface NextStepCTAProps {
  status: string;
  /** drafting/clarifying 时的未答问题数（影响 CTA 文案） */
  openQuestionCount?: number;
  busy?: boolean;
  /** 渲染在主按钮左侧的附加决策控件（如审批/入队/重试时的工作流选择） */
  extra?: ReactNode;
  onMarkReady?: () => void;
  onEnqueue?: () => void;
  onApprove?: () => void;
  onRetry?: () => void;
  onScrollToQuestions?: () => void;
  onScrollToFeedback?: () => void;
}

function resolve(status: string, openQuestionCount: number): NextStepConfig | null {
  // drafting 不出 banner：代码库确认卡自带「确认代码库，开始 AI 澄清」主按钮（带上下文的入口），
  // 这里再出一个「开始 AI 澄清」就是同一动作的重复入口。
  if (status === "clarifying") {
    if (openQuestionCount > 0) {
      return {
        cta: `去回答 ${openQuestionCount} 个问题`,
        hint: "AI 还有问题待你回答，回答完才能进入下一步。",
        Icon: ArrowDown,
        action: "scrollToQuestions",
      };
    }
    // clarifying + 没未答问题 = 跑批中（ClarifierProgressCard / Idle 兜底自己显示），不重复
    return null;
  }
  if (status === "ready") {
    return {
      cta: "入队执行",
      hint: "提交到任务队列，daemon 拿到 lock 后立刻开始跑工作流。",
      Icon: ArrowRight,
      action: "enqueue",
    };
  }
  if (status === "awaiting_approval") {
    return {
      cta: "审批通过，开跑",
      hint: "审阅下方规约，通过后任务进入队列立即执行。",
      Icon: Check,
      action: "approve",
    };
  }
  if (status === "awaiting_review") {
    return {
      cta: "去填写审查意见",
      hint: "PR 已生成，请在下方反馈区填写审查意见，或直接标记合并。",
      Icon: ArrowDown,
      action: "scrollToFeedback",
    };
  }
  if (status === "fix_revision") {
    return {
      cta: "去提交修复反馈",
      hint: "Agent 正在修复，可在下方反馈区注入新的修改建议。",
      Icon: ArrowDown,
      action: "scrollToFeedback",
    };
  }
  if (status === "failed") {
    return {
      cta: "重新入队执行",
      hint: "上次执行失败了。如果是 prompt 问题建议先去对应工作流改 prompt，否则可直接重跑。",
      Icon: RotateCcw,
      action: "retry",
      tone: "destructive",
    };
  }
  return null;
}

export function NextStepCTA(props: NextStepCTAProps) {
  const cfg = resolve(props.status, props.openQuestionCount ?? 0);
  if (!cfg) return null;

  const handler = (() => {
    switch (cfg.action) {
      case "markReady": return props.onMarkReady;
      case "enqueue": return props.onEnqueue;
      case "approve": return props.onApprove;
      case "retry": return props.onRetry;
      case "scrollToQuestions": return props.onScrollToQuestions;
      case "scrollToFeedback": return props.onScrollToFeedback;
    }
  })();

  if (!handler) return null;

  const isDanger = cfg.tone === "destructive";
  const containerClass = isDanger
    ? "border-destructive/40 bg-destructive/5"
    : "border-accent/40 bg-accent/5";
  const tagClass = isDanger
    ? "border-destructive/50 text-destructive"
    : "border-accent/50 text-accent";
  const Icon = cfg.Icon;

  return (
    <div
      className={`mb-6 flex flex-col gap-3 rounded-lg border ${containerClass} p-4 sm:flex-row sm:items-center sm:justify-between`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`shrink-0 rounded-md border px-2 py-1 text-[10px] ${tagClass}`}
        >
          下一步
        </span>
        <p className="text-sm leading-relaxed text-foreground">{cfg.hint}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {props.extra}
        <Button
          size="lg"
          variant={isDanger ? "destructive" : "default"}
          disabled={props.busy}
          onClick={handler}
          className="shrink-0 rounded-md text-xs"
        >
          {props.busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Icon className="mr-1.5 h-4 w-4" />}
          {props.busy ? "处理中…" : cfg.cta}
        </Button>
      </div>
    </div>
  );
}
