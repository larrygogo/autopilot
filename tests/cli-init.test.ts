import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function runInit() {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), "init"],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

describe("init 写模板", () => {
  it("首次 init 后 config.yaml 存在且 anthropic 已启用", () => {
    const r = runInit();
    expect(r.exitCode).toBe(0);
    const cfgPath = join(tmpHome, "config.yaml");
    expect(existsSync(cfgPath)).toBe(true);
    expect(readFileSync(cfgPath, "utf-8")).toContain("default_model: claude-sonnet-4-6");
  });

  it("二次 init 不覆盖已有 config.yaml", () => {
    runInit();
    const cfgPath = join(tmpHome, "config.yaml");
    writeFileSync(cfgPath, "providers: {}\n# my edits\n", "utf-8");
    runInit();
    expect(readFileSync(cfgPath, "utf-8")).toContain("my edits");
  });

  it("init 输出包含三个下一步提示", () => {
    const r = runInit();
    expect(r.stdout).toContain("bun run dev config doctor");
    expect(r.stdout).toContain("--fix");
    expect(r.stdout).toContain("dashboard");
  });
});
