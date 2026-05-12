import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Props {
  /** 当前选中的 model id；空串/undefined 视为未选 */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** catalog 列表（来自 /api/providers/<name>/models） */
  options: string[];
  /** trigger 占位（未选中时显示） */
  placeholder?: string;
  /** 是否显示清空按钮（值非空时） */
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  /** 触发按钮 id（配合外层 label htmlFor） */
  id?: string;
}

/**
 * 模型选择 Combobox：
 * - 触发按钮显示当前值或 placeholder
 * - 弹出层顶部搜索框；列表展示 catalog 选项
 * - 输入串不在 catalog 中且非空时，列表底部出现 "+ 使用 \"<input>\"" 行允许自定义
 * - 蓝图风：方角、厚边框、硬阴影
 */
export function ModelCombobox({
  value,
  onChange,
  options,
  placeholder = "选择或输入模型 id",
  clearable = false,
  disabled,
  className,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 关闭面板时清空搜索框
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const trimmed = query.trim();
  const customAvailable =
    trimmed.length > 0 && !options.includes(trimmed) && trimmed !== value;

  const filtered = useMemo(() => {
    if (!trimmed) return options;
    const q = trimmed.toLowerCase();
    return options.filter((m) => m.toLowerCase().includes(q));
  }, [options, trimmed]);

  const commit = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          ref={triggerRef}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-none border-[1.5px] border-foreground/35 bg-background px-3 py-2 text-sm font-mono transition-colors focus:outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50",
            !value && "text-muted-foreground font-sans",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <span className="ml-2 flex items-center gap-1">
            {clearable && value && !disabled && (
              <span
                role="button"
                tabIndex={-1}
                onPointerDown={(e) => {
                  // 阻止触发 Popover 打开
                  e.preventDefault();
                  e.stopPropagation();
                  commit(undefined);
                }}
                className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label="清空"
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <ChevronDown className="h-4 w-4 opacity-60" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="搜索或输入自定义 id…"
          />
          <CommandList>
            {filtered.length === 0 && !customAvailable && (
              <CommandEmpty>无匹配模型</CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading="可选模型">
                {filtered.map((m) => (
                  <CommandItem
                    key={m}
                    value={m}
                    onSelect={() => commit(m)}
                    className="font-mono"
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5",
                        value === m ? "opacity-100 text-accent" : "opacity-0",
                      )}
                    />
                    <span>{m}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {customAvailable && (
              <>
                {filtered.length > 0 && <CommandSeparator />}
                <CommandGroup heading="自定义">
                  <CommandItem
                    value={`__custom__:${trimmed}`}
                    onSelect={() => commit(trimmed)}
                    className="font-mono"
                  >
                    <Plus className="h-3.5 w-3.5 text-accent" />
                    <span>
                      使用 <span className="text-accent">"{trimmed}"</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
