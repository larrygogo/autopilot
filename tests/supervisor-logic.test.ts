/**
 * supervisor 退避决策纯函数测试。
 *
 * QA 第一轮指出 supervisor 整个模块零测，但它是 daemon 崩溃自动恢复的
 * 核心。直接测 runSupervisor 需要 spawn 真子进程太重，这里把决策逻辑
 * 抽成两个纯函数 classifyExit + computeCrashBackoff，单测它们覆盖：
 * - exit code 分类（clean / respawn / crash）
 * - 崩溃退避索引（首次崩溃用 BASE[0]，第二次用 BASE[1]，超出用 BASE[max]）
 * - crash loop 检测（窗口内崩溃 ≥ THRESHOLD 强制退避到 max）
 * - 时间戳过滤（窗口外的旧崩溃被丢弃，不影响新的退避计算）
 */

import { describe, it, expect } from "bun:test";
import {
  classifyExit,
  computeCrashBackoff,
  RESTART_SENTINEL_CODE,
  BASE_BACKOFF_MS,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
} from "../src/daemon/supervisor";

describe("classifyExit", () => {
  it("shuttingDown=true 时不管 exitCode 都 exit_clean", () => {
    expect(classifyExit(0, true)).toBe("exit_clean");
    expect(classifyExit(1, true)).toBe("exit_clean");
    expect(classifyExit(RESTART_SENTINEL_CODE, true)).toBe("exit_clean");
    expect(classifyExit(null, true)).toBe("exit_clean");
  });

  it("exit 0 → exit_clean（daemon 优雅退出）", () => {
    expect(classifyExit(0, false)).toBe("exit_clean");
  });

  it(`exit ${RESTART_SENTINEL_CODE} (RESTART_SENTINEL) → respawn_immediate`, () => {
    expect(classifyExit(RESTART_SENTINEL_CODE, false)).toBe("respawn_immediate");
  });

  it("exit 2 (FATAL_CONFIG) → fatal_config，确定性配置错误不重启", () => {
    expect(classifyExit(2, false)).toBe("fatal_config");
  });

  it("shuttingDown=true 时 exit 2 也是 exit_clean", () => {
    expect(classifyExit(2, true)).toBe("exit_clean");
  });

  it("其他非零退出码 → crash", () => {
    expect(classifyExit(1, false)).toBe("crash");
    expect(classifyExit(139, false)).toBe("crash"); // SIGSEGV
    expect(classifyExit(143, false)).toBe("crash"); // SIGTERM 杀死
    expect(classifyExit(null, false)).toBe("crash"); // 异常退出 exitCode 可能为 null
  });
});

describe("computeCrashBackoff", () => {
  const now = 1000_000_000_000; // 任意固定 now

  it("首次崩溃 attempt=0 → BASE[0]=1s，记录时间戳", () => {
    const r = computeCrashBackoff({ crashTimestamps: [], attempt: 0, now });
    expect(r.backoffMs).toBe(BASE_BACKOFF_MS[0]);
    expect(r.isCrashLoop).toBe(false);
    expect(r.nextCrashTimestamps).toEqual([now]);
  });

  it("第二次崩溃 attempt=1 → BASE[1]=2s", () => {
    const r = computeCrashBackoff({ crashTimestamps: [now - 5000], attempt: 1, now });
    expect(r.backoffMs).toBe(BASE_BACKOFF_MS[1]);
    expect(r.isCrashLoop).toBe(false);
    expect(r.nextCrashTimestamps).toEqual([now - 5000, now]);
  });

  it("attempt 超出退避表长度 → 取最后一个（60s 封顶）", () => {
    const r = computeCrashBackoff({ crashTimestamps: [], attempt: 100, now });
    expect(r.backoffMs).toBe(BASE_BACKOFF_MS[BASE_BACKOFF_MS.length - 1]);
  });

  it(`窗口内崩溃达 THRESHOLD=${CRASH_LOOP_THRESHOLD} → crash loop，强制退到 60s`, () => {
    // 准备 THRESHOLD-1 个窗口内崩溃 + 现在这次 = THRESHOLD
    const recent = Array.from({ length: CRASH_LOOP_THRESHOLD - 1 }, (_, i) => now - i * 1000);
    const r = computeCrashBackoff({ crashTimestamps: recent, attempt: 3, now });
    expect(r.isCrashLoop).toBe(true);
    expect(r.backoffMs).toBe(BASE_BACKOFF_MS[BASE_BACKOFF_MS.length - 1]);
    expect(r.nextCrashTimestamps.length).toBe(CRASH_LOOP_THRESHOLD);
  });

  it(`刚好 THRESHOLD-1 → 还不算 crash loop`, () => {
    const recent = Array.from({ length: CRASH_LOOP_THRESHOLD - 2 }, (_, i) => now - i * 1000);
    const r = computeCrashBackoff({ crashTimestamps: recent, attempt: 3, now });
    expect(r.isCrashLoop).toBe(false);
    expect(r.backoffMs).toBe(BASE_BACKOFF_MS[3]);
  });

  it("窗口外（>30s）的旧崩溃被丢弃，不影响 crash loop 判定", () => {
    // 一堆很老的崩溃 + 1 个最近的
    const old = Array.from({ length: 50 }, (_, i) => now - CRASH_LOOP_WINDOW_MS - 1000 - i * 1000);
    const recent = [now - 5000];
    const r = computeCrashBackoff({ crashTimestamps: [...old, ...recent], attempt: 1, now });
    expect(r.isCrashLoop).toBe(false);
    expect(r.nextCrashTimestamps).toEqual([now - 5000, now]); // 老的全过滤掉
  });

  it("窗口刚好边界（等于 WINDOW_MS）的时间戳被保留", () => {
    // now - t == WINDOW_MS → 仍在窗口内（<=）
    const onEdge = now - CRASH_LOOP_WINDOW_MS;
    const r = computeCrashBackoff({ crashTimestamps: [onEdge], attempt: 0, now });
    expect(r.nextCrashTimestamps).toEqual([onEdge, now]);
  });
});
