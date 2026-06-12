// 线性执行时间线的单轮执行折叠 section：header（状态/轮次/耗时/ⓘ/chevron）+
// agent 调用内联摘要 + 本轮日志区（懒加载 + running 时轮询/WS 增量 + 底部追尾）。
// 同一 phase 驳回重做的每一轮是独立 section（往下追加），日志按本轮时间窗切片。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Info, RotateCcw, Loader2, Bot } from "lucide-react";
import { api, type AgentCallSummary, type AgentCallRecord } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  shouldFollow, extractLevel, filterLinesToWindow, dropLiveOverlap, fmtDuration, isNeverRun, localizeLineTs,
  LEVEL_TEXT, ALL_LEVELS, type Level,
} from "@/lib/run-view-logic";
import { PhaseStatusIcon, type PhaseVisualState } from "@/components/RunPhaseNav";

const LIVE_POLL_INTERVAL_MS = 4000;

export interface RunPhaseSectionProps {
  taskId: string;
  name: string;                 // 内核 phase name
  label?: string;               // 业务标签
  runState: PhaseVisualState;
  /** 本轮是同 phase 的第几轮 / 共几轮（>1 时显示「第 N 轮」） */
  attempt?: number;
  totalAttempts?: number;
  durationText: string;         // 已格式化耗时（含 P50 / 已等 后缀），"—" 表示未开始
  /** 本轮时间窗（按窗切日志；未执行占位 section 不传） */
  windowStartMs?: number;
  windowEndMs?: number | null;
  /** 本轮的 agent 调用摘要（内联显示） */
  agentCalls?: AgentCallSummary[];
  expanded: boolean;
  onToggle: () => void;
  onInfo: () => void;           // 开 PhaseDetailDrawer
  liveLines: string[];          // WS 分发来的增量行（仅 running 用）
  filterQuery: string;
  filterLevels: Set<Level>;
  errorNote?: string;           // failed 时的错误摘要
  onRetry?: () => void;         // failed 时的重试
}

/** agent 调用内联：默认一行摘要，点击展开懒加载**完整** prompt / 结果（不截断） */
function AgentCallInline({ taskId, call }: { taskId: string; call: AgentCallSummary }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<AgentCallRecord | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const tokens = call.usage
    ? `${call.usage.input_tokens ?? 0}→${call.usage.output_tokens ?? 0} tok`
    : null;
  const cost = call.usage?.total_cost_usd != null ? `$${call.usage.total_cost_usd.toFixed(4)}` : null;

  // 首次展开懒加载完整记录（summary 里的 preview 是 120 字符截断）
  useEffect(() => {
    if (!open || full || loadErr) return;
    api.getAgentCall(taskId, call.seq)
      .then(setFull)
      .catch((e: unknown) => setLoadErr((e as Error)?.message ?? String(e)));
  }, [open, full, loadErr, taskId, call.seq]);

  const block = (label: string, text: string | undefined, cls = "text-foreground/80") =>
    text ? (
      <div>
        <div className="mb-0.5 text-muted-foreground">{label}</div>
        <pre className={cn("scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 leading-relaxed", cls)}>
          {text}
        </pre>
      </div>
    ) : null;

  return (
    <div className={cn("rounded-lg border border-border/60 bg-muted/30", call.error && "border-destructive/40")}>
      {/* flex-wrap + truncate：窄屏（移动端）下左侧 agent/模型名不被右侧 meta 挤成竖排单字列，
          meta 整组换行到第二行右对齐 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-left font-mono text-[11px]"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 max-w-full truncate text-foreground/85">{call.agent}</span>
        {call.model && <span className="min-w-0 max-w-full truncate text-muted-foreground">{call.model}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
          {call.error && <span className="text-destructive">出错</span>}
          {tokens && <span>{tokens}</span>}
          {cost && <span>{cost}</span>}
          {call.elapsed_ms != null && <span>{fmtDuration(call.elapsed_ms)}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2 font-mono text-[11px]">
          {!full && !loadErr && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> 加载完整调用记录…
            </p>
          )}
          {loadErr && (
            <p className="text-destructive">完整记录加载失败：{loadErr}（以下为摘要预览）</p>
          )}
          {full ? (
            <>
              {block("system prompt", full.system_prompt, "text-muted-foreground")}
              {block("prompt", full.prompt || "（空）")}
              {block("结果", full.result_text || "（无）")}
              {full.error && <div className="break-words text-destructive">error：{full.error}</div>}
            </>
          ) : loadErr ? (
            <>
              {block("prompt（预览）", call.prompt_preview || "（空）")}
              {block("结果（预览）", call.result_preview || "（无）")}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function RunPhaseSection(props: RunPhaseSectionProps) {
  const {
    taskId, name, label, runState, attempt, totalAttempts, durationText,
    windowStartMs, windowEndMs, agentCalls,
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
  const notStarted = isNeverRun(runState);

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

  // 行合并 + 本轮时间窗切片 + 时间戳本地化 + 过滤。phase.log 是同 phase 全部轮次
  // 混写的一个文件，传了 windowStartMs 时只保留落在本轮窗口内的行（无时间戳行跟随
  // 前一条归属）。切片必须用原始 UTC 行，本地化只发生在切片之后、搜索过滤之前。
  const lines = useMemo(() => {
    let base = (content ?? "").split("\n");
    if (windowStartMs !== undefined) {
      base = filterLinesToWindow(base, windowStartMs, windowEndMs ?? null);
    }
    // live 缓冲与 4s 全量轮询的内容重叠（缓冲不在轮询后清空，有竞态丢行风险），
    // 渲染层去重：只保留落在 base 最后时间戳之后的 live 行
    const all = (isRunning ? [...base, ...dropLiveOverlap(base, liveLines)] : base).map(localizeLineTs);
    const q = filterQuery.trim().toLowerCase();
    return all.filter((line) => {
      if (!line.trim()) return false;
      const lvl = extractLevel(line);
      if (lvl && !filterLevels.has(lvl)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [content, liveLines, isRunning, filterQuery, filterLevels, windowStartMs, windowEndMs]);

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
    <div className="rounded-xl border border-border bg-card">
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
        {attempt !== undefined && (totalAttempts ?? 1) > 1 && (
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={`本阶段共执行 ${totalAttempts} 轮，这是第 ${attempt} 轮`}>
            第 {attempt} 轮
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
          {runState === "aborted" && (
            <p className="mb-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              本轮执行被打断（daemon 重启或任务取消），日志保留至中断时刻；后续轮次见下方
            </p>
          )}
          {/* 本轮 agent 调用（内联，展开懒加载完整 prompt/结果） */}
          {agentCalls && agentCalls.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {agentCalls.map((c) => <AgentCallInline key={c.seq} taskId={taskId} call={c} />)}
            </div>
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
