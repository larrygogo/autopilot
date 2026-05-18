import React, { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../hooks/useApi";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";

interface PhaseMeta {
  phase: string;
  size: number;
  mtime: number;
}

interface Props {
  taskId: string;
  /** 当前 task.status — 用来判定选中 phase 是否还在 running，决定是否轮询拉新内容 */
  taskStatus?: string;
}

/** 当 selected phase 还在跑时，每 N 毫秒静默拉一次内容（避免日志墙静止假死） */
const LIVE_POLL_INTERVAL_MS = 4000;

function parseRunningPhase(status: string | undefined): string | null {
  if (!status) return null;
  const m = status.match(/^running_(.+)$/);
  return m ? m[1] : null;
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

export function PhaseLogsViewer({ taskId, taskStatus }: Props) {
  const { subscribe } = useWebSocket();
  const [phases, setPhases] = useState<PhaseMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set(ALL_LEVELS));
  /** 最近一次成功拉到内容的时刻，用来显示"快照于 HH:MM:SS" */
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);

  const runningPhase = parseRunningPhase(taskStatus);
  /** 选中的 phase 是否还在跑 — 决定是否启动轮询 + 是否显示"实时更新中" */
  const isLive = !!selected && selected === runningPhase;

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

  // 订阅 task:<id> 频道 — 状态切换时 refreshList，让新 phase 自动出现
  useEffect(() => {
    const off = subscribe(`task:${taskId}`, () => {
      void refreshList();
    });
    return () => off();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId, subscribe]);

  // selected 切换：拉一次内容（初次加载）
  useEffect(() => {
    if (!selected) {
      setContent("");
      setLastFetchAt(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .getPhaseLog(taskId, selected, 2000)
      .then((res) => {
        if (!cancelled) {
          setContent(res.content);
          setLastFetchAt(Date.now());
        }
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

  // selected 是当前 running phase 时启动轮询，phase 跑完 / 切走 / 任务终止后停掉
  useEffect(() => {
    if (!isLive || !selected) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api
        .getPhaseLog(taskId, selected, 2000)
        .then((res) => {
          if (cancelled) return;
          setContent(res.content);
          setLastFetchAt(Date.now());
        })
        .catch(() => { /* 静默：轮询失败不打扰用户，下个周期再试 */ });
    }, LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, selected, isLive]);

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
        <div className="flex items-center gap-3">
          <span className="bp-label">阶段日志 · PHASE LOGS</span>
          {/* 实时状态指示器 — 选中 phase 还在跑时显示呼吸点 + "LIVE"，否则显示快照时间 */}
          {isLive ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              实时更新中
            </span>
          ) : (
            lastFetchAt && (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                快照于 {new Date(lastFetchAt).toLocaleTimeString()}
              </span>
            )
          )}
        </div>
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
