import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from "fs";
import { dirname } from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { emit } from "./event-bus";
import { appendPhaseLog } from "./task/logs";

// ──────────────────────────────────────────────
// 日志上下文（task / phase）= 每次 phase 执行各自隔离
//
// 历史上这三个是进程级可变全局；但 daemon 同进程并发跑多个 phase（runInBackground
// = setImmediate 同进程 async），全局态被并发 phase 互相覆盖 → 日志窜进别的 task 的
// phase-<name>.log（按 task 排障不可靠）。改用 AsyncLocalStorage：executePhase 用
// runWithLogContext 包住整个执行，每个 phase 异步链拿到独立 store，跨 await 不串写。
// 全局变量保留为兜底——非 phase 执行路径（daemon 生命周期 / clarifier 等无 als 上下文）
// 仍走全局，行为不变。
// ──────────────────────────────────────────────
interface LogStore {
  taskId?: string;
  phaseName?: string;  // 原始小写名称（用于文件名）
  phaseTag: string;    // 显示标签（label 或大写 phase 名）
}
const als = new AsyncLocalStorage<LogStore>();

let gPhaseTag = "SYSTEM";
let gPhaseName: string | undefined;
let gTaskId: string | undefined;

/**
 * 在独立日志上下文中执行 fn。每个 phase 执行（executePhase）各开一个 store，
 * 并发互不串写；fn 内的 setPhase/setTaskId/resetPhase 改的是本 store。
 */
export function runWithLogContext<T>(
  ctx: { taskId?: string; phaseName?: string; phaseTag?: string },
  fn: () => T,
): T {
  return als.run(
    {
      taskId: ctx.taskId,
      phaseName: ctx.phaseName,
      phaseTag: ctx.phaseTag ?? ctx.phaseName?.toUpperCase() ?? "SYSTEM",
    },
    fn,
  );
}

/** 当前生效的日志上下文（als store 优先，回退全局）。测试与读取用。 */
export function currentLogContext(): { taskId?: string; phaseName?: string; phaseTag: string } {
  const s = als.getStore();
  if (s) return { taskId: s.taskId, phaseName: s.phaseName, phaseTag: s.phaseTag };
  return { taskId: gTaskId, phaseName: gPhaseName, phaseTag: gPhaseTag };
}

// ──────────────────────────────────────────────
// daemon 进程级日志文件 —— 由 daemon 启动时激活
// 简单 size-based 轮转：>MAX_FILE_BYTES 时 rename 为 .1，开新文件；
// 保留 1 份历史，总占用上限约 2 * MAX_FILE_BYTES。
// ──────────────────────────────────────────────

export const MAX_FILE_BYTES = 10 * 1024 * 1024;  // 10 MB
let fileLogPath: string | undefined;

export function initDaemonFileLog(path: string): void {
  // 空字符串视为"关闭"，方便测试 / 子命令清理
  if (!path) {
    fileLogPath = undefined;
    return;
  }
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fileLogPath = path;
  } catch {
    // 激活失败静默 —— daemon 不会因为日志写不了就挂
    fileLogPath = undefined;
  }
}

export function getDaemonFileLogPath(): string | undefined {
  return fileLogPath;
}

/**
 * 文件超 maxBytes 时 rename 为 `.1`（覆盖已存在的旧 .1）。下次 append 会重建原路径。
 * 测试用：maxBytes 默认 MAX_FILE_BYTES，可注入小值方便构造场景。
 * 失败静默 — daemon 不会因为日志写不了就挂。
 */
export function rotateIfNeeded(path: string, maxBytes: number = MAX_FILE_BYTES): void {
  try {
    const s = statSync(path);
    if (s.size < maxBytes) return;
    const backup = path + ".1";
    // 删除旧 backup（rename 到已存在文件在部分平台不原子）
    try { if (existsSync(backup)) unlinkSync(backup); } catch { /* ignore */ }
    renameSync(path, backup);
  } catch { /* ignore; next write 会重建 */ }
}

