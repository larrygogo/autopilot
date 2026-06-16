import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { createTheme } from "@uiw/codemirror-themes";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { tags as t } from "@lezer/highlight";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTheme } from "@/lib/theme";

// ──────────────────────────────────────────────
// CodeMirror 6 代码编辑器封装（执行函数 workflow.ts 用）。
//   - 行号 + TS 语法高亮 + 活动行高亮 + 括号匹配；
//   - 默认不自动换行（出横向滚动条）；
//   - 主题对齐 claude.ai 暖色 token（亮/暗双套，跟随 useTheme）；
//   - 右上角「全屏」按钮 → fixed inset-0 满屏编辑，Esc / 收起退出。
// 受控契约与原 Textarea 一致：value / onChange(下一段完整源码字符串)。
// ──────────────────────────────────────────────

const MONO = '"JetBrains Mono", "Noto Sans SC", "Cascadia Code", ui-monospace, monospace';

// 亮主题：象牙奶油底上的低饱和暖色语法配色
const lightTheme = createTheme({
  theme: "light",
  settings: {
    background: "oklch(0.99 0.005 90)",
    foreground: "oklch(0.27 0.006 60)",
    caret: "oklch(0.64 0.13 42)",
    selection: "oklch(0.64 0.13 42 / 0.18)",
    selectionMatch: "oklch(0.64 0.13 42 / 0.12)",
    lineHighlight: "oklch(0.27 0.006 60 / 0.045)",
    gutterBackground: "oklch(0.99 0.005 90)",
    gutterForeground: "oklch(0.27 0.006 60 / 0.40)",
    gutterBorder: "transparent",
    fontFamily: MONO,
  },
  styles: [
    { tag: t.comment, color: "oklch(0.27 0.006 60 / 0.45)", fontStyle: "italic" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "oklch(0.55 0.16 38)" },
    { tag: [t.string, t.special(t.string)], color: "oklch(0.50 0.10 150)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "oklch(0.50 0.12 60)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "oklch(0.48 0.13 255)" },
    { tag: [t.typeName, t.className, t.namespace], color: "oklch(0.48 0.12 300)" },
    { tag: [t.propertyName, t.attributeName], color: "oklch(0.42 0.05 60)" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "oklch(0.40 0.03 60)" },
    { tag: [t.definition(t.variableName), t.variableName], color: "oklch(0.27 0.006 60)" },
  ],
});

// 暗主题：暖炭灰底上提亮的同色系
const darkTheme = createTheme({
  theme: "dark",
  settings: {
    background: "oklch(0.24 0.004 60)",
    foreground: "oklch(0.93 0.005 80)",
    caret: "oklch(0.74 0.13 42)",
    selection: "oklch(0.74 0.13 42 / 0.24)",
    selectionMatch: "oklch(0.74 0.13 42 / 0.16)",
    lineHighlight: "oklch(0.93 0.005 80 / 0.05)",
    gutterBackground: "oklch(0.24 0.004 60)",
    gutterForeground: "oklch(0.93 0.005 80 / 0.40)",
    gutterBorder: "transparent",
    fontFamily: MONO,
  },
  styles: [
    { tag: t.comment, color: "oklch(0.93 0.005 80 / 0.45)", fontStyle: "italic" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "oklch(0.78 0.14 40)" },
    { tag: [t.string, t.special(t.string)], color: "oklch(0.74 0.11 150)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "oklch(0.80 0.12 70)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "oklch(0.74 0.12 255)" },
    { tag: [t.typeName, t.className, t.namespace], color: "oklch(0.76 0.12 300)" },
    { tag: [t.propertyName, t.attributeName], color: "oklch(0.85 0.03 80)" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "oklch(0.82 0.02 80)" },
    { tag: [t.definition(t.variableName), t.variableName], color: "oklch(0.93 0.005 80)" },
  ],
});

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  searchKeymap: false,
  highlightSelectionMatches: false,
} as const;

const TS_EXTENSIONS = [javascript({ jsx: false, typescript: true }), keymap.of([indentWithTab])];

interface Props {
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  /** 非全屏时的高度（px），默认 224（= 旧 h-56） */
  heightPx?: number;
  /** 全屏头部展示的标题 */
  title?: string;
  readOnly?: boolean;
}

export function CodeEditor({ value, onChange, placeholder, heightPx = 224, title, readOnly }: Props) {
  const { resolved } = useTheme();
  const [full, setFull] = useState(false);

  // 全屏时 Esc 退出。用「捕获阶段」监听 + stopPropagation：抢在外层 Radix Sheet
  // 的 document 冒泡 Esc 处理之前消费掉，避免退出全屏的同时把整个抽屉也关掉。
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [full]);

  // ⚠ 全屏/内联不切换 DOM 父树——CodeMirror 始终挂在同一个 key=cm-host 的容器里，
  // 仅切外层与容器 className、增删 header/按钮，保住 EditorView 实例（光标/选区/滚动/撤销历史不丢）。
  // 三个子节点都带稳定 key，React 按 key 匹配，header 出现导致的同级位移不会误判重挂。
  return (
    <div className={full ? "fixed inset-0 z-[70] flex flex-col bg-background" : "relative"}>
      {full && (
        <div key="cm-fs-header" className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {title ?? "执行函数"} · workflow.ts
          </span>
          <button
            type="button"
            onClick={() => setFull(false)}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            收起（Esc）
          </button>
        </div>
      )}
      <div
        key="cm-host"
        className={full ? "min-h-0 flex-1 overflow-hidden" : "overflow-hidden rounded-md border border-border"}
      >
        <CodeMirror
          value={value}
          onChange={onChange}
          height={full ? "100%" : `${heightPx}px`}
          theme={resolved === "dark" ? darkTheme : lightTheme}
          extensions={TS_EXTENSIONS}
          placeholder={placeholder}
          editable={!readOnly}
          basicSetup={BASIC_SETUP}
          style={{ fontSize: 12, ...(full ? { height: "100%" } : {}) }}
        />
      </div>
      {!full && (
        <button
          key="cm-fs-btn"
          type="button"
          onClick={() => setFull(true)}
          title="全屏编辑"
          className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/80 p-1 text-muted-foreground backdrop-blur transition-colors hover:bg-card hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
