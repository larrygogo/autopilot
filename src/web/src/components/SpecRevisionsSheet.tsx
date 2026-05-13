import { useEffect, useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { api, type SpecRevision } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Loader2, X, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<SpecRevision["source"], string> = {
  clarifier: "AI 澄清",
  "user-edit": "你手动",
  system: "系统",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SpecRevisionsSheet({
  open,
  onOpenChange,
  requirementId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirementId: string;
}) {
  const toast = useToast();
  const [revisions, setRevisions] = useState<SpecRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setExpandedId(null);
    api.listSpecRevisions(requirementId)
      .then(setRevisions)
      .catch((e: unknown) => toast.error("加载失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [open, requirementId, toast]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[640px] max-w-full p-0 flex flex-col">
        <header className="flex items-center justify-between border-b-[1.5px] border-foreground/30 px-5 py-3.5 shrink-0">
          <div>
            <h2 className="font-display text-base font-bold uppercase tracking-wider">修订历史</h2>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5">
              共 {revisions.length} 条 · 最新在上
            </p>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            aria-label="关闭"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="font-mono text-xs uppercase tracking-[0.12em]">加载中…</span>
            </div>
          )}

          {!loading && revisions.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <p className="font-display text-lg">暂无修订</p>
              <p className="mt-1 font-mono text-xs uppercase tracking-[0.12em]">
                AI 澄清和手动编辑都会留下记录
              </p>
            </div>
          )}

          {!loading && revisions.map((rev) => {
            const isExpanded = expandedId === rev.id;
            return (
              <div key={rev.id} className="border-[1.5px] border-foreground/30 bg-card/40 rounded-none">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : rev.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                >
                  <ChevronRight className={cn(
                    "h-3.5 w-3.5 mt-0.5 shrink-0 transition-transform",
                    isExpanded && "rotate-90"
                  )} />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      <span>#{rev.id}</span>
                      <span>·</span>
                      <span>{SOURCE_LABEL[rev.source]}</span>
                      <span>·</span>
                      <span>{formatTime(rev.created_at)}</span>
                    </div>
                    {rev.summary && (
                      <p className="text-sm text-foreground line-clamp-2">{rev.summary}</p>
                    )}
                    {!rev.summary && (
                      <p className="text-sm text-muted-foreground italic">（无摘要）</p>
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-dashed border-foreground/25 grid grid-cols-1 md:grid-cols-2 gap-0 md:divide-x divide-foreground/25">
                    <div className="p-3 space-y-1.5 min-w-0">
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">修订前</div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground bg-muted/20 p-2 max-h-[400px] overflow-y-auto">
                        {rev.before_md || "（空）"}
                      </pre>
                    </div>
                    <div className="p-3 space-y-1.5 min-w-0">
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">修订后</div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground bg-accent/5 p-2 max-h-[400px] overflow-y-auto">
                        {rev.after_md || "（空）"}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <footer className="border-t-[1.5px] border-foreground/30 px-5 py-3 shrink-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            点条目展开看前后对比
          </p>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
