import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
let tmpPath: string;
const REPO = process.cwd();

beforeEach(() => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `autopilot-proj-ws-${suffix}`);
  tmpPath = join(tmpdir(), `test-ws-dir-${suffix}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  mkdirSync(tmpPath, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (existsSync(tmpPath)) rmSync(tmpPath, { recursive: true, force: true });
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

describe("project create <name> <path> 新签名", () => {
  it("帮助文本含 <path>、--alias、--description、--json", () => {
    runCli("init");
    const r = runCli("project", "create", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("<path>");
    expect(r.stdout).toContain("--alias");
    expect(r.stdout).toContain("--description");
    expect(r.stdout).toContain("--json");
  });

  it("路径不存在时 exit 2，stderr 含「路径不存在」（不需要 daemon）", () => {
    runCli("init");
    const r = runCli(
      "project", "create", "MyProject",
      "/tmp/this-absolutely-does-not-exist-xyz-999",
      "--port", "19999",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("路径不存在");
    // 路径校验在 daemon 检查之前，因此不会出现 daemon 错误
    expect(r.stderr).not.toContain("daemon");
  });

  it("name 为空时 exit 2，stderr 含「name 不能为空」", () => {
    runCli("init");
    const r = runCli("project", "create", "   ", tmpPath, "--port", "19999");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("name 不能为空");
  });

  it("路径存在且 name 合法 → 路径校验通过 → 尝试连 daemon（daemon 未起则报 daemon 错）", () => {
    runCli("init");
    const r = runCli("project", "create", "MyProject", tmpPath, "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("路径不存在的 exit 2 优先于 daemon 连接检查", () => {
    runCli("init");
    const r = runCli(
      "project", "create", "MyProject",
      "/tmp/not-a-real-dir-xyz",
      "--port", "19999",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("路径不存在");
    expect(r.stderr).not.toContain("daemon");
  });
});
