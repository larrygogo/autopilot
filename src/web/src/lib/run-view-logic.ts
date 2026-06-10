// TaskRunView（GA 式执行视图）的纯逻辑：折叠展开状态机 / 追尾滚动阈值 /
// log:entry phase 归属解析 / 重跑轮数 / 耗时格式化 / 日志 level 解析。

export type PhaseRunState = "idle" | "pending" | "running" | "done" | "failed" | "awaiting";

// ── 展开状态机（spec B5）────────────────────────
// 规则：自动展开只发生在状态跃迁瞬间（→running / →awaiting / →failed）；
// 用户手动操作记 override，状态跃迁时清除；→failed 强制展开（清 override）。

export interface ExpandState {
  /** 用户手动操作："collapsed" 不再自动展开；"expanded" 不被收起 */
  overrides: Record<string, "collapsed" | "expanded">;
  /** 自动展开集（只增不减；自动逻辑从不收起） */
  auto: Record<string, boolean>;
  /** 上一次观察到的各 phase 状态，用于检测跃迁 */
  prev: Record<string, PhaseRunState>;
}

export function createExpandState(): ExpandState {
  return { overrides: {}, auto: {}, prev: {} };
}

const AUTO_EXPAND_STATES: ReadonlySet<PhaseRunState> = new Set(["running", "awaiting", "failed"]);

export function applyStatusTransitions(
  state: ExpandState,
  statuses: Record<string, PhaseRunState>,
): ExpandState {
  const next: ExpandState = {
    overrides: { ...state.overrides },
    auto: { ...state.auto },
    prev: { ...state.prev },
  };
  for (const [phase, status] of Object.entries(statuses)) {
    const prev = next.prev[phase];
    if (prev === status) continue; // 非跃迁（轮询重复）不动任何东西
    next.prev[phase] = status;
    if (AUTO_EXPAND_STATES.has(status)) {
      delete next.overrides[phase]; // 跃迁清除 override（failed 即强制展开）
      next.auto[phase] = true;
    }
  }
  return next;
}

export function toggleManual(state: ExpandState, phase: string): ExpandState {
  const expanded = isExpanded(state, phase);
  return {
    ...state,
    overrides: { ...state.overrides, [phase]: expanded ? "collapsed" : "expanded" },
  };
}

export function isExpanded(state: ExpandState, phase: string): boolean {
  const o = state.overrides[phase];
  if (o === "expanded") return true;
  if (o === "collapsed") return false;
  return state.auto[phase] === true;
}

// ── 追尾滚动 ────────────────────────────────────

export const FOLLOW_THRESHOLD_PX = 24;

export function shouldFollow(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_THRESHOLD_PX;
}

// ── log:entry 分发 ──────────────────────────────
// logger 的 phase tag 用的是业务 label（如「设计」），WS 增量行需要映射回
// phase name 才能挂到正确 section。解析不出来返回 null（宁可不分发也不错挂）。

export function resolveLogPhase(
  tag: string | undefined,
  labelToName: Record<string, string>,
  names: ReadonlySet<string>,
): string | null {
  if (!tag) return null;
  if (names.has(tag)) return tag;
  return labelToName[tag] ?? null;
}

// ── section 占位判定 ────────────────────────────
// 「从未执行」（渲染占位、不拉日志）只有 idle/pending 两种。
// aborted 是**执行过被打断**的轮次（daemon 重启/取消）：日志在盘上、时间窗完整，
// 必须走正常加载展示——曾因把 aborted 映射成 idle 导致整轮日志在 UI 上"消失"。

export function isNeverRun(state: string): boolean {
  return state === "idle" || state === "pending";
}

// ── 重跑轮数 ────────────────────────────────────

export function phaseRounds(events: Array<{ phase: string }>, phase: string): number {
  let n = 0;
  for (const e of events) if (e.phase === phase) n += 1;
  return n;
}

// ── 耗时格式化 ──────────────────────────────────

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// ── 日志 level（从 PhaseLogsViewer 平移，该组件随旧 tab 删除）──

export const LEVEL_RE = /\s\[(INFO|WARN|ERROR|DEBUG)\]\s/;
export type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";
export const ALL_LEVELS: Level[] = ["INFO", "WARN", "ERROR", "DEBUG"];

export function extractLevel(line: string): Level | null {
  const m = line.match(LEVEL_RE);
  return (m?.[1] as Level) ?? null;
}

export const LEVEL_TEXT: Record<Level, string> = {
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-destructive",
  DEBUG: "text-muted-foreground",
};

// ── 状态机日志中文化（业务标签叠加内核名：UI 显示中文，内核名 hover 露出）────
// task status / trigger 是规则化命名（pending_<phase> / <phase>_complete …），
// 按规则翻译 + phase label 替换；未命中规则原样返回（兜底永不丢信息）。

export function taskStatusZh(status: string, labelOf: (phase: string) => string): string {
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled" || status === "canceled") return "已取消";
  let m = status.match(/^pending_(.+)$/);
  if (m) return `等待${labelOf(m[1])}`;
  m = status.match(/^running_(.+)$/);
  if (m) return `${labelOf(m[1])}进行中`;
  m = status.match(/^awaiting_(.+)$/);
  if (m) return `${labelOf(m[1])}等待人工`;
  m = status.match(/^waiting_(.+)$/);
  if (m) return `等待并行组（${labelOf(m[1])}）`;
  m = status.match(/^failed_(.+)$/);
  if (m) return `${labelOf(m[1])}失败`;
  m = status.match(/^(.+)_rejected$/);
  if (m) return `${labelOf(m[1])}被驳回`;
  return status;
}

