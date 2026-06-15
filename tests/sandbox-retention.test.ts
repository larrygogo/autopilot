/**
 * workspace_retention 策略测试。
 *
 * CLAUDE.md 写了 workspace_retention.days / max_total_mb 配置，daemon 每小时
 * 调一次 pruneSandboxesByPolicy → applyRetentionPolicy，但完全无单测。客户
 * 跑一段时间后磁盘会涨，retention 不工作就是个真痛点。
 *
 * 覆盖：
 * - 空 policy → 不动任何 workspace
 * - days 策略：超期终态删 / 非终态保留 / mtime 在阈值内的保留
 * - max_total_mb：总占用超限时按 mtime 旧→新删
 * - 综合：days + max_total_mb 都设
 * - isTerminal 注入：非终态绝不删（运行中任务保护）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyRetentionPolicy } from "../src/core/sandbox-retention";

let tmpRoot: string; // 模拟 AUTOPILOT_HOME/runtime/tasks

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `autopilot-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建一个 fake task workspace，写一些内容凑出 size。可选指定 mtime。 */
function seedTask(taskId: string, opts: { size?: number; mtimeMs?: number } = {}): string {
  const ws = join(tmpRoot, taskId, "workspace");
  mkdirSync(ws, { recursive: true });
  const size = opts.size ?? 100;
  writeFileSync(join(ws, "data.bin"), Buffer.alloc(size, 0x42));
  if (opts.mtimeMs !== undefined) {
    const sec = opts.mtimeMs / 1000;
    utimesSync(ws, sec, sec);
  }
  return ws;
}

