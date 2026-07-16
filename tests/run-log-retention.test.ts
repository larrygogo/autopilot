/**
 * pruneTerminalRequirementRunLogs —— 终态需求超 days 天后清 run 日志目录（第三轨）。
 *
 * 覆盖：
 * - 终态需求 + 超窗口 → run 目录被清、回收字节 > 0
 * - 终态需求但未过窗口 → 不清
 * - 非终态需求（requirementTerminalAt 返回 null）→ 不清
 * - age 以「需求终态时间」为准、与 run 目录 mtime 无关（code 轨刷新 mtime 也不影响）
 * - days<=0 → no-op
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pruneTerminalRequirementRunLogs } from "../src/core/sandbox/retention";

let reqRoot: string; // 模拟 AUTOPILOT_HOME/runtime/requirements

beforeEach(() => {
  reqRoot = join(tmpdir(), `autopilot-runlog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(reqRoot, { recursive: true });
});

afterEach(() => {
  if (existsSync(reqRoot)) rmSync(reqRoot, { recursive: true, force: true });
});

/** 造一个 run 目录，写 phase 日志 + agent-calls 凑 size；可指定目录 mtime。 */
function seedRun(reqId: string, taskId: string, opts: { size?: number; mtimeMs?: number } = {}): string {
  const runDir = join(reqRoot, reqId, "runs", taskId);
  mkdirSync(join(runDir, "agent-calls"), { recursive: true });
  writeFileSync(join(runDir, "phase-develop.log"), Buffer.alloc(opts.size ?? 2048, 0x41));
  writeFileSync(join(runDir, "agent-calls", "call-1.md"), "trace");
  if (opts.mtimeMs !== undefined) {
    const sec = opts.mtimeMs / 1000;
    utimesSync(runDir, sec, sec);
  }
  return runDir;
}

const now = 1_000_000_000_000;
const DAY = 86400 * 1000;

describe("pruneTerminalRequirementRunLogs", () => {
  it("终态需求 + 超窗口 → run 目录被清", () => {
    const dir = seedRun("req-old", "task1");
    const r = pruneTerminalRequirementRunLogs({
      days: 30,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => now - 40 * DAY, // 40 天前终态
    });
    expect(r.removed).toContain("runlog:task1");
    expect(r.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("终态需求但未过窗口 → 不清", () => {
    const dir = seedRun("req-recent", "task2");
    const r = pruneTerminalRequirementRunLogs({
      days: 30,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => now - 5 * DAY, // 5 天前终态，未过 30 天
    });
    expect(r.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("非终态需求（返回 null）→ 不清", () => {
    const dir = seedRun("req-active", "task3");
    const r = pruneTerminalRequirementRunLogs({
      days: 30,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => null,
    });
    expect(r.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("age 以需求终态时间为准、与 run 目录 mtime 无关", () => {
    // run 目录 mtime 是「刚刚」（模拟 code 轨删 workspace 后刷新），但需求 40 天前终态 → 仍清
    const dir = seedRun("req-x", "task4", { mtimeMs: now });
    const r = pruneTerminalRequirementRunLogs({
      days: 30,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => now - 40 * DAY,
    });
    expect(r.removed).toContain("runlog:task4");
    expect(existsSync(dir)).toBe(false);
  });

  it("days<=0 → no-op", () => {
    const dir = seedRun("req-old", "task5");
    const r = pruneTerminalRequirementRunLogs({
      days: 0,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => now - 40 * DAY,
    });
    expect(r.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("多 run 需求：全清", () => {
    seedRun("req-multi", "runA");
    seedRun("req-multi", "runB");
    const r = pruneTerminalRequirementRunLogs({
      days: 30,
      now,
      requirementsRoot: reqRoot,
      requirementTerminalAt: () => now - 40 * DAY,
    });
    expect(r.removed.sort()).toEqual(["runlog:runA", "runlog:runB"]);
  });
});
