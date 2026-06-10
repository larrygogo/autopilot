// GitHub Actions job 形态的任务执行视图：左 phase 导航 + 右折叠日志 section 流。
// 数据全部由 TaskDetail 注入（task / workflowDetail / phaseRunStatuses / events / stats / logs）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { api, type TaskPhaseEvent } from "@/hooks/useApi";
import { LogTimeline } from "@/components/LogTimeline";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  resolveLogPhase, phaseRounds, fmtDuration,
  ALL_LEVELS, LEVEL_TEXT, type Level, type PhaseRunState,
} from "@/lib/run-view-logic";
import { RunPhaseNavSidebar, RunPhaseNavStrip, type NavEntry, type PhaseVisualState } from "@/components/RunPhaseNav";
import { RunPhaseSection } from "@/components/RunPhaseSection";

interface FlatPhase { name: string; label?: string; group?: string; groupLabel?: string; }

/** workflowDetail.phases（含 parallel 块）拍平成线性序列，保留组归属 */
function flattenPhases(phases: unknown[]): FlatPhase[] {
  const out: FlatPhase[] = [];
  for (const raw of (phases as Array<Record<string, any>> | undefined) ?? []) {
    if (raw?.parallel) {
      const g = String(raw.parallel.name ?? "parallel");
      const gl = typeof raw.parallel.label === "string" ? raw.parallel.label : undefined;
      for (const sub of (raw.parallel.phases as Array<Record<string, any>> | undefined) ?? []) {
        if (sub?.name) {
          out.push({
            name: String(sub.name),
            label: typeof sub.label === "string" ? sub.label : undefined,
            group: g,
            groupLabel: gl,
          });
        }
      }
    } else if (raw?.name) {
      out.push({ name: String(raw.name), label: typeof raw.label === "string" ? raw.label : undefined });
    }
  }
  return out;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(["idle", "pending", "running", "done", "failed", "awaiting"]);

interface TaskRunViewProps {
  taskId: string;
  taskStatus: string;
  workflowPhases: unknown[];                  // workflowDetail.phases（raw）
  phaseRunStatuses: Record<string, string>;   // TaskDetail 现有推导
  phaseEvents: TaskPhaseEvent[];
  phaseStats?: Record<string, { count: number; p50_ms: number }>;
  /** task 的 transition 日志（TaskDetail 原样透传，喂 LogTimeline + 错误摘要） */
  logs: any[];
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
  onInfoPhase: (phase: string) => void;       // 开 PhaseDetailDrawer
}

export function TaskRunView(props: TaskRunViewProps) {
  const { taskId, taskStatus, workflowPhases, phaseRunStatuses, phaseEvents, phaseStats, logs, subscribe, onInfoPhase } = props;
  const toast = useToast();

  const flat = useMemo(() => flattenPhases(workflowPhases), [workflowPhases]);
  const names = useMemo(() => new Set(flat.map((p) => p.name)), [flat]);
  const labelToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of flat) if (p.label) m[p.label] = p.name;
    return m;
  }, [flat]);

  const stateOf = (name: string): PhaseRunState =>
    (KNOWN_STATES.has(phaseRunStatuses[name] ?? "") ? (phaseRunStatuses[name] as PhaseRunState) : "idle");

  // 展开状态机（spec B5）
  const [expand, setExpand] = useState(createExpandState);
  useEffect(() => {
    const statuses: Record<string, PhaseRunState> = {};
    for (const p of flat) statuses[p.name] = stateOf(p.name);
    setExpand((prev) => applyStatusTransitions(prev, statuses));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [phaseRunStatuses, flat]);

  // WS 增量分发（per-phase 缓冲；phase 离开 running 时清空——轮询全量已含其内容）
  const [liveByPhase, setLiveByPhase] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const unsub = subscribe(`log:${taskId}`, (event: any) => {
      if (event?.type !== "log:entry") return;
      const phase = resolveLogPhase(event.payload?.phase, labelToName, names);
      if (!phase) return;
      setLiveByPhase((prev) => ({
        ...prev,
        [phase]: [...(prev[phase] ?? []).slice(-300), String(event.payload?.message ?? "")],
      }));
    });
    return unsub;
  }, [taskId, subscribe, labelToName, names]);
  useEffect(() => {
    setLiveByPhase((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (stateOf(k) !== "running") { delete next[k]; changed = true; }
      }
      return changed ? next : prev;
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [phaseRunStatuses]);

  // 工具栏
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set(ALL_LEVELS));
  const toggleLevel = (l: Level) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  // 每秒走字（running elapsed / awaiting 已等）
  const [, setTick] = useState(0);
  const anyTicking = flat.some((p) => stateOf(p.name) === "running") || taskStatus.startsWith("awaiting_");
  useEffect(() => {
    if (!anyTicking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyTicking]);

  // 耗时文案（events 的 ts 兼容秒级/ms 级）
  const toMs = (n: number) => (n < 1e12 ? n * 1000 : n);
  const durationOf = (name: string): string => {
    const evs = phaseEvents.filter((e) => e.phase === name);
    const last = evs[evs.length - 1];
    if (!last) return "—";
    const startMs = toMs(last.started_at);
    const endMs = last.ended_at ? toMs(last.ended_at) : null;
    const st = stateOf(name);
    if (st === "running") {
      const base = fmtDuration(Date.now() - startMs);
      const p50 = phaseStats?.[name]?.p50_ms;
      return p50 ? `${base} · 常约${fmtDuration(p50)}` : base;
    }
    if (st === "awaiting") {
      const ran = endMs ? fmtDuration(endMs - startMs) : "—";
      return `${ran} · 已等 ${fmtDuration(Date.now() - (endMs ?? startMs))}`;
    }
    if (endMs) return fmtDuration(endMs - startMs);
    return "—";
  };

  // failed 错误摘要：最近一条带 note 的 transition（logs 为 desc 序）
  const errorNote = useMemo(() => logs.find((l) => l?.note)?.note ?? undefined, [logs]);

  const retryPhase = async () => {
    try {
      const r = await api.restartTask(taskId);
      toast.success(`已重启 · 从 ${r.phase} 阶段重新执行`);
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    }
  };

  // 导航 entries（并行组带 header）
  const entries = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = [];
    let lastGroup: string | undefined;
    for (const p of flat) {
      if (p.group && p.group !== lastGroup) out.push({ kind: "group", header: { group: p.group, label: p.groupLabel } });
      lastGroup = p.group;
      out.push({
        kind: "phase",
        item: {
          name: p.name,
          label: p.label,
          state: stateOf(p.name) as PhaseVisualState,
          durationText: durationOf(p.name),
          group: p.group,
        },
      });
    }
    return out;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [flat, phaseRunStatuses, phaseEvents, phaseStats, anyTicking ? Date.now() : 0]);

  // 点击导航：展开 + 滚动定位；scroll-spy 跟随视口
  const [activePhase, setActivePhase] = useState<string | null>(null);
  const clickGuardRef = useRef(0);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [transitionsOpen, setTransitionsOpen] = useState(false);
  const transitionsRef = useRef<HTMLDivElement>(null);

  const selectPhase = (name: string) => {
    setActivePhase(name);
    clickGuardRef.current = Date.now() + 600; // 点击高亮优先 600ms，防 scroll-spy 抖动
    setExpand((prev) => (isExpanded(prev, name) ? prev : toggleManual(prev, name)));
    requestAnimationFrame(() => {
      sectionRefs.current[name]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const selectTransitions = () => {
    setTransitionsOpen(true);
    requestAnimationFrame(() => transitionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  useEffect(() => {
    const obs = new IntersectionObserver(
      (items) => {
        if (Date.now() < clickGuardRef.current) return;
        const top = items
          .filter((i) => i.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const name = top?.target.getAttribute("data-phase");
        if (name) setActivePhase(name);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const el of Object.values(sectionRefs.current)) if (el) obs.observe(el);
    return () => obs.disconnect();
  }, [entries.length]);

  const renderSection = (p: FlatPhase) => (
    <div key={p.name} ref={(el) => { sectionRefs.current[p.name] = el; }} data-phase={p.name}>
      <RunPhaseSection
        taskId={taskId}
        name={p.name}
        label={p.label}
        runState={stateOf(p.name) as PhaseVisualState}
        rounds={phaseRounds(phaseEvents, p.name)}
        durationText={durationOf(p.name)}
        expanded={isExpanded(expand, p.name)}
        onToggle={() => setExpand((prev) => toggleManual(prev, p.name))}
        onInfo={() => onInfoPhase(p.name)}
        liveLines={liveByPhase[p.name] ?? []}
        filterQuery={query}
        filterLevels={levels}
        errorNote={stateOf(p.name) === "failed" ? errorNote : undefined}
        onRetry={stateOf(p.name) === "failed" ? retryPhase : undefined}
      />
    </div>
  );

  // section 流：按 flat 顺序，相邻同组包浅容器
  const sectionFlow: ReactNode[] = [];
  for (let i = 0; i < flat.length; ) {
    const p = flat[i];
    if (p.group) {
      const groupItems: FlatPhase[] = [];
      const g = p.group;
      while (i < flat.length && flat[i].group === g) {
        groupItems.push(flat[i]);
        i += 1;
      }
      sectionFlow.push(
        <div key={`grp-${g}`} className="space-y-2 rounded-xl border border-border bg-muted/20 p-2">
          <p className="px-1 font-mono text-[10px] text-muted-foreground">{groupItems[0].groupLabel ?? g} · PARALLEL</p>
          {groupItems.map(renderSection)}
        </div>,
      );
    } else {
      sectionFlow.push(renderSection(p));
      i += 1;
    }
  }

  return (
    <div className="@container mb-4">
      {/* 窄容器（embedded 等）：横向 chip 条 */}
      <div className="mb-3 @3xl:hidden">
        <RunPhaseNavStrip entries={entries} activePhase={activePhase} onSelect={selectPhase} />
      </div>

      <div className="flex items-start gap-5">
        {/* 宽容器：左导航 */}
        <div className="sticky top-4 hidden @3xl:block">
          <RunPhaseNavSidebar
            entries={entries}
            activePhase={activePhase}
            onSelect={selectPhase}
            onSelectTransitions={selectTransitions}
            transitionsCount={logs.length}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* sticky 工具栏：搜索 + level 筛选（作用于已展开 section） */}
          <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-background/95 px-1 py-2 backdrop-blur">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索日志（作用于已展开阶段）…"
                className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-2 font-mono text-xs focus:border-accent focus:outline-none"
              />
            </div>
            <div className="flex shrink-0 items-center gap-0 overflow-hidden rounded-md border border-border">
              {ALL_LEVELS.map((lvl) => {
                const on = levels.has(lvl);
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => toggleLevel(lvl)}
                    aria-pressed={on}
                    className={cn(
                      "border-r border-border px-2.5 py-1.5 font-mono text-[10px] font-medium transition-colors last:border-r-0",
                      on ? cn("bg-foreground/5", LEVEL_TEXT[lvl]) : "text-muted-foreground opacity-40 hover:opacity-100",
                    )}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>

          {sectionFlow}

          {/* 状态转移（审计视图，沉底折叠） */}
          <div ref={transitionsRef}>
            <Card>
              <button
                type="button"
                onClick={() => setTransitionsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
              >
                <span className="bp-label">⏱ 状态转移 · TRANSITIONS</span>
                <span className="font-mono text-[10px] text-muted-foreground">{logs.length}</span>
              </button>
              {transitionsOpen && (
                <div className="border-t border-border p-4">
                  <LogTimeline logs={logs} />
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
