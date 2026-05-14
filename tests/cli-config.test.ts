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
    // 零配置模板下 providers 段缺失，C4 底线仍要求至少一个 enabled provider。
    // 这里手写完整 yaml 以满足 L1 全部检查。
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n",
      "utf-8",
    );
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
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n",
      "utf-8",
    );
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

  it("config show 打印 yaml 原文（零配置模板含 doctor 引导注释）", () => {
    runCli("init");
    const r = runCli("config", "show");
    expect(r.stdout).toContain("bun run dev config doctor");
  });
});

describe("config doctor --fix 交互式", () => {
  it("空 config + 输入选 anthropic + 默认 model + agent name=coder", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const stdin = ["anthropic", "claude-sonnet-4-6", "coder", "anthropic", ""].join("\n") + "\n";

    const r = Bun.spawnSync({
      cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), "config", "doctor", "--fix"],
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);

    const yaml = readFileSync(join(tmpHome, "config.yaml"), "utf-8");
    expect(yaml).toContain("default_model: claude-sonnet-4-6");
    expect(yaml).toMatch(/agents:[\s\S]*coder:[\s\S]*provider:\s*anthropic/);
  });
});
