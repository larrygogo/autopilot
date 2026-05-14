import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-cli-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("config doctor 退出码", () => {
  it("配置完整 → 0", () => {
    runCli("init");
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(0);
  });

  it("缺 provider → 2", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(2);
  });

  it("--json 可解析", () => {
    runCli("init");
    const r = runCli("config", "doctor", "--json");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.level).toBe(1);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe("config path / show", () => {
  it("config path 打印绝对路径", () => {
    runCli("init");
    const r = runCli("config", "path");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(join(tmpHome, "config.yaml"));
  });

  it("config show 打印 yaml 原文", () => {
    runCli("init");
    const r = runCli("config", "show");
    expect(r.stdout).toContain("default_model: claude-sonnet-4-6");
  });
});
