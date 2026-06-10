import { useEffect, useState } from "react";
import { ChevronRight, FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { api, type TaskFileDiff } from "@/hooks/useApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** unified diff 行着色：+绿 / -红 / @@ hunk 头蓝灰 / 其他默认 */
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-success";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-destructive";
  if (line.startsWith("@@")) return "text-info";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-muted-foreground/60";
  return "text-foreground/80";
}

/**
 * 验收视图：任务工作树相对 base 分支的按文件 diff。
 * 每个文件一个可折叠块（默认收起，首文件展开），头部 +N/-N 统计。
 */
export function TaskFileDiffsCard({ taskId, reloadKey }: { taskId: string; reloadKey?: unknown }) {
  const [files, setFiles] = useState<TaskFileDiff[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const f = await api.getTaskDiffFiles(taskId);
      setFiles(f);
      // 默认展开第一个文件，其余收起
      if (f.length > 0) setOpen((prev) => (Object.keys(prev).length ? prev : { [f[0].file]: true }));
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, reloadKey]);

  if (loading && files === null) {
    return <Card className="p-5 text-xs text-muted-foreground">加载变更…</Card>;
  }
  if (!files || files.length === 0) {
    return (
      <Card className="p-5 text-xs text-muted-foreground">
        没有可显示的代码变更（工作树可能已被清理或无改动）。
      </Card>
    );
  }

  const totalIns = files.reduce((a, f) => a + f.insertions, 0);
  const totalDel = files.reduce((a, f) => a + f.deletions, 0);

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileDiffIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">代码变更</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {files.length} files · <span className="text-success">+{totalIns}</span> / <span className="text-destructive">-{totalDel}</span>
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="h-7 px-2 text-[11px]">
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </Button>
      </div>
      <div className="divide-y divide-border">
        {files.map((f) => {
          const isOpen = !!open[f.file];
          return (
            <div key={f.file}>
              <button
                type="button"
                onClick={() => setOpen((prev) => ({ ...prev, [f.file]: !prev[f.file] }))}
                className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/40"
              >
                <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.file}</span>
                <span className="shrink-0 font-mono text-[11px]">
                  <span className="text-success">+{f.insertions}</span>{" "}
                  <span className="text-destructive">-{f.deletions}</span>
                </span>
              </button>
              {isOpen && (
                <pre className="max-h-[480px] overflow-auto border-t border-border bg-muted/20 px-4 py-3 font-mono text-[11px] leading-relaxed">
                  {f.patch
                    ? f.patch.split("\n").map((line, i) => (
                        <div key={i} className={cn("whitespace-pre-wrap break-all", diffLineClass(line))}>
                          {line || " "}
                        </div>
                      ))
                    : <span className="text-muted-foreground">（二进制文件或无文本 diff）</span>}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
