import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireRunnerLock, releaseRunnerLock, isRunnerLockHeld, runnerLockPath } from "../src/daemon/runner/lock";

let home: string, prev: string | undefined;
beforeEach(() => {
  prev = process.env.AUTOPILOT_HOME;
  home = mkdtempSync(join(tmpdir(), "runner-lock-"));
  process.env.AUTOPILOT_HOME = home;
  mkdirSync(join(home, "runtime"), { recursive: true });
});
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prev;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

test("acquireRunnerLock：无锁时成功并写入本进程 pid", () => {
  expect(acquireRunnerLock()).toBe(true);
  expect(isRunnerLockHeld()).toBe(true);
});

test("acquireRunnerLock：活进程持锁时拒绝", () => {
  writeFileSync(runnerLockPath(), String(process.pid)); // 本进程恒活
  expect(acquireRunnerLock()).toBe(false);
});

test("acquireRunnerLock：僵尸锁（死 pid）自动清理后获取成功", () => {
  writeFileSync(runnerLockPath(), "999999999"); // 几乎不可能存活的 pid
  expect(acquireRunnerLock()).toBe(true);
});

test("releaseRunnerLock：移除锁文件", () => {
  acquireRunnerLock();
  releaseRunnerLock();
  expect(existsSync(runnerLockPath())).toBe(false);
});
