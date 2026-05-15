/**
 * 状态视觉统一表达。
 *
 * 整个 web 之前有三套独立的状态视觉系统散落（StatusBadge / TaskOutcomeCard.statusIcon /
 * WorkflowCatalog.statusIcon），颜色和文案有出入。这里收口成单一来源：
 *
 *   - 各组件需要图标 / 颜色 / 中文标签时统一调 statusVisual(status)
 *   - 颜色用 theme token（success / destructive / warning / accent / muted-foreground）
 *   - 图标用 lucide-react 或单字符（适合极简场景）
 *
 * 当前覆盖：task status / phase status（共用一套）。
 * Requirement status 在 RequirementProgressBar 内有自己的 4 步抽象，不在此重叠。
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
  /** 中文短标签（CN） */
  label: string;
  /** 单字符极简图标（适合卡片右上小角标 / 列表行） */
  glyph: string;
  /** 主色调（用作 tailwind class 后缀） */
  tone: StatusTone;
  /** 是否动画（loading 类状态） */
  spin?: boolean;
}

export function statusVisual(status: string | null | undefined): StatusVisual {
  const s = status ?? "";

  if (s === "done") {
    return { Icon: CheckCircle2, label: "已完成", glyph: "✓", tone: "success" };
  }
  if (s === "failed" || s.startsWith("failed_")) {
    return { Icon: AlertCircle, label: "失败", glyph: "✗", tone: "destructive" };
  }
  if (s === "cancelled" || s === "canceled") {
    return { Icon: XCircle, label: "已取消", glyph: "⊘", tone: "muted" };
  }
  if (s.startsWith("running_")) {
    return { Icon: Loader2, label: "运行中", glyph: "▶", tone: "accent", spin: true };
  }
  if (s.startsWith("awaiting_")) {
    return { Icon: Hand, label: "等待人工", glyph: "⊙", tone: "warning" };
  }
  if (s.startsWith("pending_")) {
    return { Icon: Clock, label: "待启动", glyph: "·", tone: "muted" };
  }
  return { Icon: HelpCircle, label: s || "未知", glyph: "·", tone: "muted" };
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

/** tailwind border class（左边框用于列表行）— 如 border-l-success */
export function toneToBorderLeftClass(tone: StatusTone): string {
  switch (tone) {
    case "success": return "border-l-success";
    case "destructive": return "border-l-destructive";
    case "warning": return "border-l-warning";
    case "accent": return "border-l-accent";
    case "muted": return "border-l-foreground/40";
  }
}
