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
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-dashed border-foreground/25 px-4 py-2.5">
        <span className="bp-label">阶段日志 · PHASE LOGS</span>
        <Button variant="ghost" size="sm" onClick={refreshList} title="刷新阶段列表">
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </Button>
      </div>

      <div className="p-4">
        {phases.length === 0 ? (
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            尚无阶段日志。任务开始执行阶段后会自动落盘。
          </p>
        ) : (
          <>
            {/* 阶段切换 — 蓝图风方角下划线 tab */}
            <div className="scrollbar-thin mb-3 flex gap-0 overflow-x-auto border-b border-foreground/25">
              {phases.map((p) => {
                const active = selected === p.phase;
                return (
                  <button
                    key={p.phase}
                    type="button"
                    className={cn(
                      "shrink-0 -mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors",
                      active
                        ? "border-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/40",
                    )}
                    onClick={() => setSelected(p.phase)}
                    title={`${formatSize(p.size)} · ${new Date(p.mtime).toLocaleString()}`}
                  >
                    <span>{p.phase}</span>
                    <span className="ml-1.5 text-[10px] normal-case text-muted-foreground">
                      {formatSize(p.size)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 工具栏：搜索 + 级别筛选（蓝图风方角） */}
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
              <div className="flex shrink-0 items-center gap-0 border border-foreground/30">
                {ALL_LEVELS.map((lvl) => {
                  const on = levels.has(lvl);
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => toggleLevel(lvl)}
                      className={cn(
                        "inline-flex h-9 items-center border-r border-foreground/20 px-2.5 font-mono text-[10px] uppercase tracking-[0.15em] font-medium transition-colors last:border-r-0",
                        on
                          ? cn("bg-foreground/5", LEVEL_TEXT[lvl])
                          : "text-muted-foreground opacity-40 hover:opacity-100",
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
              <p className="mb-2 border-[1.5px] border-destructive bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                {err}
              </p>
            )}

            {loading ? (
              <p className="px-1 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                加载中…
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-1 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                {content ? "（当前过滤条件下无匹配日志）" : "（空）"}
              </p>
            ) : (
              <pre className="scrollbar-thin max-h-[26rem] overflow-auto border border-foreground/25 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
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

            <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              显示 {filtered.length} / 总 {totalLines} 行（最多 2000 行，更早用{" "}
              <code className="border border-foreground/20 bg-muted px-1 normal-case tracking-normal">{`~/.autopilot/runtime/tasks/${taskId}/logs/phase-${selected}.log`}</code>
              ）
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
