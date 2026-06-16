// 线性执行时间线形态的任务执行视图：左导航 + 右侧按实际执行顺序铺开的折叠 section 流。
// 每轮 phase 执行（含驳回重做）是独立 section 往下追加；日志按轮切片；agent 调用内联。
// 数据全部由 TaskDetail 注入（task / workflowDetail / phaseRunStatuses / events / stats / logs）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { api, type TaskPhaseEvent, type AgentCallSummary } from "@/hooks/useApi";
import { LogTimeline } from "@/components/LogTimeline";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  resolveLogPhase, fmtDuration, buildTimeline, assignAgentCalls,
  ALL_LEVELS, LEVEL_TEXT, type Level, type PhaseRunState, type ExecutionRun,
} from "@/lib/run-view-logic";
import { RunPhaseNavSidebar, type NavEntry, type PhaseVisualState } from "@/components/RunPhaseNav";
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
  // phase name → 中文 label（状态转移时间轴中文化用；无 label 的 phase 原样返回 name）
  const phaseLabelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of flat) if (p.label) m[p.name] = p.label;
    return (name: string) => m[name] ?? name;
  }, [flat]);

  const stateOf = (name: string): PhaseRunState =>
    (KNOWN_STATES.has(phaseRunStatuses[name] ?? "") ? (phaseRunStatuses[name] as PhaseRunState) : "idle");

  // 线性执行时间线：每轮 phase 执行独立成块（驳回重做往下追加）；pending = 未执行占位。
  // 每个 phase 最后一轮的 state 用 phaseRunStatuses 实时态覆盖（awaiting/running 即时反映）。
  const { runs, pending } = useMemo(
    () => buildTimeline(phaseEvents, flat.map((p) => p.name)),
    [phaseEvents, flat],
  );
  const runsLive = useMemo<ExecutionRun[]>(() => {
    const lastByPhase = new Map<string, string>();
    for (const r of runs) lastByPhase.set(r.phase, r.key);
    return runs.map((r) => {
      if (lastByPhase.get(r.phase) !== r.key) return r;
      const cur = phaseRunStatuses[r.phase];
      if (cur === "running" || cur === "awaiting" || cur === "failed" || cur === "done") {
        return r.state === cur ? r : { ...r, state: cur as ExecutionRun["state"] };
      }
      return r;
    });
  }, [runs, phaseRunStatuses]);

  // agent 调用摘要：拉一次 + 任务活跃期轮询，按时间窗分发到各轮
  const [agentCalls, setAgentCalls] = useState<AgentCallSummary[]>([]);
  const isTaskActive = taskStatus.startsWith("running_") || taskStatus.startsWith("pending_") || taskStatus.startsWith("awaiting_");
  useEffect(() => {
    let stop = false;
    const load = () => api.listAgentCalls(taskId).then((c) => { if (!stop) setAgentCalls(c); }).catch(() => { /* 拉不到不阻塞 */ });
    void load();
    if (!isTaskActive) return () => { stop = true; };
    const t = setInterval(load, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [taskId, isTaskActive]);
  const callsByRun = useMemo(() => assignAgentCalls(agentCalls, runsLive), [agentCalls, runsLive]);

  // 展开状态机（spec B5；key = run.key / pending-<phase>）
  const [expand, setExpand] = useState(createExpandState);
  useEffect(() => {
    const statuses: Record<string, PhaseRunState> = {};
    for (const r of runsLive) statuses[r.key] = r.state === "aborted" ? "idle" : r.state;
    for (const p of pending) statuses[`pending-${p}`] = "idle";
    setExpand((prev) => applyStatusTransitions(prev, statuses));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [runsLive, pending]);

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

  // 每轮耗时文案
  const durationOfRun = (r: ExecutionRun): string => {
    if (r.state === "running") {
      const base = fmtDuration(Date.now() - r.startedMs);
      const p50 = phaseStats?.[r.phase]?.p50_ms;
      return p50 ? `${base} · 常约${fmtDuration(p50)}` : base;
    }
    if (r.state === "awaiting") {
      const ran = r.endedMs ? fmtDuration(r.endedMs - r.startedMs) : "—";
      return `${ran} · 已等 ${fmtDuration(Date.now() - (r.endedMs ?? r.startedMs))}`;
    }
    if (r.endedMs) return fmtDuration(r.endedMs - r.startedMs);
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

  // 导航 entries：与右侧线性时间线一一对应（每轮一项 + 未执行占位）
  const entries = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = [];
    for (const r of runsLive) {
      const base = phaseLabelOf(r.phase);
      out.push({
        kind: "phase",
        item: {
          name: r.key,
          label: r.totalAttempts > 1 ? `${base} · 第${r.attempt}轮` : base,
          state: r.state as PhaseVisualState,
          durationText: durationOfRun(r),
        },
      });
    }
    for (const p of pending) {
      out.push({
        kind: "phase",
        item: { name: `pending-${p}`, label: phaseLabelOf(p), state: "idle" as PhaseVisualState, durationText: "—" },
      });
    }
    return out;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [runsLive, pending, phaseStats, anyTicking ? Date.now() : 0]);

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

  // section 流：线性时间线 —— 每轮执行按发生顺序往下排，未执行 phase 灰色占位垫底
  const labelOfPhase = (name: string): string | undefined => flat.find((p) => p.name === name)?.label;

  // aborted（daemon 重启被打断的轮次）作为一等视觉状态直传：图标仍是灰圈，但
  // section 走正常日志加载（曾映射成 idle 被当"尚未开始"，整轮日志在 UI 上消失）
  const visualState = (s: ExecutionRun["state"]): PhaseVisualState => s as PhaseVisualState;

  const renderRun = (r: ExecutionRun) => (
    <div key={r.key} ref={(el) => { sectionRefs.current[r.key] = el; }} data-phase={r.key}>
      <RunPhaseSection
        taskId={taskId}
        name={r.phase}
        label={labelOfPhase(r.phase)}
        runState={visualState(r.state)}
        attempt={r.attempt}
        totalAttempts={r.totalAttempts}
        durationText={durationOfRun(r)}
        windowStartMs={r.startedMs}
        windowEndMs={r.endedMs}
        agentCalls={callsByRun[r.key]}
        expanded={isExpanded(expand, r.key)}
        onToggle={() => setExpand((prev) => toggleManual(prev, r.key))}
        onInfo={() => onInfoPhase(r.phase)}
        liveLines={r.state === "running" ? liveByPhase[r.phase] ?? [] : []}
        filterQuery={query}
        filterLevels={levels}
        errorNote={r.state === "failed" ? errorNote : undefined}
        onRetry={r.state === "failed" ? retryPhase : undefined}
      />
    </div>
  );

  const renderPending = (name: string) => (
    <div key={`pending-${name}`} ref={(el) => { sectionRefs.current[`pending-${name}`] = el; }} data-phase={`pending-${name}`}>
      <RunPhaseSection
        taskId={taskId}
        name={name}
        label={labelOfPhase(name)}
        runState={"idle" as PhaseVisualState}
        durationText="—"
        expanded={isExpanded(expand, `pending-${name}`)}
        onToggle={() => setExpand((prev) => toggleManual(prev, `pending-${name}`))}
        onInfo={() => onInfoPhase(name)}
        liveLines={[]}
        filterQuery={query}
        filterLevels={levels}
      />
    </div>
  );

  const sectionFlow: ReactNode[] = [
    ...runsLive.map(renderRun),
    ...pending.map(renderPending),
  ];

  return (
    <div className="@container mb-4">
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
            {/* min-w 给搜索框保底宽度：低于它时 level 筛选组整体换行（min-w-0 会让输入框
                被无限压扁、永远不触发 flex-wrap —— 移动端实测） */}
            <div className="relative min-w-[12rem] flex-1">
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
                  <LogTimeline logs={logs} phaseLabelOf={phaseLabelOf} />
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
