import { useMemo, useRef } from "react";
import { Braces } from "lucide-react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  MatchDecorator,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// 提示词编辑器：变量面板（中文 chips 点击插入）+ 「框内把 ${...} 渲染成中文药丸」。
//
// 关键：用 CodeMirror 的 replace-widget 装饰把每个 ${...} 原子替换成一颗「中文 pill」——
// 框里看到的是中文（如「需求」），但文档底层仍是 ${REQUIREMENT}（onChange 拿到真 token）。
// 光标把 pill 当一个整体（atomicRanges），删除即删整个占位符；要改参数化的就删了从变量面板重插。
//
// 多语言口子（i18n seam）：组件接收 lang prop，所有 UI 文案 + 变量标签都走按 lang 取值的
// Record；新增一门语言 = 扩 Lang 类型 + 在各 Record 里补一项，无需改逻辑。
// 变量真相源对齐 src/core/workflow/prompt-runner.ts 的 expandPromptTemplate。
// ──────────────────────────────────────────────

export type PromptLang = "zh" | "en";

interface VarDef {
  /** 完整 token（精确匹配时的 pill 文案来源） */
  token: string;
  /** 参数化变量的实际插入文本（半成品，光标落参数位）；缺省=token */
  insert?: string;
  /** 插入后光标回退几位 */
  caretBack?: number;
  label: Record<PromptLang, string>;
  desc: Record<PromptLang, string>;
}

const VARS: VarDef[] = [
  { token: "${REQUIREMENT}", label: { zh: "需求", en: "Requirement" }, desc: { zh: "用户需求详情全文", en: "Full requirement text" } },
  { token: "${HANDOFF}", label: { zh: "上游摘要", en: "Handoff" }, desc: { zh: "之前所有阶段的交付摘要拼接", en: "All upstream phases' handoff summaries" } },
  { token: "${HANDOFF_design}", insert: "${HANDOFF_}", caretBack: 1, label: { zh: "指定阶段摘要", en: "Phase handoff" }, desc: { zh: "某阶段的交付摘要——_ 后补阶段名，如 ${HANDOFF_design}", en: "A phase's handoff — append phase name after _" } },
  { token: "${REJECTION}", label: { zh: "驳回理由", en: "Rejection" }, desc: { zh: "上一轮驳回理由（重做轮自动带，首轮为空）", en: "Last rejection reason (auto on redo)" } },
  { token: "${WORKSPACE}", label: { zh: "代码目录", en: "Workspace" }, desc: { zh: "当前阶段代码工作目录的绝对路径", en: "Absolute path of the code workdir" } },
  { token: "${TASK_TITLE}", label: { zh: "任务标题", en: "Task title" }, desc: { zh: "任务标题", en: "Task title" } },
  { token: "${PHASE}", label: { zh: "当前阶段", en: "Phase" }, desc: { zh: "当前阶段的标识符", en: "Current phase name" } },
  { token: "${REJECTION_COUNT}", label: { zh: "驳回次数", en: "Rejections" }, desc: { zh: "累计驳回轮数", en: "Total rejection rounds" } },
  { token: "${TASK_ID}", label: { zh: "任务 ID", en: "Task ID" }, desc: { zh: "任务 id", en: "Task id" } },
  { token: "${TASK.repo_path}", insert: "${TASK.}", caretBack: 1, label: { zh: "任务字段", en: "Task field" }, desc: { zh: "任务行任意字段——. 后补字段名，如 ${TASK.repo_path}", en: "Any task field — append field name after ." } },
];

const UI_TEXT: Record<PromptLang, { vars: string }> = {
  zh: { vars: "变量" },
  en: { vars: "Vars" },
};

/** token → pill 里显示的标签（精确命中走字典；参数化的 ${HANDOFF_x}/${TASK.x} 派生；未知原样）。 */
function pillLabel(token: string, lang: PromptLang): string {
  const exact = VARS.find((v) => v.token === token);
  if (exact) return exact.label[lang];
  const inner = token.slice(2, -1); // 去掉 ${ 与 }
  if (inner.startsWith("HANDOFF_")) {
    const p = inner.slice("HANDOFF_".length);
    return (lang === "zh" ? "阶段摘要·" : "handoff·") + (p || "?");
  }
  if (inner.startsWith("TASK.")) {
    const f = inner.slice("TASK.".length);
    return (lang === "zh" ? "字段·" : "field·") + (f || "?");
  }
  return token; // 未知占位符原样显示，不藏
}

