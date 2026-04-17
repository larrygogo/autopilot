import { emit } from "../daemon/event-bus";

let currentPhaseTag = "SYSTEM";
let currentTaskId: string | undefined;

export function setPhase(phase: string, label?: string): void {
  currentPhaseTag = label ?? phase.toUpperCase();
}

export function resetPhase(): void {
  currentPhaseTag = "SYSTEM";
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
