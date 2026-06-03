import { useTheme } from "@/lib/theme";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Claude 风 Toast（基于 sonner）：简洁卡片。
 *  ─ 主体：纯色 popover 背景 + 1px 淡边框 + 柔投影 + 圆角
 *  ─ 图标按 data-type（success/info/warning/error）着语义色
 *  ─ 标题 sans semibold / 描述 sans sm
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
            "group toast",
            "!bg-popover !text-popover-foreground",
            "!border !border-border !rounded-lg",
            "!shadow-md",
          ].join(" "),
          title:
            "group-[.toast]:font-semibold group-[.toast]:text-foreground",
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
