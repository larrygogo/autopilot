import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 蓝图风 Checkbox：
 * - 方角 + 1.5px foreground 描边（与 Input / Switch 一致）
 * - 选中时填 accent 色 + 白对勾
 * - 支持 indeterminate（通过 ref 设置 input.indeterminate）
 * - 完全原生 input，保留表单与可访问性语义
 */
export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  indeterminate?: boolean;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);

    // 把内部 ref 暴露给外部传入的 ref（支持 forwardRef + 本地引用并存）
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    React.useEffect(() => {
      if (innerRef.current) {
        innerRef.current.indeterminate = Boolean(indeterminate);
      }
    }, [indeterminate]);

    return (
      <input
        ref={innerRef}
        type="checkbox"
        className={cn("bp-checkbox", className)}
        {...props}
      />
    );
  },
);
Checkbox.displayName = "Checkbox";
