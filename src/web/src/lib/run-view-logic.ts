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
