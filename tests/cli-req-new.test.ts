import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-req-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("autopilot req new", () => {
  it("daemon 未启时提示并退出码 ≠ 0", () => {
    runCli("init");
    // 用一个肯定不在监听的端口，保证 daemon 连接失败
    const r = runCli("req", "new", "--from-prompt", "test", "--port", "19999");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("daemon");
  });

  it("帮助文本含 --from-prompt / -f / --no-extract", () => {
    runCli("init");
    const r = runCli("req", "new", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--from-prompt");
    expect(r.stdout).toContain("-f");
    expect(r.stdout).toContain("--no-extract");
  });
});

import { inferWorkspaceFromCwd } from "../src/cli/requirements-cli";
import type { Workspace } from "../src/core/workspaces";

const mkCb = (id: string, path: string): Workspace => ({
  id, path, remote_url: null, project_id: "p", alias: "a",
  default_branch: "main", github_owner: null, github_repo: null,
  parent_workspace_id: null, submodule_path: null,
  created_at: 0, updated_at: 0,
});

describe("inferWorkspaceFromCwd", () => {
  it("cwd 在嵌套 codebase 里选最长 match", () => {
    const cbs = [mkCb("cb-1", "/home/u/proj"), mkCb("cb-2", "/home/u/proj/sub")];
    expect(inferWorkspaceFromCwd(cbs, "/home/u/proj/sub/x")).toBe("cb-2");
  });

  it("cwd 不匹配任何 codebase 返回 null", () => {
    const cbs = [mkCb("cb-1", "/home/u/proj")];
    expect(inferWorkspaceFromCwd(cbs, "/var/other")).toBeNull();
  });

  it("无 codebase 返回 null", () => {
    expect(inferWorkspaceFromCwd([], "/anywhere")).toBeNull();
  });
});
