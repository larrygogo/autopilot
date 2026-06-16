// L2a 页面容器：宽度档位 + 可选 PageHero + 页级状态闸门（error > loading > children）。
// 页面不再手拼 `<div className={PAGE_W}>` 与 if/else 三态。
// 规范见 docs/web-components.md §2.2 / §4。
import type { ComponentProps, ReactNode } from "react";
import { PageHero } from "@/components/PageHero";
import { PageLoader } from "@/components/PageLoader";
import { ErrorState } from "./error-state";
import { PAGE_W, PAGE_W_FOCUS, PAGE_W_FORM } from "@/lib/layout";

const WIDTH = {
  /** 内容/列表/详情页（6xl） */
  content: PAGE_W,
  /** 设置与表单页（4xl） */
  form: PAGE_W_FORM,
  /** 向导/聚焦流（2xl） */
  focus: PAGE_W_FOCUS,
} as const;

export function PageShell({
  width = "content",
  hero,
  loading,
  error,
  children,
}: {
  width?: keyof typeof WIDTH;
  /** 页头（PageHero 的 props 透传）；详情页用 DetailHeader 时不传 */
  hero?: ComponentProps<typeof PageHero>;
  /** 页级首次加载中（局部刷新不要用它，会闪整页） */
  loading?: boolean;
  /** 页级加载失败（优先级高于 loading） */
  error?: { message: string; detail?: string; onRetry?: () => void } | null;
  children?: ReactNode;
}) {
  return (
    <div className={WIDTH[width]}>
      {hero && <PageHero {...hero} />}
      {error ? (
        <ErrorState size="page" title={error.message} detail={error.detail} onRetry={error.onRetry} />
      ) : loading ? (
        <PageLoader />
      ) : (
        children
      )}
    </div>
  );
}
