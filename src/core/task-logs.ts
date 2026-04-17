import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";

// ──────────────────────────────────────────────
// 任务日志落盘
//
// 布局（每个任务）：
//   runtime/tasks/<task-id>/logs/
//     ├── phase-<name>.log       每阶段完整 stdout/stderr 记录（纯文本追加）
//     └── events.jsonl           任务级事件流：created / transition / phase-started / error ...
// ──────────────────────────────────────────────

const TASK_ID_RE = /^[\w.\-]+$/;
const PHASE_NAME_RE = /^[A-Za-z][A-Za-z0-9_\-]*$/;
const MAX_READ_LINES = 5000;

export interface TaskEvent {
  ts: string;
  type: string;
  phase?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
}

export interface PhaseLogMeta {
  phase: string;
  size: number;
  mtime: number;
  lines?: number;  // 按需统计，可能慢，默认不填
}

function taskLogsDir(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`非法 taskId：${taskId}`);
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "logs");
}

function ensureTaskLogsDir(taskId: string): string {
  const dir = taskLogsDir(taskId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function phaseLogPath(taskId: string, phase: string): string {
  if (!PHASE_NAME_RE.test(phase)) throw new Error(`非法 phase 名：${phase}`);
  return join(ensureTaskLogsDir(taskId), `phase-${phase}.log`);
}

function eventsPath(taskId: string): string {
  return join(ensureTaskLogsDir(taskId), "events.jsonl");
}

/**
 * 追加一行到指定阶段日志。自动补换行符。失败静默（不阻塞业务）。
 */
export function appendPhaseLog(taskId: string, phase: string, line: string): void {
  try {
    const path = phaseLogPath(taskId, phase);
    const text = line.endsWith("\n") ? line : line + "\n";
    appendFileSync(path, text, "utf-8");
  } catch { /* 落盘失败不影响实时推送 */ }
}

/**
 * 追加任务事件。失败静默。
 */
export function appendTaskEvent(taskId: string, event: Omit<TaskEvent, "ts"> & { ts?: string }): void {
  try {
    const path = eventsPath(taskId);
    const full = { ...event, ts: event.ts ?? new Date().toISOString() } as TaskEvent;
    appendFileSync(path, JSON.stringify(full) + "\n", "utf-8");
  } catch { /* ignore */ }
}

/**
 * 列出任务已有的阶段日志文件，返回元信息。
 * 日志目录不存在时返回空数组。
 */
export function listPhaseLogs(taskId: string): PhaseLogMeta[] {
  const dir = taskLogsDir(taskId);
  if (!existsSync(dir)) return [];
  const out: PhaseLogMeta[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^phase-(.+)\.log$/);
    if (!m) continue;
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.isFile()) {
        out.push({ phase: m[1], size: s.size, mtime: s.mtimeMs });
      }
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/**
 * 读取阶段日志内容。默认最后 MAX_READ_LINES 行。
 */
export function readPhaseLog(taskId: string, phase: string, opts?: { tail?: number }): string {
  const path = phaseLogPath(taskId, phase);
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf-8");
  const tail = opts?.tail ?? MAX_READ_LINES;
  if (tail <= 0 || tail >= Infinity) return raw;
  // 去掉 trailing newline 产生的空段，避免 tail 少取一行
  const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = content.split("\n");
  if (lines.length <= tail) return raw;
  return lines.slice(-tail).join("\n") + "\n";
}

/**
 * 读取事件流（JSONL）。默认 tail 最后 N 条。
 */
export function readTaskEvents(taskId: string, opts?: { tail?: number }): TaskEvent[] {
  const path = eventsPath(taskId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = opts?.tail ?? MAX_READ_LINES;
  const take = tail > 0 && tail < lines.length ? lines.slice(-tail) : lines;
  const events: TaskEvent[] = [];
  for (const line of take) {
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return events;
}
