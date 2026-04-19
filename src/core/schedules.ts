import { getDb, now } from "./db";
import { emit } from "../daemon/event-bus";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export type ScheduleType = "once" | "cron";

export interface Schedule {
  id: string;
  name: string;
  type: ScheduleType;
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  workflow: string;
  title: string;
  requirement: string | null;
  enabled: 0 | 1;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────
// ID 生成（与 task id 同 alphabet，自动避开易混字符 + 数字 4）
// ──────────────────────────────────────────────

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23567";

function genId(len = 8): string {
  let id = "";
  for (let i = 0; i < len; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

function generateUniqueScheduleId(): string {
  for (let i = 0; i < 10; i++) {
    const id = genId();
    if (!getSchedule(id)) return id;
  }
  throw new Error("无法生成唯一 schedule ID");
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function getSchedule(id: string): Schedule | null {
  const row = getDb()
    .query<Schedule, [string]>("SELECT * FROM schedules WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function listSchedules(): Schedule[] {
  return getDb()
    .query<Schedule, []>(
      "SELECT * FROM schedules ORDER BY enabled DESC, next_run_at ASC, created_at DESC"
    )
    .all();
}

export interface CreateScheduleOpts {
  name: string;
  type: ScheduleType;
  run_at?: string | null;
  cron_expr?: string | null;
  timezone: string;
  workflow: string;
  title: string;
  requirement?: string | null;
  enabled?: boolean;
}

export function createSchedule(opts: CreateScheduleOpts): Schedule {
  if (opts.type === "once" && !opts.run_at) throw new Error("type=once 需要 run_at");
  if (opts.type === "cron" && !opts.cron_expr) throw new Error("type=cron 需要 cron_expr");

  const id = generateUniqueScheduleId();
  const ts = now();
  const enabled: 0 | 1 = opts.enabled === false ? 0 : 1;

  const nextRunAt = enabled
    ? opts.type === "once"
      ? opts.run_at!
      : computeNextRun(opts.cron_expr!, opts.timezone, new Date())
    : null;

  getDb().run(
    "INSERT INTO schedules" +
      " (id, name, type, run_at, cron_expr, timezone, workflow, title, requirement," +
      "  enabled, next_run_at, run_count, created_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    [
      id,
      opts.name,
      opts.type,
      opts.run_at ?? null,
      opts.cron_expr ?? null,
      opts.timezone,
      opts.workflow,
      opts.title,
      opts.requirement ?? null,
      enabled,
      nextRunAt,
      ts,
      ts,
    ]
  );

  const row = getSchedule(id)!;
  emit({ type: "schedule:created", payload: { schedule: row } });
  return row;
}

export interface UpdateScheduleOpts {
  name?: string;
  enabled?: boolean;
  run_at?: string | null;
  cron_expr?: string | null;
  timezone?: string;
  workflow?: string;
  title?: string;
  requirement?: string | null;
}

export function updateSchedule(id: string, patch: UpdateScheduleOpts): Schedule | null {
  const cur = getSchedule(id);
  if (!cur) return null;

  const updated: Schedule = {
    ...cur,
    name: patch.name ?? cur.name,
    run_at: patch.run_at !== undefined ? patch.run_at : cur.run_at,
    cron_expr: patch.cron_expr !== undefined ? patch.cron_expr : cur.cron_expr,
    timezone: patch.timezone ?? cur.timezone,
    workflow: patch.workflow ?? cur.workflow,
    title: patch.title ?? cur.title,
    requirement: patch.requirement !== undefined ? patch.requirement : cur.requirement,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
  };

  // 只要 enabled / schedule 定义字段有变化，重算 next_run_at
  const defChanged =
    patch.enabled !== undefined ||
    patch.run_at !== undefined ||
    patch.cron_expr !== undefined ||
    patch.timezone !== undefined;

  let nextRunAt = cur.next_run_at;
  if (defChanged) {
    if (!updated.enabled) {
      nextRunAt = null;
    } else if (updated.type === "once") {
      nextRunAt = updated.run_at;
    } else {
      nextRunAt = computeNextRun(updated.cron_expr!, updated.timezone, new Date());
    }
  }

  getDb().run(
    "UPDATE schedules SET name=?, run_at=?, cron_expr=?, timezone=?, workflow=?, title=?," +
      " requirement=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?",
    [
      updated.name,
      updated.run_at,
      updated.cron_expr,
      updated.timezone,
      updated.workflow,
      updated.title,
      updated.requirement,
      updated.enabled,
      nextRunAt,
      now(),
      id,
    ]
  );

  const row = getSchedule(id)!;
  emit({ type: "schedule:updated", payload: { schedule: row } });
  return row;
}

export function deleteSchedule(id: string): boolean {
  const cur = getSchedule(id);
  if (!cur) return false;
  getDb().run("DELETE FROM schedules WHERE id = ?", [id]);
  emit({ type: "schedule:deleted", payload: { scheduleId: id } });
  return true;
}

/** scheduler tick 专用：更新触发结果 */
export function markScheduleFired(
  id: string,
  taskId: string,
  nextRunAt: string | null,
  disable: boolean
): void {
  const ts = now();
  getDb().run(
    "UPDATE schedules SET last_run_at=?, last_task_id=?, next_run_at=?," +
      " run_count=run_count+1, enabled=?, updated_at=? WHERE id=?",
    [ts, taskId, nextRunAt, disable ? 0 : 1, ts, id]
  );
  const row = getSchedule(id);
  if (row) emit({ type: "schedule:fired", payload: { schedule: row, taskId } });
}

/** 把任意指向给定 task id 的 schedules.last_task_id 置 NULL。用于任务被删除后的引用清理。 */
export function clearScheduleTaskRefs(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const placeholders = taskIds.map(() => "?").join(",");
  getDb().run(
    "UPDATE schedules SET last_task_id = NULL WHERE last_task_id IN (" + placeholders + ")",
    taskIds
  );
}

export function getDueSchedules(nowIso: string): Schedule[] {
  return getDb()
    .query<Schedule, [string]>(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL" +
        " AND next_run_at <= ? ORDER BY next_run_at ASC"
    )
    .all(nowIso);
}

// ──────────────────────────────────────────────
// Cron 解析与 next_run_at 计算
// ──────────────────────────────────────────────

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** 标记 dom / dow 是否被显式限定（都限定则 OR；否则只看被限定那个） */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需要 5 个字段（分 时 日 月 周），得到 ${parts.length}`);
  }
  const [mi, h, dom, mo, dow] = parts;
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mo, 1, 12),
    dayOfWeek: parseField(normalizeDow(dow), 0, 6),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function normalizeDow(s: string): string {
  // 兼容 7 == 0（周日）
  return s.replace(/\b7\b/g, "0");
}

function parseField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(",")) {
    let range = piece;
    let step = 1;
    const slashIdx = piece.indexOf("/");
    if (slashIdx >= 0) {
      range = piece.slice(0, slashIdx);
      step = parseInt(piece.slice(slashIdx + 1), 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`cron 字段无效的步长：${piece}`);
      }
    }
    let start = lo;
    let end = hi;
    if (range !== "*" && range !== "") {
      const dashIdx = range.indexOf("-");
      if (dashIdx >= 0) {
        start = parseInt(range.slice(0, dashIdx), 10);
        end = parseInt(range.slice(dashIdx + 1), 10);
      } else {
        start = end = parseInt(range, 10);
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`cron 字段越界：${piece}`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

/**
 * 计算给定时区下 cron 表达式的下一个触发时刻（返回 ISO UTC 字符串）。
 * 基于「在本地时间字段空间逐分钟前进」再转 UTC，避开跨时区 DST 的边界问题。
 */
export function computeNextRun(
  cronExpr: string,
  timezone: string,
  fromDate: Date
): string {
  const fields = parseCron(cronExpr);

  let { year, month, day, hour, minute } = getLocalParts(timezone, fromDate);
  // 从下一分钟开始，精度到分钟
  ({ year, month, day, hour, minute } = addMinute(year, month, day, hour, minute));

  // 上限：一年 + 一天，防止死循环（cron 无解时兜底）
  const MAX_ITER = 366 * 24 * 60 + 60;
  for (let i = 0; i < MAX_ITER; i++) {
    if (!fields.month.has(month)) {
      // 跳到下个月 1 号 00:00
      ({ year, month } = addMonth(year, month));
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    if (!dayMatches(fields, year, month, day)) {
      ({ year, month, day } = addDay(year, month, day));
      hour = 0;
      minute = 0;
      continue;
    }
    if (!fields.hour.has(hour)) {
      ({ year, month, day, hour } = addHour(year, month, day, hour));
      minute = 0;
      continue;
    }
    if (!fields.minute.has(minute)) {
      ({ year, month, day, hour, minute } = addMinute(year, month, day, hour, minute));
      continue;
    }
    return new Date(localToUtcMs(year, month, day, hour, minute, timezone)).toISOString();
  }
  throw new Error(`cron 表达式在一年内无可触发时刻：${cronExpr}`);
}

function dayMatches(fields: CronFields, y: number, mo: number, d: number): boolean {
  const domHit = fields.dayOfMonth.has(d);
  const dow = dayOfWeek(y, mo, d);
  const dowHit = fields.dayOfWeek.has(dow);
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** Zeller 变体：公历日期的星期（0=Sun … 6=Sat） */
function dayOfWeek(y: number, mo: number, d: number): number {
  // 用 UTC Date 即可——星期只依赖日期本身
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function addMinute(y: number, mo: number, d: number, h: number, mi: number) {
  mi += 1;
  if (mi >= 60) {
    mi = 0;
    ({ year: y, month: mo, day: d, hour: h } = addHour(y, mo, d, h));
  }
  return { year: y, month: mo, day: d, hour: h, minute: mi };
}

function addHour(y: number, mo: number, d: number, h: number) {
  h += 1;
  if (h >= 24) {
    h = 0;
    ({ year: y, month: mo, day: d } = addDay(y, mo, d));
  }
  return { year: y, month: mo, day: d, hour: h };
}

function addDay(y: number, mo: number, d: number) {
  d += 1;
  if (d > daysInMonth(y, mo)) {
    d = 1;
    ({ year: y, month: mo } = addMonth(y, mo));
  }
  return { year: y, month: mo, day: d };
}

function addMonth(y: number, mo: number) {
  mo += 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  return { year: y, month: mo };
}

// ──────────────────────────────────────────────
// 时区辅助
// ──────────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getLocalParts(timezone: string, d: Date): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) m[p.type] = p.value;
  const hour = m.hour === "24" ? 0 : parseInt(m.hour, 10);
  return {
    year: parseInt(m.year, 10),
    month: parseInt(m.month, 10),
    day: parseInt(m.day, 10),
    hour,
    minute: parseInt(m.minute, 10),
    second: parseInt(m.second, 10),
  };
}

function getTzOffsetMs(timezone: string, utcMs: number): number {
  const parts = getLocalParts(timezone, new Date(utcMs));
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asIfUtc - utcMs;
}

function localToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timezone: string
): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // DST 切换边缘时 offset 可能前后不同，二次修正
  const o1 = getTzOffsetMs(timezone, naive);
  let t = naive - o1;
  const o2 = getTzOffsetMs(timezone, t);
  if (o2 !== o1) t = naive - o2;
  return t;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
