import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cleanupSessionCodebase } from "../src/daemon/runner/session-loop";

let home: string, prev: string | undefined;
beforeEach(() => {
  prev = process.env.AUTOPILOT_HOME;
  home = mkdtempSync(join(tmpdir(), "runner-ret-"));
  process.env.AUTOPILOT_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOPILOT_HOME; else process.env.AUTOPILOT_HOME = prev;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

test("cleanupSessionCodebase：整树删 runtime/requirements/<sessionId>/（含 codebase + runs，无 DB 行 = 无浏览价值）", () => {
  const reqRoot = join(home, "runtime", "requirements", "sess-9");
  const cb = join(reqRoot, "codebase", "app");
  // A1 executor 的 bindTaskRunRoot 落在 runs/<rs-sessionId>/——只删 codebase/ 会泄漏这棵子树。
  const runRoot = join(reqRoot, "runs", "rs-sess-9");
  mkdirSync(cb, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "agent-calls.jsonl"), '{"k":"v"}\n');
  expect(existsSync(cb)).toBe(true);
  expect(existsSync(join(runRoot, "agent-calls.jsonl"))).toBe(true);

  cleanupSessionCodebase("sess-9");

  // 整树消失：codebase/、runs/（含 agent-calls.jsonl）、父目录本身都不残留。
  expect(existsSync(join(reqRoot, "codebase"))).toBe(false);
  expect(existsSync(join(reqRoot, "runs"))).toBe(false);
  expect(existsSync(reqRoot)).toBe(false);
});

test("cleanupSessionCodebase：无目录时 no-op 不抛", () => {
  expect(() => cleanupSessionCodebase("sess-none")).not.toThrow();
});
