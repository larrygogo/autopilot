import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * 蓝图风 markdown 渲染。统一样式，比 <pre> raw 文本好看。
 * 用法：<MarkdownView content={text} />
 */
export function MarkdownView({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("prose-bp", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...props }) => (
            <h1 className="mt-2 mb-3 font-display text-xl font-bold uppercase tracking-wide text-foreground border-b border-foreground/30 pb-2" {...props} />
          ),
          h2: ({ node, ...props }) => (
            <h2 className="mt-5 mb-2 font-display text-base font-bold uppercase tracking-wide text-foreground" {...props} />
          ),
          h3: ({ node, ...props }) => (
            <h3 className="mt-4 mb-1.5 font-display text-sm font-bold uppercase tracking-wide text-foreground" {...props} />
          ),
          p: ({ node, ...props }) => (
            <p className="my-2 text-sm leading-relaxed text-foreground" {...props} />
          ),
          ul: ({ node, ...props }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 text-sm leading-relaxed text-foreground" {...props} />
          ),
          ol: ({ node, ...props }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 text-sm leading-relaxed text-foreground" {...props} />
          ),
          li: ({ node, ...props }) => (
            <li className="text-sm leading-relaxed" {...props} />
          ),
          code: ({ node, className: cls, children, ...props }) => {
            const isInline = !cls;
            if (isInline) {
              return (
                <code
                  className="rounded-none border border-foreground/25 bg-muted/50 px-1 py-0.5 font-mono text-[12px] text-foreground"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-xs", cls)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ node, ...props }) => (
            <pre
              className="my-3 overflow-x-auto border border-foreground/25 bg-muted/30 p-3 font-mono text-xs leading-relaxed scrollbar-thin"
              {...props}
            />
          ),
          blockquote: ({ node, ...props }) => (
            <blockquote
              className="my-3 border-l-2 border-accent bg-accent/5 px-3 py-2 text-sm text-muted-foreground italic"
              {...props}
            />
          ),
          a: ({ node, ...props }) => (
            <a className="text-accent underline hover:no-underline" target="_blank" rel="noreferrer" {...props} />
          ),
          hr: ({ node, ...props }) => (
            <hr className="my-4 border-t border-dashed border-foreground/30" {...props} />
          ),
          table: ({ node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse border border-foreground/25 text-sm" {...props} />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th className="border border-foreground/25 bg-muted/40 px-3 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider" {...props} />
          ),
          td: ({ node, ...props }) => (
            <td className="border border-foreground/25 px-3 py-1.5 text-sm" {...props} />
          ),
          strong: ({ node, ...props }) => (
            <strong className="font-semibold text-foreground" {...props} />
          ),
          em: ({ node, ...props }) => (
            <em className="italic text-muted-foreground" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
