import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";

const PID_FILE = join(AUTOPILOT_HOME, "runtime", "daemon.pid");
const SUPERVISOR_PID_FILE = join(AUTOPILOT_HOME, "runtime", "supervisor.pid");
const LISTEN_FILE = join(AUTOPILOT_HOME, "runtime", "daemon.listen.json");

export function getPidFilePath(): string {
  return PID_FILE;
}

export function getSupervisorPidFilePath(): string {
  return SUPERVISOR_PID_FILE;
}

export function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const content = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    // 僵尸 PID 文件，清理
    removePid();
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// Supervisor PID（独立于 daemon PID）
// ──────────────────────────────────────────────

export function writeSupervisorPid(): void {
  writeFileSync(SUPERVISOR_PID_FILE, String(process.pid), "utf-8");
}

export function readSupervisorPid(): number | null {
  if (!existsSync(SUPERVISOR_PID_FILE)) return null;
  const content = readFileSync(SUPERVISOR_PID_FILE, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removeSupervisorPid(): void {
  try { unlinkSync(SUPERVISOR_PID_FILE); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────
// daemon 实际监听地址元数据 —— daemon 启动时写入，客户端/status 读取
// ──────────────────────────────────────────────

export interface DaemonListenInfo {
  host: string;
  port: number;
}

export function writeListenInfo(info: DaemonListenInfo): void {
  try { writeFileSync(LISTEN_FILE, JSON.stringify(info), "utf-8"); } catch { /* ignore */ }
}

export function readListenInfo(): DaemonListenInfo | null {
  if (!existsSync(LISTEN_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LISTEN_FILE, "utf-8"));
    if (typeof parsed?.host === "string" && typeof parsed?.port === "number") {
      return { host: parsed.host, port: parsed.port };
    }
  } catch { /* ignore */ }
  return null;
}

export function removeListenInfo(): void {
  try { unlinkSync(LISTEN_FILE); } catch { /* ignore */ }
}

export function isSupervisorRunning(): boolean {
  const pid = readSupervisorPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    removeSupervisorPid();
    return false;
  }
  return true;
}
