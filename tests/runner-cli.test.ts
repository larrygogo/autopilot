import { test, expect } from "bun:test";
import { Command } from "commander";
import { registerRunnerCommands, renderRunnerStatus } from "../src/cli/runner";

test("registerRunnerCommands：注册 runner 子命令组含 register/start/status/stop/remove", () => {
  const program = new Command();
  registerRunnerCommands(program);
  const runner = program.commands.find((c) => c.name() === "runner");
  expect(runner).toBeDefined();
  const subs = runner!.commands.map((c) => c.name()).sort();
  expect(subs).toEqual(["register", "remove", "start", "status", "stop"]);
});

test("renderRunnerStatus：未注册时给出引导文案", () => {
  expect(renderRunnerStatus(null, false)).toContain("未注册");
});

test("renderRunnerStatus：已注册 + 锁被持有时显示运行中 + runner_id", () => {
  const out = renderRunnerStatus({ control_plane_url: "https://rg", runner_id: "rnr-1", secret: "x" }, true);
  expect(out).toContain("rnr-1");
  expect(out).toContain("https://rg");
  expect(out).toContain("运行中");
});
