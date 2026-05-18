/**
 * daemon log size-based rotation 测试。
 *
 * MAX_FILE_BYTES=10MB 阈值的 rename .log → .log.1 机制是 daemon 长跑磁盘
 * 占用上限的核心约束（无 rotation → 客户日志能涨到几个 GB）。一直没单测，
 * 重构很容易破坏 — 这里加上回归保护。
 *
 * 覆盖：
 * - 小于阈值不动
 * - 超阈值 rename → .1，原路径下次写时重建（这里只验 rename 行为）
 * - 已有 .1 时再次 rotate 覆盖旧 .1（rename 到已存在文件在某些平台不原子，
 *   代码先 unlink 再 rename）
 * - 文件不存在 → 静默不抛
 * - 阈值边界：等于阈值时仍触发（s.size < maxBytes 才是不动）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rotateIfNeeded, MAX_FILE_BYTES } from "../src/core/logger";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `autopilot-log-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("rotateIfNeeded", () => {
  it("文件大小 < 阈值 → 不动", () => {
    const path = join(tmpDir, "daemon.log");
    writeFileSync(path, "small content", "utf-8");
    rotateIfNeeded(path, 1024);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".1")).toBe(false);
  });

  it("文件大小 >= 阈值 → rename 为 .1，原路径消失", () => {
    const path = join(tmpDir, "daemon.log");
    const big = "x".repeat(2048);
    writeFileSync(path, big, "utf-8");
    rotateIfNeeded(path, 1024);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(path + ".1")).toBe(true);
    expect(readFileSync(path + ".1", "utf-8")).toBe(big);
  });

  it("阈值刚好等于文件大小 → 触发 rotate（条件是 size < maxBytes 才不动）", () => {
    const path = join(tmpDir, "daemon.log");
    const content = "x".repeat(1024);
    writeFileSync(path, content, "utf-8");
    rotateIfNeeded(path, 1024);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(path + ".1")).toBe(true);
  });

  it("已存在 .1 时再次 rotate → 旧 .1 被覆盖", () => {
    const path = join(tmpDir, "daemon.log");
    writeFileSync(path + ".1", "old backup", "utf-8");
    writeFileSync(path, "x".repeat(2048), "utf-8");
    rotateIfNeeded(path, 1024);
    expect(existsSync(path + ".1")).toBe(true);
    // 旧 backup 应已被新内容覆盖
    expect(readFileSync(path + ".1", "utf-8")).toBe("x".repeat(2048));
  });

  it("文件不存在 → 静默不抛错", () => {
    const path = join(tmpDir, "nonexistent.log");
    expect(() => rotateIfNeeded(path, 1024)).not.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(path + ".1")).toBe(false);
  });

  it("不传 maxBytes 时用默认 MAX_FILE_BYTES（10MB）", () => {
    const path = join(tmpDir, "daemon.log");
    writeFileSync(path, "x".repeat(1024), "utf-8");
    rotateIfNeeded(path); // 默认 10MB，小文件不触发
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".1")).toBe(false);
  });

  it("MAX_FILE_BYTES 是 10MB", () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("rotate 多轮：写大文件 → rotate → 重新写 → 再 rotate → 仅保留 1 份 .1", () => {
    const path = join(tmpDir, "daemon.log");
    // 第一轮：大文件 → rotate
    writeFileSync(path, "first-big-" + "x".repeat(2048), "utf-8");
    rotateIfNeeded(path, 1024);
    // 第二轮：重写大文件（appendFileLog 风格） → rotate 覆盖旧 .1
    writeFileSync(path, "second-big-" + "y".repeat(2048), "utf-8");
    rotateIfNeeded(path, 1024);
    // 主文件已被 rotate 走，.1 应是第二轮内容
    expect(existsSync(path)).toBe(false);
    expect(existsSync(path + ".1")).toBe(true);
    const content = readFileSync(path + ".1", "utf-8");
    expect(content).toContain("second-big-");
    expect(content).not.toContain("first-big-");
    // 没有 .2 / .3 等多份历史
    expect(existsSync(path + ".2")).toBe(false);
  });
});