export function taskTriggerZh(trigger: string, labelOf: (phase: string) => string): string {
  if (trigger === "cancel") return "取消";
  if (trigger === "fail") return "失败";
  if (trigger === "force_transition") return "强制转移";
  let m = trigger.match(/^start_(.+)$/);
  if (m) return `开始${labelOf(m[1])}`;
  m = trigger.match(/^retry_(.+)$/);
  if (m) return `重做${labelOf(m[1])}`;
  m = trigger.match(/^(.+)_complete$/);
  if (m) return `${labelOf(m[1])}完成`;
  m = trigger.match(/^(.+)_reject_user$/);
  if (m) return `${labelOf(m[1])}人工驳回`;
  m = trigger.match(/^(.+)_reject$/);
  if (m) return `${labelOf(m[1])}驳回`;
  m = trigger.match(/^(.+)_pass$/);
  if (m) return `${labelOf(m[1])}人工通过`;
  return trigger;
}

// ── 线性执行时间线（每轮执行独立成块，驳回重试往下追加而非原地 ×N）────────

export interface PhaseEventLike {
  id: number;
  phase: string;
  /** aborted = daemon 重启/取消时被打断的轮次（closeOpenPhaseEvents 写入） */
  status: "running" | "done" | "awaiting" | "failed" | "aborted";
  started_at: number;
  ended_at: number | null;
}

export interface ExecutionRun {
  /** 唯一 key（event id） */
  key: string;
  phase: string;
  /** 同 phase 第几轮（1-based） */
  attempt: number;
  /** 同 phase 总轮数 */
  totalAttempts: number;
  state: "running" | "done" | "awaiting" | "failed" | "aborted";
  startedMs: number;
  endedMs: number | null;
}

const toMs = (n: number) => (n < 1e12 ? n * 1000 : n);

/**
 * task_phase_events → 线性执行时间线。runs 按实际开始时间排序（驳回重做按发生顺序
 * 往下追加）；pending = 从未执行过的 phase 名（按工作流定义顺序，渲染为未开始占位）。
 */
export function buildTimeline(
  events: PhaseEventLike[],
  phaseOrder: string[],
): { runs: ExecutionRun[]; pending: string[] } {
  const sorted = [...events].sort((a, b) => toMs(a.started_at) - toMs(b.started_at) || a.id - b.id);
  const counts = new Map<string, number>();
  for (const e of sorted) counts.set(e.phase, (counts.get(e.phase) ?? 0) + 1);
  const seen = new Map<string, number>();
  const runs: ExecutionRun[] = sorted.map((e) => {
    const attempt = (seen.get(e.phase) ?? 0) + 1;
    seen.set(e.phase, attempt);
    return {
      key: `run-${e.id}`,
      phase: e.phase,
      attempt,
      totalAttempts: counts.get(e.phase) ?? 1,
      state: e.status,
      startedMs: toMs(e.started_at),
      endedMs: e.ended_at === null ? null : toMs(e.ended_at),
    };
  });
  const ran = new Set(runs.map((r) => r.phase));
  const pending = phaseOrder.filter((p) => !ran.has(p));
  return { runs, pending };
}

/** 日志行首时间戳（"2026-06-10 05:50:44 …"）→ ms；无时间戳返回 null（延续行）。
 *  logger 落盘的是 **UTC** 时间字符串（无时区后缀），必须显式按 UTC 解析——
 *  否则 JS 按本地时区解，与 phase event 的 epoch 窗口错开数小时，切片结果全空。 */
export function parseLineTs(line: string): number | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const t = new Date(m[1].replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * 把 phase.log 的行流按 run 时间窗切片（同 phase 多轮日志混在一个文件里）。
 * 无时间戳的行跟随最近一条有时间戳行的归属；窗口两端各放宽 2s（写盘/时钟毫秒抖动）。
 */
export function filterLinesToWindow(lines: string[], startMs: number, endMs: number | null): string[] {
  const SLACK = 2000;
  const out: string[] = [];
  let inWindow = false;
  for (const line of lines) {
    const ts = parseLineTs(line);
    if (ts !== null) {
      inWindow = ts >= startMs - SLACK && (endMs === null || ts <= endMs + SLACK);
    }
    if (inWindow) out.push(line);
  }
  return out;
}

export interface AgentCallLike {
  seq: number;
  ts: string;            // ISO（调用完成时刻）
  phase?: string;
  elapsed_ms?: number;
}

/**
 * agent 调用分发到 run：phase 匹配 + 调用时间区间 [ts-elapsed, ts] 与 run 窗口相交。
 * 匹配不到窗口（时钟抖动/历史数据）时落到该 phase 的最后一轮。
 */
export function assignAgentCalls<T extends AgentCallLike>(
  calls: T[],
  runs: ExecutionRun[],
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  const SLACK = 2000;
  for (const c of calls) {
    const phase = c.phase;
    if (!phase) continue;
    const endMs = new Date(c.ts).getTime();
    const startMs = endMs - (c.elapsed_ms ?? 0);
    const candidates = runs.filter((r) => r.phase === phase);
    const hit = candidates.find((r) =>
      startMs <= (r.endedMs ?? Infinity) + SLACK && endMs >= r.startedMs - SLACK,
    ) ?? candidates[candidates.length - 1];
    if (!hit) continue;
    (out[hit.key] ??= []).push(c);
  }
  return out;
}