// ── pill widget：把 ${...} 渲染成一颗药丸 ──
class VarPill extends WidgetType {
  constructor(readonly token: string, readonly text: string) {
    super();
  }
  eq(o: VarPill) {
    return o.token === this.token && o.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-var-pill";
    s.textContent = this.text;
    s.title = this.token; // hover 看真 token
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

function pillPlugin(lang: PromptLang) {
  const matcher = new MatchDecorator({
    regexp: /\$\{[^}]*\}/g,
    decoration: (m) => Decoration.replace({ widget: new VarPill(m[0], pillLabel(m[0], lang)) }),
  });
  return ViewPlugin.fromClass(
    class {
      pills: DecorationSet;
      constructor(view: EditorView) {
        this.pills = matcher.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.pills = matcher.updateDeco(u, this.pills);
      }
    },
    {
      decorations: (v) => v.pills,
      // 光标把 pill 当整体跳过/整体删
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.pills ?? Decoration.none),
    },
  );
}

// 主题：sans 字体（与其它输入一致）+ 用 CSS 变量适配亮/暗 + pill 珊瑚橘样式。
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: '"Manrope", "Noto Sans SC", system-ui, sans-serif',
    padding: "8px 12px",
    caretColor: "var(--foreground)",
    lineHeight: "1.6",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  // drawSelection 自绘选区层，按主题色染（否则深色下不可见 / 用默认白底色）
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, & .cm-selectionLayer .cm-selectionBackground": {
    background: "color-mix(in oklch, var(--accent) 22%, transparent)",
  },
  ".cm-var-pill": {
    display: "inline-block",
    padding: "0 5px",
    margin: "0 1px",
    borderRadius: "5px",
    fontSize: "88%",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    cursor: "default",
    background: "color-mix(in oklch, var(--accent) 16%, transparent)",
    color: "var(--accent)",
    border: "1px solid color-mix(in oklch, var(--accent) 32%, transparent)",
  },
});

const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  bracketMatching: false,
  closeBrackets: false,
  autocompletion: false,
  searchKeymap: false,
  highlightSelectionMatches: false,
  drawSelection: true,
  history: true,
  defaultKeymap: true,
} as const;

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeightPx?: number;
  /** 多语言口子，默认中文 */
  lang?: PromptLang;
}

export function PromptEditor({ value, onChange, placeholder, minHeightPx = 120, lang = "zh" }: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const extensions = useMemo(() => [pillPlugin(lang), EditorView.lineWrapping, editorTheme], [lang]);

  function insert(v: VarDef) {
    const text = v.insert ?? v.token;
    const view = cmRef.current?.view;
    if (!view) {
      onChange(value + text);
      return;
    }
    const { from, to } = view.state.selection.main;
    const caret = from + text.length - (v.caretBack ?? 0);
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: caret } });
    view.focus();
  }

  return (
    <div className="space-y-1.5">
      {/* 变量面板：点击插入到光标处 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 pr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          <Braces className="h-3 w-3 text-accent/70" />
          {UI_TEXT[lang].vars}
        </span>
        {VARS.map((v) => (
          <button
            key={v.token}
            type="button"
            onClick={() => insert(v)}
            title={`${v.token} — ${v.desc[lang]}`}
            className="rounded-full border border-border/60 bg-muted/30 px-2.5 py-0.5 text-[11px] leading-5 text-muted-foreground transition-all hover:-translate-y-px hover:border-accent/50 hover:bg-accent/10 hover:text-accent hover:shadow-sm active:translate-y-0"
          >
            {v.label[lang]}
          </button>
        ))}
      </div>

      <div className={cn("overflow-hidden rounded-md border border-input")}>
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          extensions={extensions}
          basicSetup={BASIC_SETUP}
          placeholder={placeholder}
          minHeight={`${minHeightPx}px`}
          theme="none"
        />
      </div>
    </div>
  );
}
