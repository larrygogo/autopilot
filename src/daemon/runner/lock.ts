import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { AUTOPILOT_HOME } from "../../index";
import { isProcessAlive } from "../pid";

function home(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

/** runner 单实例锁路径 runtime/runner.lock（复用 daemon PID 锁的存活检测语义）。 */
export function runnerLockPath(): string {
  return join(home(), "runtime", "runner.lock");
}

function readLockPid(): number | null {
  const p = runnerLockPath();
  if (!existsSync(p)) return null;
  const n = parseInt(readFileSync(p, "utf8").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 当前锁是否被活进程持有（僵尸锁自动清）。 */
export function isRunnerLockHeld(): boolean {
  const pid = readLockPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    releaseRunnerLock();
    return false;
  }
  return true;
}

/** 抢锁：无锁或僵尸锁→写本进程 pid 返 true；活进程持锁→返 false。 */
export function acquireRunnerLock(): boolean {
  if (isRunnerLockHeld()) return false;
  const p = runnerLockPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(process.pid), "utf8");
  return true;
}

/** 释放锁（best-effort）。 */
export function releaseRunnerLock(): void {
  try {
    unlinkSync(runnerLockPath());
  } catch {
    /* ignore */
  }
}
