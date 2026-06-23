// tests/runner-config-mode.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadRunnerConfig, saveRunnerConfig, loadRunMode } from "../src/core/config";

let home: string, prev: string | undefined;
beforeEach(() => {
  prev = process.env.AUTOPILOT_HOME;
  home = mkdtempSync(join(tmpdir(), "runner-cfg-"));
  process.env.AUTOPILOT_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOPILOT_HOME; else process.env.AUTOPILOT_HOME = prev;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

test("loadRunnerConfig：缺省返回空对象", () => {
  expect(loadRunnerConfig()).toEqual({});
});

test("saveRunnerConfig → loadRunnerConfig 往返，校验类型", () => {
  saveRunnerConfig({ control_plane_url: "https://rg.example", name: "mac-1", poll_wait_seconds: 50, heartbeat_seconds: 30 });
  const c = loadRunnerConfig();
  expect(c.control_plane_url).toBe("https://rg.example");
  expect(c.name).toBe("mac-1");
  expect(c.poll_wait_seconds).toBe(50);
  expect(c.heartbeat_seconds).toBe(30);
});

test("loadRunMode：默认 scheduler；写 mode:runner 后返 runner", () => {
  expect(loadRunMode()).toBe("scheduler");
  writeFileSync(join(home, "config.yaml"), "mode: runner\n");
  expect(loadRunMode()).toBe("runner");
});

test("loadRunMode：非法值回退 scheduler", () => {
  writeFileSync(join(home, "config.yaml"), "mode: nonsense\n");
  expect(loadRunMode()).toBe("scheduler");
});
