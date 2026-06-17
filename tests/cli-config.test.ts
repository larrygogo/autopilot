import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

let tmpHome: string;
const REPO = process.cwd();

/**
 * 把 init 后 tmp DB 里的 anthropic 条目 cli_status 设 ok —— doctor 的 has-enabled 以「可用性」为准
 * （读条目表 cli_status，不 spawn CLI）。spawn 的 config doctor 读同一 DB 文件，于是判「有可用」。
 * 不调用则 cli_status=null → 无可用 → error（用于「缺 provider」用例）。
 */
function makeAnthropicUsable(home: string): void {
  const db = new Database(join(home, "runtime", "workflow.db"));
  db.run("UPDATE providers SET cli_status = 'ok' WHERE name = 'anthropic'");
  db.close();
}

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
  it("配置完整（有可用 provider）→ 0", () => {
    runCli("init");
    makeAnthropicUsable(tmpHome); // has-enabled 以可用性为准（cli_status=ok）
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(0);
  });

  it("缺 provider → 1（error）", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const r = runCli("config", "doctor");
    // dogfood-bug17：之前 error → 2 / warning → 1，CI 不友好。改为
    // POSIX 标准约定：error → 1 / warning → 0。
    expect(r.exitCode).toBe(1);
  });

  it("warning 不阻塞 exit (= 0)", () => {
    runCli("init");
    makeAnthropicUsable(tmpHome);
    // has-enabled ok（有可用 provider）；projects 0 行等 warning 不阻塞 → exit 0。
    const r = runCli("config", "doctor");
    expect(r.exitCode).toBe(0);
  });

  it("--json 可解析", () => {
    runCli("init");
    makeAnthropicUsable(tmpHome);
    const r = runCli("config", "doctor", "--json");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.level).toBe(1);
    // status 可能 ok 或 warning（dogfood-bug19 后 init 跑全迁移，projects
    // 表存在但 0 行 → "暂无 project" warning；config 合法所以不会 error）
    expect(["ok", "warning"]).toContain(parsed.status);
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
  it("空 config + 输入选 anthropic + 默认 model（命名 agent 创建已移除）", () => {
    runCli("init");
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    // Phase 3：向导不再创建命名 agent，只配 provider。stdin 只需 provider + model。
    const stdin = ["anthropic", "claude-sonnet-4-6"].join("\n") + "\n";

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
    expect(yaml).toContain("enabled: true");
  });
});
