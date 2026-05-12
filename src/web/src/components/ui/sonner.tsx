import { useTheme } from "@/lib/theme";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * 蓝图风 Toast（基于 sonner）：
 * - 方角 + 厚边框 + 硬阴影
 * - 标题用 sans，描述用 mono
 */
export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-[1.5px] group-[.toaster]:border-foreground group-[.toaster]:rounded-none group-[.toaster]:shadow-[3px_3px_0_0_var(--color-foreground)]",
          title: "group-[.toast]:font-display group-[.toast]:font-bold group-[.toast]:uppercase group-[.toast]:tracking-wide",
          description: "group-[.toast]:text-muted-foreground group-[.toast]:font-mono group-[.toast]:text-xs",
          actionButton:
            "group-[.toast]:bg-foreground group-[.toast]:text-background group-[.toast]:rounded-none group-[.toast]:font-mono group-[.toast]:text-[10px] group-[.toast]:uppercase group-[.toast]:tracking-widest",
          cancelButton:
            "group-[.toast]:bg-transparent group-[.toast]:text-muted-foreground group-[.toast]:rounded-none group-[.toast]:font-mono group-[.toast]:text-[10px] group-[.toast]:uppercase group-[.toast]:tracking-widest group-[.toast]:border group-[.toast]:border-foreground/30",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