function appendFileLog(formatted: string): void {
  const path = fileLogPath;
  if (!path) return;
  try {
    if (existsSync(path)) rotateIfNeeded(path);
    appendFileSync(path, formatted + "\n", "utf-8");
  } catch { /* 写不了也不阻塞业务 */ }
}

/**
 * 读取 daemon 主日志最后 N 行。包含旧 rotation 文件（.1）的内容。
 */
export function readDaemonFileLog(tail = 1000): string {
  const path = fileLogPath;
  if (!path) return "";
  const parts: string[] = [];
  const backup = path + ".1";
  try {
    if (existsSync(backup)) parts.push(readFileSync(backup, "utf-8"));
  } catch { /* ignore */ }
  try {
    if (existsSync(path)) parts.push(readFileSync(path, "utf-8"));
  } catch { /* ignore */ }
  const combined = parts.join("");
  if (!combined) return "";
  const content = combined.endsWith("\n") ? combined.slice(0, -1) : combined;
  const lines = content.split("\n");
  if (tail <= 0 || tail >= lines.length) return content;
  return lines.slice(-tail).join("\n");
}

export function setPhase(phase: string, label?: string): void {
  const s = als.getStore();
  if (s) {
    s.phaseTag = label ?? phase.toUpperCase();
    s.phaseName = phase;
  } else {
    gPhaseTag = label ?? phase.toUpperCase();
    gPhaseName = phase;
  }
}

export function resetPhase(): void {
  const s = als.getStore();
  if (s) {
    s.phaseTag = "SYSTEM";
    s.phaseName = undefined;
    s.taskId = undefined;
  } else {
    gPhaseTag = "SYSTEM";
    gPhaseName = undefined;
    gTaskId = undefined;
  }
}

export function setTaskId(taskId: string): void {
  const s = als.getStore();
  if (s) s.taskId = taskId;
  else gTaskId = taskId;
}

function fmt(level: string, name: string, msg: string, args: unknown[]): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  let i = 0;
  const body = args.length > 0
    ? msg.replace(/%[sdo]/g, () => {
        if (i >= args.length) return "%s";
        const arg = args[i++];
        return typeof arg === "object" && arg !== null ? JSON.stringify(arg) : String(arg);
      })
    : msg;
  const tag = als.getStore()?.phaseTag ?? gPhaseTag;
  return `${ts} [${level}] [${tag}] [${name}] ${body}`;
}

function emitLog(level: string, formatted: string): void {
  const s = als.getStore();
  const taskId = s?.taskId ?? gTaskId;
  const phaseName = s?.phaseName ?? gPhaseName;
  const phaseTag = s?.phaseTag ?? gPhaseTag;
  emit({
    type: "log:entry",
    payload: {
      taskId,
      phase: phaseTag,
      level,
      message: formatted,
      timestamp: new Date().toISOString(),
    },
  });
  // 任务 + 阶段上下文明确时，追加到对应阶段的磁盘日志
  if (taskId && phaseName) {
    appendPhaseLog(taskId, phaseName, formatted);
  }
  // daemon 进程级日志（所有 daemon 生命周期都记录到同一个文件）
  appendFileLog(formatted);
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(name: string): Logger {
  return {
    info: (msg, ...args) => {
      const s = fmt("INFO", name, msg, args);
      console.error(s);
      emitLog("INFO", s);
    },
    warn: (msg, ...args) => {
      const s = fmt("WARN", name, msg, args);
      console.error(s);
      emitLog("WARN", s);
    },
    error: (msg, ...args) => {
      const s = fmt("ERROR", name, msg, args);
      console.error(s);
      emitLog("ERROR", s);
    },
    debug: (msg, ...args) => {
      if (process.env.DEBUG) {
        const s = fmt("DEBUG", name, msg, args);
        console.error(s);
        emitLog("DEBUG", s);
      }
    },
  };
}

export const log = createLogger("core");
