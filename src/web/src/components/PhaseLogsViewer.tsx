import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "../hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface PhaseMeta {
  phase: string;
  size: number;
  mtime: number;
}

interface Props {
  taskId: string;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const LEVEL_RE = /\s\[(INFO|WARN|ERROR|DEBUG)\]\s/;

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const ALL_LEVELS: Level[] = ["INFO", "WARN", "ERROR", "DEBUG"];

function extractLevel(line: string): Level | null {
  const m = line.match(LEVEL_RE);
  return (m?.[1] as Level) ?? null;
}

const LEVEL_TEXT: Record<Level, string> = {
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-destructive",
  DEBUG: "text-muted-foreground",
};

export function PhaseLogsViewer({ taskId }: Props) {
  const [phases, setPhases] = useState<PhaseMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set(ALL_LEVELS));

  const refreshList = async () => {
    try {
      const list = await api.getPhaseLogsList(taskId);
      setPhases(list);
      if (list.length > 0 && !selected) setSelected(list[0].phase);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    refreshList();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getPhaseLog(taskId, selected, 2000)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message ?? String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, selected]);

  const filtered = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const q = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (!line.trim()) return false;
      const lvl = extractLevel(line);
      if (lvl && !levels.has(lvl)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [content, query, levels]);

  const totalLines = useMemo(
    () => content.split("\n").filter((l) => l.trim()).length,
    [content],
  );

  const toggleLevel = (lvl: Level) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">阶段日志</h3>
        <Button variant="ghost" size="sm" onClick={refreshList} title="刷新阶段列表">
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </Button>
      </div>

      {phases.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          尚无阶段日志。任务开始执行阶段后会自动落盘。
        </p>
      ) : (
        <>
          {/* 阶段切换 */}
          <div className="scrollbar-thin mb-3 flex gap-1 overflow-x-auto border-b pb-1">
            {phases.map((p) => {
              const active = selected === p.phase;
              return (
                <button
                  key={p.phase}
                  type="button"
                  className={cn(
                    "shrink-0 rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors",
                    active
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setSelected(p.phase)}
                  title={`${formatSize(p.size)} · ${new Date(p.mtime).toLocaleString()}`}
                >
                  <span className="font-mono">{p.phase}</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    {formatSize(p.size)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 工具栏：搜索 + 级别筛选 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="搜索当前阶段日志…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {ALL_LEVELS.map((lvl) => {
                const on = levels.has(lvl);
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => toggleLevel(lvl)}
                    className={cn(
                      "inline-flex h-7 items-center rounded-full border px-2.5 text-[10px] font-mono font-medium transition-colors",
                      on
                        ? cn("border-current", LEVEL_TEXT[lvl])
                        : "border-border text-muted-foreground opacity-50 hover:opacity-100",
                    )}
                    aria-pressed={on}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>

          {err && (
            <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </p>
          )}

          {loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {content ? "（当前过滤条件下无匹配日志）" : "（空）"}
            </p>
          ) : (
            <pre className="scrollbar-thin max-h-[26rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
              {filtered.map((line, i) => {
                const lvl = extractLevel(line);
                return (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-words",
                      lvl ? LEVEL_TEXT[lvl] : "text-foreground",
                    )}
                  >
                    {line}
                  </div>
                );
              })}
            </pre>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">
            显示 {filtered.length} 行 / 总 {totalLines} 行（最多 2000 行，更早用{" "}
            <code className="rounded bg-muted px-1 font-mono">{`~/.autopilot/runtime/tasks/${taskId}/logs/phase-${selected}.log`}</code>
            ）
          </p>
        </>
      )}
    </Card>
  );
}
