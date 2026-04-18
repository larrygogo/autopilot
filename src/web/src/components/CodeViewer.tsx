import React, { useMemo } from "react";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// 极简 TS 语法高亮 —— 只分区字符串/注释/关键字/数字
// 不做 AST 解析，意在可读而非精确；避免引入 hljs/prism 依赖
// ──────────────────────────────────────────────

type Tok = { type: "plain" | "comment" | "string" | "keyword" | "number" | "fn"; value: string };

const KEYWORDS = new Set([
  "import", "export", "from", "as", "default",
  "const", "let", "var", "function", "return", "async", "await",
  "class", "extends", "new", "this", "super",
  "if", "else", "for", "while", "do", "break", "continue", "switch", "case",
  "try", "catch", "finally", "throw",
  "type", "interface", "enum", "namespace",
  "true", "false", "null", "undefined", "void",
  "in", "of", "instanceof", "typeof",
  "public", "private", "protected", "readonly", "static",
]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => { if (plain) { out.push({ type: "plain", value: plain }); plain = ""; } };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // 单行注释
    if (c === "/" && next === "/") {
      flushPlain();
      let end = i;
      while (end < src.length && src[end] !== "\n") end++;
      out.push({ type: "comment", value: src.slice(i, end) });
      i = end;
      continue;
    }
    // 多行注释
    if (c === "/" && next === "*") {
      flushPlain();
      let end = i + 2;
      while (end < src.length - 1 && !(src[end] === "*" && src[end + 1] === "/")) end++;
      end += 2;
      out.push({ type: "comment", value: src.slice(i, end) });
      i = end;
      continue;
    }
    // 字符串 / 模板字符串
    if (c === "\"" || c === "'" || c === "`") {
      flushPlain();
      const quote = c;
      let end = i + 1;
      while (end < src.length && src[end] !== quote) {
        if (src[end] === "\\") { end += 2; continue; }
        end++;
      }
      end++;
      out.push({ type: "string", value: src.slice(i, end) });
      i = end;
      continue;
    }
    // 数字（简单）
    if (/[0-9]/.test(c) && !/[A-Za-z_]/.test(src[i - 1] ?? "")) {
      flushPlain();
      let end = i;
      while (end < src.length && /[0-9_.]/.test(src[end])) end++;
      out.push({ type: "number", value: src.slice(i, end) });
      i = end;
      continue;
    }
    // 标识符
    if (/[A-Za-z_$]/.test(c)) {
      let end = i;
      while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end++;
      const ident = src.slice(i, end);
      flushPlain();
      if (KEYWORDS.has(ident)) {
        out.push({ type: "keyword", value: ident });
      } else if (ident.startsWith("run_")) {
        out.push({ type: "fn", value: ident });
      } else {
        plain += ident;
      }
      i = end;
      continue;
    }
    plain += c;
    i++;
  }
  flushPlain();
  return out;
}

// 各 token 类型对应的 Tailwind 色 —— 用语义 token 而非霓虹色
const TOK_CLASS: Record<Tok["type"], string> = {
  plain: "",
  comment: "text-muted-foreground italic",
  string: "text-success",
  keyword: "text-primary font-medium",
  number: "text-warning",
  fn: "text-info",
};

function renderTokens(tokens: Tok[], highlightFn?: string): React.ReactNode[] {
  return tokens.map((t, i) => {
    if (t.type === "plain") return t.value;
    const isHl = t.type === "fn" && highlightFn && t.value === `run_${highlightFn}`;
    return (
      <span
        key={i}
        className={cn(
          TOK_CLASS[t.type],
          isHl && "rounded bg-primary/15 px-0.5 text-primary font-semibold ring-1 ring-primary/30",
        )}
      >
        {t.value}
      </span>
    );
  });
}

interface Props {
  code: string;
  /** 若提供，代码里 run_<name> 会以主题色高亮 */
  highlightPhase?: string | null;
  /** 自动滚到 run_<name> 所在行 */
  scrollToPhase?: string | null;
}

export function CodeViewer({ code, highlightPhase, scrollToPhase }: Props) {
  const lines = useMemo(() => code.split("\n"), [code]);
  const tokens = useMemo(() => tokenize(code), [code]);
  const lineCount = lines.length;
  const digitWidth = String(lineCount).length;

  // 把 tokens 按行切开
  const lineTokens = useMemo(() => splitByLine(tokens), [tokens]);

  const ref = React.useRef<HTMLDivElement>(null);
  const lineRefs = React.useRef<Array<HTMLDivElement | null>>([]);

  React.useEffect(() => {
    if (!scrollToPhase) return;
    // 查找包含 `function run_<scrollToPhase>(` 或 `const run_<scrollToPhase>` 的行号
    const re = new RegExp(`function\\s+run_${scrollToPhase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b|const\\s+run_${scrollToPhase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const lineIdx = lines.findIndex((l) => re.test(l));
    if (lineIdx >= 0) {
      lineRefs.current[lineIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [scrollToPhase, lines]);

  return (
    <div
      ref={ref}
      className="scrollbar-thin max-h-[32rem] overflow-auto rounded-md border bg-muted/40 py-2 font-mono text-xs leading-relaxed"
    >
      {lineTokens.map((lt, i) => (
        <div
          key={i}
          ref={(el) => { lineRefs.current[i] = el; }}
          className="flex whitespace-pre hover:bg-accent/40"
        >
          <span
            className="select-none pr-3 pl-2 text-right text-muted-foreground/70"
            style={{ width: `${digitWidth + 2}ch` }}
          >
            {i + 1}
          </span>
          <span className="flex-1 pr-3 text-foreground">
            {lt.length > 0 ? renderTokens(lt, highlightPhase ?? undefined) : "\u00A0"}
          </span>
        </div>
      ))}
    </div>
  );
}

function splitByLine(tokens: Tok[]): Tok[][] {
  const lines: Tok[][] = [[]];
  for (const t of tokens) {
    const parts = t.value.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i].length > 0) {
        lines[lines.length - 1].push({ type: t.type, value: parts[i] });
      }
    }
  }
  return lines;
}