describe("applyRetentionPolicy", () => {
  const now = 1_000_000_000_000;
  const DAY_MS = 86400 * 1000;

  it("空 policy → 啥都不删", () => {
    seedTask("t1", { mtimeMs: now - 100 * DAY_MS });
    seedTask("t2");
    const r = applyRetentionPolicy({}, { tasksRoot: tmpRoot, now });
    expect(r.removed).toEqual([]);
    expect(r.reclaimedBytes).toBe(0);
    expect(existsSync(join(tmpRoot, "t1", "workspace"))).toBe(true);
    expect(existsSync(join(tmpRoot, "t2", "workspace"))).toBe(true);
  });

  it("days 策略：超 N 天的终态任务被删", () => {
    seedTask("old1", { mtimeMs: now - 10 * DAY_MS });
    seedTask("recent", { mtimeMs: now - 1 * DAY_MS });
    const r = applyRetentionPolicy(
      { days: 7 },
      { tasksRoot: tmpRoot, now, isTerminal: () => true },
    );
    expect(r.removed).toEqual(["old1"]);
    expect(existsSync(join(tmpRoot, "old1", "workspace"))).toBe(false);
    expect(existsSync(join(tmpRoot, "recent", "workspace"))).toBe(true);
  });

  it("days 策略：超期但非终态的不删（运行中任务保护）", () => {
    seedTask("old-running", { mtimeMs: now - 10 * DAY_MS });
    seedTask("old-done", { mtimeMs: now - 10 * DAY_MS });
    const r = applyRetentionPolicy(
      { days: 7 },
      {
        tasksRoot: tmpRoot,
        now,
        isTerminal: (id) => id === "old-done",
      },
    );
    expect(r.removed).toEqual(["old-done"]);
    expect(existsSync(join(tmpRoot, "old-running", "workspace"))).toBe(true);
  });

  it("max_total_mb：总占用超限时按 mtime 旧→新删到低于阈值", () => {
    // 3 个 task 各 ~500KB，max 1MB
    seedTask("oldest", { size: 500_000, mtimeMs: now - 30 * DAY_MS });
    seedTask("middle", { size: 500_000, mtimeMs: now - 20 * DAY_MS });
    seedTask("newest", { size: 500_000, mtimeMs: now - 10 * DAY_MS });
    const r = applyRetentionPolicy(
      { max_total_mb: 1 },
      { tasksRoot: tmpRoot, now, isTerminal: () => true },
    );
    // 总 ~1.5MB，max 1MB → 删最老的让总 ≤ 1MB
    expect(r.removed).toContain("oldest");
    expect(r.removed).not.toContain("newest");
    expect(existsSync(join(tmpRoot, "newest", "workspace"))).toBe(true);
  });

  it("max_total_mb：非终态任务不会被删，即使它最老", () => {
    seedTask("running-oldest", { size: 800_000, mtimeMs: now - 30 * DAY_MS });
    seedTask("done-newer", { size: 800_000, mtimeMs: now - 10 * DAY_MS });
    const r = applyRetentionPolicy(
      { max_total_mb: 1 },
      {
        tasksRoot: tmpRoot,
        now,
        isTerminal: (id) => id === "done-newer",
      },
    );
    // 总 ~1.6MB > 1MB，但 running-oldest 不能删，只能删 done-newer
    expect(r.removed).toEqual(["done-newer"]);
    expect(existsSync(join(tmpRoot, "running-oldest", "workspace"))).toBe(true);
  });

  it("综合：days + max_total_mb 都设，先按 days 再按 size", () => {
    seedTask("ancient", { size: 100_000, mtimeMs: now - 30 * DAY_MS }); // 超 days
    seedTask("oldish", { size: 600_000, mtimeMs: now - 5 * DAY_MS });    // 在 days 内 + 总占用大
    seedTask("newish", { size: 600_000, mtimeMs: now - 1 * DAY_MS });    // 最新
    const r = applyRetentionPolicy(
      { days: 7, max_total_mb: 1 },
      { tasksRoot: tmpRoot, now, isTerminal: () => true },
    );
    // days：ancient 删（超 7 天）
    // size：剩 oldish + newish 共 1.2MB > 1MB → 删最老的 oldish
    expect(r.removed.sort()).toEqual(["ancient", "oldish"]);
    expect(existsSync(join(tmpRoot, "newish", "workspace"))).toBe(true);
  });

  it("无 isTerminal 注入 → days 策略对所有超期都生效（含运行中）", () => {
    // 当调用方没传 isTerminal 时，applyRetentionPolicy 默认所有都视作可删
    // 这是默认行为，调用方有责任传 isTerminal 保护运行中任务
    seedTask("old", { mtimeMs: now - 30 * DAY_MS });
    const r = applyRetentionPolicy(
      { days: 7 },
      { tasksRoot: tmpRoot, now }, // 故意不传 isTerminal
    );
    expect(r.removed).toEqual(["old"]);
  });

  it("空目录 → 不抛错，返回空结果", () => {
    const r = applyRetentionPolicy(
      { days: 7, max_total_mb: 1 },
      { tasksRoot: tmpRoot, now },
    );
    expect(r.removed).toEqual([]);
    expect(r.reclaimedBytes).toBe(0);
  });

  it("workspace 不存在的 task 目录（残留只剩 logs/）不参与策略", () => {
    // 模拟历史 task 已经被清过 workspace、仅留 logs
    mkdirSync(join(tmpRoot, "history-only", "logs"), { recursive: true });
    seedTask("alive", { mtimeMs: now - 30 * DAY_MS });
    const r = applyRetentionPolicy(
      { days: 7 },
      { tasksRoot: tmpRoot, now, isTerminal: () => true },
    );
    expect(r.removed).toEqual(["alive"]);
    // history-only 没有 workspace 子目录，根本不进 scan 结果，不影响
    expect(existsSync(join(tmpRoot, "history-only"))).toBe(true);
  });

  it("reclaimedBytes 反映真实删除大小", () => {
    seedTask("big", { size: 1_000_000, mtimeMs: now - 30 * DAY_MS });
    seedTask("small", { size: 1_000, mtimeMs: now - 30 * DAY_MS });
    const r = applyRetentionPolicy(
      { days: 7 },
      { tasksRoot: tmpRoot, now, isTerminal: () => true },
    );
    expect(r.removed.sort()).toEqual(["big", "small"]);
    // dirSizeBytes 算的是 workspace 下所有文件，big 是 1MB + small 1KB
    expect(r.reclaimedBytes).toBeGreaterThanOrEqual(1_000_000);
    expect(r.reclaimedBytes).toBeLessThan(1_100_000);
  });
});
