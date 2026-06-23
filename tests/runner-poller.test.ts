// tests/runner-poller.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerPoller } from "../src/daemon/runner/poller";
import type { RunnerBackend } from "../src/daemon/runner/backend";
import type { PendingSession } from "../src/daemon/runner/types";

let home: string, prev: string | undefined;
beforeEach(() => {
  prev = process.env.AUTOPILOT_HOME;
  home = mkdtempSync(join(tmpdir(), "runner-poll-"));
  process.env.AUTOPILOT_HOME = home;
  mkdirSync(join(home, "runtime"), { recursive: true });
});
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOPILOT_HOME; else process.env.AUTOPILOT_HOME = prev;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function backendWithPending(queue: Array<PendingSession | null>): RunnerBackend & { heartbeats: number; claimCalls: number } {
  let i = 0;
  const be: any = {
    heartbeats: 0, claimCalls: 0,
    async claimPending() { be.claimCalls++; return queue[i++] ?? null; },
    async runnerHeartbeat() { be.heartbeats++; },
    async fetchEvents() { return []; },
    async postEvent(_id: string, ev: any) { return { ...ev, seq: 1 }; },
    async getSession() { return { id: "s", status: "completed", current_stage: "done", repos: [] }; },
    async getGitToken() { return "t"; },
    async sessionHeartbeat() { return { terminal: false }; },
    async deregister() {},
  };
  return be;
}

test("抢不到 runner.lock 时拒绝启动", () => {
  const { writeFileSync } = require("fs");
  writeFileSync(join(home, "runtime", "runner.lock"), String(process.pid)); // 本进程恒活
  const p = new RunnerPoller(backendWithPending([]), { pollWaitSeconds: 0, heartbeatMs: 10_000, runSession: async () => {} });
  expect(() => p.start()).toThrow(/runner.lock|已被占用|另一实例/);
});

test("领到 session → 调 runSession，期间不再 claim（忙则停领）", async () => {
  let running = 0, maxConcurrent = 0, claimsWhileBusy = 0;
  const be = backendWithPending([{ session_id: "sess-1", current_stage: "clarify" }, { session_id: "sess-2", current_stage: "clarify" }]);
  const origClaim = be.claimPending.bind(be);
  (be as any).claimPending = async (wait: number) => { if (running > 0) claimsWhileBusy++; return origClaim(wait); };
  const p = new RunnerPoller(be, {
    pollWaitSeconds: 0, heartbeatMs: 10_000,
    runSession: async () => { running++; maxConcurrent = Math.max(maxConcurrent, running); await new Promise((r) => setTimeout(r, 20)); running--; },
  });
  p.start();
  await new Promise((r) => setTimeout(r, 80));
  p.dispose();
  expect(maxConcurrent).toBe(1);     // 单 session 自律
  expect(claimsWhileBusy).toBe(0);   // 跑 session 时不领第二个
});

test("空闲时周期 claim + runner 心跳", async () => {
  const be = backendWithPending([null, null, null]);
  const p = new RunnerPoller(be, { pollWaitSeconds: 0, heartbeatMs: 5, runSession: async () => {} });
  p.start();
  await new Promise((r) => setTimeout(r, 40));
  p.dispose();
  expect(be.claimCalls).toBeGreaterThan(0);
  expect(be.heartbeats).toBeGreaterThan(0);
});
