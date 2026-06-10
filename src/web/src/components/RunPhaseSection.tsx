// GA 式执行视图的单个 phase 折叠 section：header（状态/耗时/ⓘ/chevron）+
// 日志区（懒加载 + running 时轮询/WS 增量 + 底部追尾）。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Info, RotateCcw, Loader2 } from "lucide-react";
import { api } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  shouldFollow, extractLevel, LEVEL_TEXT, ALL_LEVELS, type Level,
} from "@/lib/run-view-logic";
import { PhaseStatusIcon, type PhaseVisualState } from "@/components/RunPhaseNav";

const LIVE_POLL_INTERVAL_MS = 4000;

export interface RunPhaseSectionProps {
  taskId: string;
  name: string;                 // 内核 phase name
  label?: string;               // 业务标签
  runState: PhaseVisualState;
  rounds: number;               // 执行轮数（>1 显 ×N）
  durationText: string;         // 已格式化耗时（含 P50 / 已等 后缀），"—" 表示未开始
  expanded: boolean;
  onToggle: () => void;
  onInfo: () => void;           // 开 PhaseDetailDrawer
  liveLines: string[];          // WS 分发来的增量行（仅 running 用）
  filterQuery: string;
  filterLevels: Set<Level>;
  errorNote?: string;           // failed 时的错误摘要
  onRetry?: () => void;         // failed 时的重试
}

export function RunPhaseSection(props: RunPhaseSectionProps) {
  const {
    taskId, name, label, runState, rounds, durationText,
    expanded, onToggle, onInfo, liveLines, filterQuery, filterLevels,
    errorNote, onRetry,
  } = props;

  const [content, setContent] = useState<string | null>(null); // null = 未加载
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [paused, setPaused] = useState(false);
  const [missed, setMissed] = useState(0);

  const isRunning = runState === "running";
  const notStarted = runState === "pending" || runState === "idle";

  const fetchLog = (lines: number) => {
    setLoading(true);
    setLoadErr(null);
    api.getPhaseLog(taskId, name, lines)
      .then((res) => { setContent(res.content); loadedRef.current = true; })
      .catch((e: unknown) => setLoadErr((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  // 懒加载：首次展开才拉（未开始的 phase 不拉）
  useEffect(() => {
    if (!expanded || loadedRef.current || notStarted) return;
    fetchLog(isRunning ? 200 : 500);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [expanded, runState]);

  // running 时 4s 轮询全量替换（兜底 WS 断线；全量自带增量内容）
  useEffect(() => {
    if (!expanded || !isRunning) return;
    const t = setInterval(() => fetchLog(500), LIVE_POLL_INTERVAL_MS);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [expanded, isRunning, taskId, name]);

  // 行合并 + 过滤
  const lines = useMemo(() => {
    const base = (content ?? "").split("\n");
    const all = isRunning ? [...base, ...liveLines] : base;
    const q = filterQuery.trim().toLowerCase();
    return all.filter((line) => {
      if (!line.trim()) return false;
      const lvl = extractLevel(line);
      if (lvl && !filterLevels.has(lvl)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [content, liveLines, isRunning, filterQuery, filterLevels]);

  const matchCount = filterQuery.trim() ? lines.length : null;

  // 追尾：新行到达时若在跟随态滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      setMissed(0);
    } else {
      setMissed((n) => n + 1);
    }
  }, [lines.length, expanded]);

  // 折叠再展开 → 重置跟随
  useEffect(() => {
    if (expanded) { followRef.current = true; setPaused(false); setMissed(0); }
  }, [expanded]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const f = shouldFollow(el.scrollTop, el.scrollHeight, el.clientHeight);
    followRef.current = f;
    setPaused(!f);
    if (f) setMissed(0);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setPaused(false);
    setMissed(0);
  };

  const filterActive = !!filterQuery.trim() || filterLevels.size < ALL_LEVELS.length;

  return (
    <div className={cn(
      "rounded-xl border border-border bg-card",
      runState === "failed" && "border-l-2 border-l-destructive",
    )}>
      {/* header：整行可点折叠 */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <PhaseStatusIcon state={runState} />
        <span className="min-w-0 truncate text-[13px] font-medium">{label ?? name}</span>
        {label && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{name}</span>}
        {rounds > 1 && (
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={`第 ${rounds} 次执行`}>
            ×{rounds}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {matchCount != null && <span className="mr-2 text-accent">· {matchCount} 处</span>}
          {durationText}
        </span>
        {onRetry && runState === "failed" && (
          <Button
            variant="outline" size="sm" className="shrink-0"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重试此阶段
          </Button>
        )}
        <span
          role="button"
          tabIndex={0}
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onInfo(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onInfo(); } }}
          title="阶段定义（agent / timeout / 驳回）"
        >
          <Info className="h-3.5 w-3.5" />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2">
          {runState === "failed" && errorNote && (
            <p className="mb-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">{errorNote}</p>
          )}
          {notStarted ? (
            <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">尚未开始</p>
          ) : loading && content == null ? (
            <p className="flex items-center gap-2 py-4 font-mono text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载日志…
            </p>
          ) : loadErr ? (
            <p className="py-3 font-mono text-[11px] text-destructive">
              日志加载失败：{loadErr}
              <Button variant="ghost" size="sm" className="ml-2" onClick={() => fetchLog(500)}>重试</Button>
            </p>
          ) : lines.length === 0 ? (
            <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">
              {filterActive ? "无匹配行" : "本阶段无日志输出"}
            </p>
          ) : (
            <div className="relative">
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="scrollbar-thin max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed"
              >
                {lines.map((line, i) => {
                  const lvl = extractLevel(line);
                  return (
                    <div key={i} className={cn("whitespace-pre-wrap break-words", lvl ? LEVEL_TEXT[lvl] : "text-foreground")}>
                      {line}
                    </div>
                  );
                })}
              </div>
              {isRunning && (
                paused ? (
                  <button
                    type="button"
                    onClick={jumpToLatest}
                    className="absolute bottom-2 right-2 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[10px] text-accent shadow-sm hover:border-accent"
                  >
                    已暂停{missed > 0 ? ` · ${missed} 条新日志` : ""} ↓ 跳到最新
                  </button>
                ) : (
                  <span className="absolute bottom-2 right-2 rounded-full bg-card/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    跟随中 · 上滚暂停
                  </span>
                )
              )}
            </div>
          )}
          {runState === "awaiting" && (
            <p className="mt-2 font-mono text-[10px] text-warning">↑ 在顶部「等待你拍板」横幅里通过 / 驳回</p>
          )}
        </div>
      )}
    </div>
  );
}
