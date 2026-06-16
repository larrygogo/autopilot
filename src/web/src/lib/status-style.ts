/**
 * 状态视觉统一表达。
 *
 * 整个 web 的 task / phase / requirement 状态视觉单一真理源。
 * 各组件需要图标 / 颜色 / 中文标签时统一调 statusVisual(status) 或 statusLabel(status)。
 *
 * 颜色 = StatusTone（success/destructive/warning/accent/muted）—— 跟 Badge variant
 * 同名对齐，调用方可以直接 `<Badge variant={vis.tone}>`。
 * 图标用 lucide-react 或单字符（极简场景）。
 *
 * 当前覆盖：task status / phase status / requirement status（共用一套）。
 */

import { CheckCircle2, AlertCircle, XCircle, Loader2, Clock, Hand, HelpCircle } from "lucide-react";

export type StatusTone =
  | "success"
  | "destructive"
  | "warning"
  | "accent"
  | "muted";

export interface StatusVisual {
  /** lucide-react 图标组件 */
  Icon: typeof CheckCircle2;
  /** 中文短标签（CN）。已知 status 精确翻译；未知降级到原 status string */
  label: string;
  /** 单字符极简图标（适合卡片右上小角标 / 列表行） */
  glyph: string;
  /** 主色调，跟 Badge variant 同名 */
  tone: StatusTone;
  /** 是否动画（loading 类状态） */
  spin?: boolean;
}

// ──────────────────────────────────────────────
// 完整状态中文表 —— 优先精确匹配，未命中走前缀规则
// ──────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  pending: "待启动",
  queued: "已排队",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  error: "错误",
  cancelled: "已取消",
  canceled: "已取消",
  awaiting_approval: "等待审批",
  awaiting_review: "等待审阅",
  awaiting_input: "等待输入",
  investigating: "调查中",
  draft: "草稿",
};

/**
 * 状态字符串 → 中文短标签。
 * - 精确命中 STATUS_LABELS 直接返回
 * - 前缀模式（awaiting_xxx / running_xxx / pending_xxx / failed_xxx）保留 phase 后缀
 * - 未知降级到原 status string（不抛错，UI 至少能看到原值）
 */
export function statusLabel(status: string | null | undefined): string {
  const s = status ?? "";
  if (STATUS_LABELS[s]) return STATUS_LABELS[s];
  if (s.startsWith("awaiting_")) return `等待·${s.slice(9)}`;
  if (s.startsWith("running_")) return `运行·${s.slice(8)}`;
  if (s.startsWith("pending_")) return `待启动·${s.slice(8)}`;
  if (s.startsWith("failed_")) return `失败·${s.slice(7)}`;
  return s;
}

export function statusVisual(status: string | null | undefined): StatusVisual {
  const s = status ?? "";
  const label = statusLabel(s);

  if (s === "done") {
    return { Icon: CheckCircle2, label, glyph: "✓", tone: "success" };
  }
  if (s === "failed" || s.startsWith("failed_")) {
    return { Icon: AlertCircle, label, glyph: "✗", tone: "destructive" };
  }
  if (s === "cancelled" || s === "canceled") {
    return { Icon: XCircle, label, glyph: "⊘", tone: "muted" };
  }
  if (s.startsWith("running_") || s === "running") {
    return { Icon: Loader2, label, glyph: "▶", tone: "accent", spin: true };
  }
  if (s.startsWith("awaiting_")) {
    return { Icon: Hand, label, glyph: "⊙", tone: "warning" };
  }
  if (s.startsWith("pending_") || s === "pending" || s === "queued") {
    return { Icon: Clock, label, glyph: "·", tone: "muted" };
  }
  return { Icon: HelpCircle, label: label || "未知", glyph: "·", tone: "muted" };
}

/** tailwind text class（如 text-success） */
export function toneToTextClass(tone: StatusTone): string {
  switch (tone) {
    case "success": return "text-success";
    case "destructive": return "text-destructive";
    case "warning": return "text-warning";
    case "accent": return "text-accent";
    case "muted": return "text-muted-foreground";
  }
}
