import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";

const PID_FILE = join(AUTOPILOT_HOME, "runtime", "daemon.pid");

export function getPidFilePath(): string {
  return PID_FILE;
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
