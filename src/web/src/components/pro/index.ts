// L2a 场景组件（Pro 层）唯一规范导入面 —— 体系与使用规范见 docs/web-components.md。
// 新代码一律 `import { … } from "@/components/pro"`；存量旧路径走 touch-and-fix。
// 本文件必须保持无副作用（只有 re-export）。

// ── pro/ 目录内的物理新件 ──
export { EmptyState } from "./empty-state";
export { DescList, type DescItem } from "./desc-list";
export { FormField } from "./form-field";
export { ErrorState } from "./error-state";
export { SkeletonRows } from "./skeleton-rows";
export { PageShell } from "./page-shell";
export { DetailHeader } from "./detail-header";
export { FormDialog } from "./form-dialog";

// ── 存量散件收编（不搬文件，逻辑归位）──
export { PageHero } from "@/components/PageHero";
export {
  EntityGrid,
  EntityList,
  ViewToggle,
  useViewMode,
  type EntityCardItem,
} from "@/components/EntityCards";
// PipelineList 的通用半边（RequirementRow/TaskRow 是 L2b，不在此导出）
export { TimeGroupedList, RowCard, TONE, type TimedRow, type Tone } from "@/components/PipelineList";
export { ConfirmDialog } from "@/components/Modal";
export { PageLoader } from "@/components/PageLoader";
export { StatusBadge } from "@/components/StatusBadge";
export { StepBar } from "@/components/StepBar";
export { useToast } from "@/components/Toast";

// ── 布局常量（PageShell 落地后页面不再直接引用）──
export { PAGE_W, PAGE_W_FORM, PAGE_W_FOCUS } from "@/lib/layout";
