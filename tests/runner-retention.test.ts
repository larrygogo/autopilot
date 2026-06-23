import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
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

test("cleanupSessionCodebase：删 runtime/requirements/<sessionId>/codebase", () => {
  const cb = join(home, "runtime", "requirements", "sess-9", "codebase", "app");
  mkdirSync(cb, { recursive: true });
  expect(existsSync(cb)).toBe(true);
  cleanupSessionCodebase("sess-9");
  expect(existsSync(join(home, "runtime", "requirements", "sess-9", "codebase"))).toBe(false);
});

test("cleanupSessionCodebase：无目录时 no-op 不抛", () => {
  expect(() => cleanupSessionCodebase("sess-none")).not.toThrow();
});
