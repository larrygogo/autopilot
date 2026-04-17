import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from "fs";
import { dirname } from "path";
import { emit } from "../daemon/event-bus";
import { appendPhaseLog } from "./task-logs";

let currentPhaseTag = "SYSTEM";
let currentPhaseName: string | undefined;  // 原始小写名称（用于文件名）
let currentTaskId: string | undefined;

// ──────────────────────────────────────────────
// daemon 进程级日志文件 —— 由 daemon 启动时激活
// 简单 size-based 轮转：>MAX_FILE_BYTES 时 rename 为 .1，开新文件；
// 保留 1 份历史，总占用上限约 2 * MAX_FILE_BYTES。
// ──────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024;  // 10 MB
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

function rotateIfNeeded(path: string): void {
  try {
    const s = statSync(path);
    if (s.size < MAX_FILE_BYTES) return;
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
  currentPhaseTag = label ?? phase.toUpperCase();
  currentPhaseName = phase;
}

export function resetPhase(): void {
  currentPhaseTag = "SYSTEM";
  currentPhaseName = undefined;
  currentTaskId = undefined;
}

export function setTaskId(taskId: string): void {
  currentTaskId = taskId;
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
  return `${ts} [${level}] [${currentPhaseTag}] [${name}] ${body}`;
}

function emitLog(level: string, formatted: string): void {
  emit({
    type: "log:entry",
    payload: {
      taskId: currentTaskId,
      phase: currentPhaseTag,
      level,
      message: formatted,
      timestamp: new Date().toISOString(),
    },
  });
  // 任务 + 阶段上下文明确时，追加到对应阶段的磁盘日志
  if (currentTaskId && currentPhaseName) {
    appendPhaseLog(currentTaskId, currentPhaseName, formatted);
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
