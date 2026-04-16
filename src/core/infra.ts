import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

const TASK_ID_RE = /^[\w.\-]+$/;
const LOCK_DIR = tmpdir();
const activeLocks = new Map<string, string>(); // taskId -> lockFilePath

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

  const taskDir = join(AUTOPILOT_HOME, "runtime", "tasks", taskId);

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

  const lockFilePath = join(LOCK_DIR, `autopilot-${taskId}.lock`);

  try {
    // flag: "wx" = write exclusive (fail if file exists)
    writeFileSync(lockFilePath, String(process.pid), { flag: "wx" });
    activeLocks.set(taskId, lockFilePath);
    log.debug(`Acquired lock for task %s at %s`, taskId, lockFilePath);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EEXIST") {
      log.debug(`Lock file already exists for task %s`, taskId);
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
 * 检查任务是否被锁定
 * @param taskId - 任务ID
 * @returns true if task is locked
 */
export function isLocked(taskId: string): boolean {
  return activeLocks.has(taskId);
}

/**
 * 清理所有活跃锁（测试用）
 */
export function _releaseAllLocks(): void {
  for (const [taskId] of activeLocks) {
    releaseLock(taskId);
  }
}
