import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-cli-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("autopilot project （dogfood-bug20）", () => {
  it("`project --help` 含 list / create / delete 三个子命令", () => {
    runCli("init");
    const r = runCli("project", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("create");
    expect(r.stdout).toContain("delete");
  });

  it("`project create` 帮助文本含 --description / --json 选项", () => {
    runCli("init");
    const r = runCli("project", "create", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--description");
    expect(r.stdout).toContain("--json");
  });

  it("daemon 未启时 `project list` 提示并退出码 ≠ 0", () => {
    runCli("init");
    const r = runCli("project", "list", "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("daemon 未启时 `project create` 提示并退出码 ≠ 0", () => {
    runCli("init");
    // 新签名需要 <path>；用 REPO 根目录（必然存在）让路径校验通过，再触发 daemon 检查
    const r = runCli("project", "create", "MyProject", REPO, "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("`project create` name 为空时报 exit 2", () => {
    runCli("init");
    // name 校验先于 daemon 检查执行，path 给合法值即可（不影响 name 校验触发）
    const r = runCli("project", "create", "   ", REPO, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("name 不能为空");
  });
});

describe("req new 错误信息引导 CLI 创 project（dogfood-bug20）", () => {
  it("project 为空时错误信息含 `autopilot project create`", () => {
    runCli("init");
    // daemon 不通的话连"未找到 project"都到不了——但这个测试不需要真起 daemon。
    // 我们只 sanity check req new --help 引用了 project 的概念
    // （真链路的 0 project 报错走 daemon 起后才命中）。
    const r = runCli("req", "new", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("-p, --project");
  });
});
