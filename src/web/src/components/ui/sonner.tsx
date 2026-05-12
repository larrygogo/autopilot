import { useTheme } from "@/lib/theme";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * 蓝图风 Toast（基于 sonner）：
 *
 *  ┃ TITLE  IN  CAPS                    ×
 *  ┃ description in mono…
 *  ┃ [ACTION] [CANCEL]
 *  ─ 主体：纯色 popover 背景 + 1.5px foreground 边框 + 3px 硬阴影 + 方角
 *  ─ 语义：左侧 4px 色条按 data-type（success/info/warning/error）区分
 *  ─ 标题：font-display 全大写紧致字距
 *  ─ 描述：font-mono xs
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
            "!border-[1.5px] !border-foreground !rounded-none",
            "!shadow-[3px_3px_0_0_var(--color-foreground)]",
            // 左侧色条（默认 muted；按 data-type 覆盖）
            "before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[4px]",
            "before:bg-foreground/40 before:content-['']",
            "data-[type=success]:before:bg-success",
            "data-[type=info]:before:bg-accent",
            "data-[type=warning]:before:bg-warning",
            "data-[type=error]:before:bg-destructive",
          ].join(" "),
          title:
            "group-[.toast]:font-display group-[.toast]:font-bold group-[.toast]:uppercase group-[.toast]:tracking-wide group-[.toast]:text-foreground",
          description:
            "group-[.toast]:text-muted-foreground group-[.toast]:font-mono group-[.toast]:text-xs",
          icon: [
            "group-[.toast]:!h-4 group-[.toast]:!w-4",
            "group-data-[type=success]:[&_svg]:!text-success",
            "group-data-[type=info]:[&_svg]:!text-accent",
            "group-data-[type=warning]:[&_svg]:!text-warning",
            "group-data-[type=error]:[&_svg]:!text-destructive",
          ].join(" "),
          actionButton:
            "group-[.toast]:!bg-foreground group-[.toast]:!text-background group-[.toast]:!rounded-none group-[.toast]:font-mono group-[.toast]:text-[10px] group-[.toast]:uppercase group-[.toast]:tracking-widest",
          cancelButton:
            "group-[.toast]:!bg-transparent group-[.toast]:!text-muted-foreground group-[.toast]:!rounded-none group-[.toast]:font-mono group-[.toast]:text-[10px] group-[.toast]:uppercase group-[.toast]:tracking-widest group-[.toast]:!border group-[.toast]:!border-foreground/30",
          closeButton:
            "group-[.toast]:!bg-background group-[.toast]:!text-foreground group-[.toast]:!border group-[.toast]:!border-foreground/40 group-[.toast]:!rounded-none",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
