import { useTheme } from "@/lib/theme";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Claude 风 Toast（基于 sonner）：
 *
 *  ┃ Title                              ×
 *  ┃ description…
 *  ┃ [Action] [Cancel]
 *  ─ 主体：纯色 popover 背景 + 1px 淡边框 + 柔投影 + 圆角
 *  ─ 语义：左侧 4px 色条按 data-type（success/info/warning/error）区分
 *  ─ 标题：font-display
 *  ─ 描述：sans sm
 *
 *  关键点：不使用 sonner 的 `richColors`——它会强行注入彩色背景，
 *         覆盖我们的自定义 classNames。
 */
export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: [
            "group toast relative pl-4",
            "!bg-popover !text-popover-foreground",
            "!border !border-border !rounded-lg",
            "!shadow-md",
            // 左侧色条（默认 muted；按 data-type 覆盖）
            "before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[4px]",
            "before:bg-foreground/40 before:content-['']",
            "data-[type=success]:before:bg-success",
            "data-[type=info]:before:bg-accent",
            "data-[type=warning]:before:bg-warning",
            "data-[type=error]:before:bg-destructive",
          ].join(" "),
          title:
            "group-[.toast]:font-display group-[.toast]:font-bold group-[.toast]:text-foreground",
          description:
            "group-[.toast]:text-muted-foreground group-[.toast]:text-sm",
          icon: [
            "group-[.toast]:!h-4 group-[.toast]:!w-4",
            "group-data-[type=success]:[&_svg]:!text-success",
            "group-data-[type=info]:[&_svg]:!text-accent",
            "group-data-[type=warning]:[&_svg]:!text-warning",
            "group-data-[type=error]:[&_svg]:!text-destructive",
          ].join(" "),
          actionButton:
            "group-[.toast]:!bg-foreground group-[.toast]:!text-background group-[.toast]:!rounded-md group-[.toast]:text-xs",
          cancelButton:
            "group-[.toast]:!bg-transparent group-[.toast]:!text-muted-foreground group-[.toast]:!rounded-md group-[.toast]:text-xs group-[.toast]:!border group-[.toast]:!border-border",
          closeButton:
            "group-[.toast]:!bg-background group-[.toast]:!text-foreground group-[.toast]:!border group-[.toast]:!border-border group-[.toast]:!rounded-md",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
