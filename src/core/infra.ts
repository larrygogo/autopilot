import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger";

/** 动态读取 AUTOPILOT_HOME，支持测试中修改 env */
function getAutopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

function getLockDir(): string {
  const dir = join(getAutopilotHome(), "runtime", "locks");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const TASK_ID_RE = /^[\w.\-]+$/;
const activeLocks = new Map<string, string>(); // taskId -> lockFilePath

/**
 * 检查锁文件对应的进程是否仍然存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理僵尸锁文件（进程已死但锁文件未删除）
 * @returns true 如果清理了僵尸锁
 */
function cleanStaleLock(lockFilePath: string): boolean {
  try {
    const content = readFileSync(lockFilePath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) {
      // 锁文件内容无效，视为僵尸锁
      unlinkSync(lockFilePath);
      log.warn("清理无效锁文件：%s", lockFilePath);
      return true;
    }
    if (!isProcessAlive(pid)) {
      unlinkSync(lockFilePath);
      log.warn("清理僵尸锁文件：%s（PID %d 已不存在）", lockFilePath, pid);
      return true;
    }
    return false;
  } catch {
    // 锁文件已被其他进程删除，或读取/删除失败
    return !existsSync(lockFilePath);
  }
}

/**
 * 获取任务目录，自动创建目录结构
 * @param taskId - 任务ID，必须符合 /^[\w.\-]+$/ 格式
 * @returns 任务目录路径
 * @throws 当 taskId 非法时抛出错误
 */
export function getTaskDir(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`Invalid task ID: ${taskId}. Must match /^[\\w.\\-]+$/`);
  }

  const taskDir = join(getAutopilotHome(), "runtime", "tasks", taskId);

  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
    log.debug(`Created task directory: %s`, taskDir);
  }

  return taskDir;
}

/**
 * 原子性获取锁，使用 writeFileSync with exclusive flag
 * @param taskId - 任务ID
 * @returns true if lock acquired successfully, false if already locked
 */
export function acquireLock(taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`Invalid task ID: ${taskId}. Must match /^[\\w.\\-]+$/`);
  }

  // 检查是否已在活跃锁中
  if (activeLocks.has(taskId)) {
    log.debug(`Task %s is already locked`, taskId);
    return false;
  }

  const lockFilePath = join(getLockDir(), `autopilot-${taskId}.lock`);

  try {
    // flag: "wx" = write exclusive (fail if file exists)
    writeFileSync(lockFilePath, String(process.pid), { flag: "wx" });
    activeLocks.set(taskId, lockFilePath);
    log.debug(`Acquired lock for task %s at %s`, taskId, lockFilePath);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EEXIST") {
      // 锁文件已存在，检查是否为僵尸锁
      if (cleanStaleLock(lockFilePath)) {
        // 僵尸锁已清理，重试获取
        try {
          writeFileSync(lockFilePath, String(process.pid), { flag: "wx" });
          activeLocks.set(taskId, lockFilePath);
          log.debug(`Acquired lock for task %s after stale lock cleanup`, taskId);
          return true;
        } catch {
          log.debug(`Lock file re-created by another process for task %s`, taskId);
          return false;
        }
      }
      log.debug(`Lock file already exists for task %s (process alive)`, taskId);
      return false;
    }
    throw error;
  }
}

/**
 * 释放锁，删除锁文件
 * @param taskId - 任务ID
 */
export function releaseLock(taskId: string): void {
  const lockFilePath = activeLocks.get(taskId);

  if (!lockFilePath) {
    log.warn(`No lock found for task %s`, taskId);
    return;
  }

  try {
    if (existsSync(lockFilePath)) {
      unlinkSync(lockFilePath);
      log.debug(`Released lock for task %s`, taskId);
    }
  } catch (err) {
    log.error(`Failed to delete lock file for task %s: %s`, taskId, String(err));
  }

  activeLocks.delete(taskId);
}

/**
 * 检查任务是否被锁定（同时检查进程内 Map 和锁文件，支持跨进程检测）
 * 自动清理僵尸锁文件（对应进程已死亡）
 * @param taskId - 任务ID
 * @returns true if task is locked by an alive process
 */
export function isLocked(taskId: string): boolean {
  if (activeLocks.has(taskId)) return true;
  const lockFilePath = join(getLockDir(), `autopilot-${taskId}.lock`);
  if (!existsSync(lockFilePath)) return false;
  // 锁文件存在，检查进程是否存活
  if (cleanStaleLock(lockFilePath)) {
    return false; // 僵尸锁已清理
  }
  return true;
}

/**
 * 清理所有活跃锁（测试用）
 */
export function _releaseAllLocks(): void {
  for (const [taskId] of activeLocks) {
    releaseLock(taskId);
  }
}
