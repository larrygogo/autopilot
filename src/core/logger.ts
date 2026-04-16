let currentPhaseTag = "SYSTEM";

export function setPhase(phase: string, label?: string): void {
  currentPhaseTag = label ?? phase.toUpperCase();
}

export function resetPhase(): void {
  currentPhaseTag = "SYSTEM";
}

function fmt(level: string, msg: string, args: unknown[]): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  let i = 0;
  const body = args.length > 0
    ? msg.replace(/%[sdo]/g, () => (i < args.length ? String(args[i++]) : "%s"))
    : msg;
  return `${ts} [${level}] [${currentPhaseTag}] ${body}`;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(_name: string): Logger {
  return {
    info: (msg, ...args) => console.error(fmt("INFO", msg, args)),
    warn: (msg, ...args) => console.error(fmt("WARN", msg, args)),
    error: (msg, ...args) => console.error(fmt("ERROR", msg, args)),
    debug: (msg, ...args) => { if (process.env.DEBUG) console.error(fmt("DEBUG", msg, args)); },
  };
}

export const log = createLogger("core");
