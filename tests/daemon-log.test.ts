import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { initDaemonFileLog, readDaemonFileLog, getDaemonFileLogPath, createLogger } from "../src/core/logger";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-daemon-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  logPath = join(tmpDir, "daemon.log");
});

afterEach(() => {
  initDaemonFileLog("");  // 清理全局状态
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("daemon file log", () => {
  it("initDaemonFileLog 后 logger 同时写到文件", () => {
    initDaemonFileLog(logPath);
    const log = createLogger("test");
    log.info("hello %s", "world");
    log.warn("beware");
    log.error("bad");

    expect(existsSync(logPath)).toBe(true);
    const content = readDaemonFileLog();
    expect(content).toContain("hello world");
    expect(content).toContain("beware");
    expect(content).toContain("bad");
  });

  it("未激活时不写文件", () => {
    const log = createLogger("test");
    log.info("nothing");
    expect(existsSync(logPath)).toBe(false);
  });

  it("getDaemonFileLogPath 返回当前路径", () => {
    expect(getDaemonFileLogPath()).toBeUndefined();
    initDaemonFileLog(logPath);
    expect(getDaemonFileLogPath()).toBe(logPath);
  });

  it("readDaemonFileLog 支持 tail", () => {
    initDaemonFileLog(logPath);
    const log = createLogger("test");
    for (let i = 1; i <= 20; i++) log.info("line-%d", i);
    const tail5 = readDaemonFileLog(5);
    const lines = tail5.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[4]).toContain("line-20");
    expect(lines[0]).toContain("line-16");
  });

  it("readDaemonFileLog 合并 .1 备份", () => {
    initDaemonFileLog(logPath);
    // 手动造 rotation：先写 .1，再写主文件
    writeFileSync(logPath + ".1", "old-line-1\nold-line-2\n");
    writeFileSync(logPath, "new-line-1\nnew-line-2\n");
    const all = readDaemonFileLog(100);
    const lines = all.split("\n");
    expect(lines).toEqual(["old-line-1", "old-line-2", "new-line-1", "new-line-2"]);
  });
});
