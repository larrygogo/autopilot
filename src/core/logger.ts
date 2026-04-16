let currentPhaseTag = "SYSTEM";

export function setPhase(phase: string, label?: string): void {
  currentPhaseTag = label ?? phase.toUpperCase();
}

export function resetPhase(): void {
  currentPhaseTag = "SYSTEM";
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

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(name: string): Logger {
  return {
    info: (msg, ...args) => console.error(fmt("INFO", name, msg, args)),
    warn: (msg, ...args) => console.error(fmt("WARN", name, msg, args)),
    error: (msg, ...args) => console.error(fmt("ERROR", name, msg, args)),
    debug: (msg, ...args) => { if (process.env.DEBUG) console.error(fmt("DEBUG", name, msg, args)); },
  };
}

export const log = createLogger("core");
