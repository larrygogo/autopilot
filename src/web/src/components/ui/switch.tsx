import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * Claude 风 Switch：
 * - 圆角 pill track：开 = accent 珊瑚实填（亮），关 = foreground/25 中性灰实填（暗），
 *   两态明暗对比清晰、主题自适应（暗色下灰偏亮、亮色下灰偏深）
 * - thumb 始终白色圆滑块 + 柔阴影，两态一致。
 * - 居中靠 padding（p-0.5）+ thumb 高度=内容盒高度（size-4 in h-5，4px padding 后内容恰 16px）：
 *   thumb 顶天立地贴住上下 padding，无垂直缝隙可分不均，绝对垂直居中（比 border+items-center 的
 *   奇偶像素算缝更稳，避免视觉偏下）。
 */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-foreground/25",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
