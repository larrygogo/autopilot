import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

let tmpHome: string;
const REPO = process.cwd();

/** init 后把 anthropic cli_status 设 ok（doctor has-enabled 以可用性为准，读 DB cli_status，不 spawn CLI）。 */
function makeAnthropicUsable(home: string): void {
  const db = new Database(join(home, "runtime", "workflow.db"));
  db.run("UPDATE providers SET cli_status = 'ok' WHERE name = 'anthropic'");
  db.close();
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-task-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("task start 前置 doctor", () => {
  it("空 config → 退出码 2 + 提示 fix", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const r = runCli("task", "start", "test-task");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("doctor --fix");
  });

  it("顶层 doctor 别名等同 config doctor", () => {
    runCli("init");
    makeAnthropicUsable(tmpHome); // 有可用 provider → doctor 全过 → exit 0
    const r = runCli("doctor");
    expect(r.exitCode).toBe(0);
  });
});
