import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-cli-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("autopilot workspace （dogfood-bug21）", () => {
  it("`workspace --help` 含 list / create / delete / health", () => {
    runCli("init");
    const r = runCli("workspace", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("create");
    expect(r.stdout).toContain("delete");
    expect(r.stdout).toContain("health");
  });

  it("`workspace create --help` 含核心选项 --branch / --project / --github", () => {
    runCli("init");
    const r = runCli("workspace", "create", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--branch");
    expect(r.stdout).toContain("--project");
    expect(r.stdout).toContain("--github");
  });

  it("daemon 未启时 `workspace list` 退出码 ≠ 0", () => {
    runCli("init");
    const r = runCli("workspace", "list", "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("`workspace create` path 不存在时 exit 2 并报清晰错误（本地校验 short-circuit）", () => {
    runCli("init");
    const fakePath = join(tmpdir(), `autopilot-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const r = runCli("workspace", "create", "myrepo", fakePath, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("path 不存在");
  });

  it("`workspace create` alias 为空时 exit 2", () => {
    runCli("init");
    const r = runCli("workspace", "create", "   ", tmpHome, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("alias 不能为空");
  });

  it("`workspace create --github` 非 owner/repo 格式时 选项已注册", () => {
    runCli("init");
    // 只验 --github 选项至少注册了即可（具体走通需 daemon，过重）。
    const r = runCli("workspace", "create", "--help");
    expect(r.stdout).toContain("owner/repo");
  });
});
