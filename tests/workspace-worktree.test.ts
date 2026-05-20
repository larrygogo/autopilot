/**
 * Phase 3 — workspace.git=true → git worktree 模式测试
 *
 * 覆盖：
 *   - codebase 是真实 git 仓库 → worktree add 成功 + 写 .worktree.json
 *   - 同一 taskId 重复时分支冲突 → 附 -2 / -3 后缀
 *   - 非 git 仓库 → warn 退化空目录（不抛错）
 *   - 缺 codebase → 退化空目录
 *   - removeTaskWorktree → git worktree remove + 清 .worktree.json
 *   - deleteTaskWorkspace 自动调 removeTaskWorktree
 *
 * 复用 workspace.test.ts 的 spawn 子进程模式：用 AUTOPILOT_HOME env 注入 tmpdir 避免污染。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const WORKSPACE_MODULE = join(import.meta.dir, "..", "src", "core", "workspace").replace(/\\/g, "/");

let tmpHome: string;
let codebasePath: string;

/** 初始化一个 minimal git 仓库供 worktree 测试用 */
function initGitRepo(path: string, defaultBranch = "main"): void {
  mkdirSync(path, { recursive: true });
  const runs: string[][] = [
    ["git", "-C", path, "init", "-q", "-b", defaultBranch],
    ["git", "-C", path, "config", "user.email", "test@autopilot.local"],
    ["git", "-C", path, "config", "user.name", "Autopilot Test"],
    ["git", "-C", path, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const argv of runs) {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`git init 失败 [${argv.join(" ")}]: ${new TextDecoder().decode(r.stderr)}`);
    }
  }
}

beforeEach(() => {
  const slug = `autopilot-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), slug);
  codebasePath = join(tmpdir(), `${slug}-codebase`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  mkdirSync(join(tmpHome, "runtime", "tasks"), { recursive: true });
  process.env.AUTOPILOT_HOME_OVERRIDE = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (existsSync(codebasePath)) rmSync(codebasePath, { recursive: true, force: true });
});

describe("ensureTaskWorkspace git worktree 模式", () => {
  it("git=true + 真实 git 仓库 → worktree add 成功 + 写 .worktree.json", async () => {
    initGitRepo(codebasePath, "main");

    const script = `
import { ensureTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync } from "fs";
const cfg = { git: true, branch_prefix: "autopilot/" };
const codebase = { id: "cb-1", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
const ws = ensureTaskWorkspace("t-wt-1", "wf", cfg, codebase);
const meta = getTaskWorktreeMeta("t-wt-1");
console.log(JSON.stringify({ ws, exists: existsSync(ws), hasGit: existsSync(ws + "/.git"), meta }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());

    expect(r.exists).toBe(true);
    expect(r.hasGit).toBe(true); // worktree 子目录有 .git 文件指向主 repo
    expect(r.meta).not.toBeNull();
    expect(r.meta.codebase_id).toBe("cb-1");
    expect(r.meta.branch).toBe("autopilot/t-wt-1");
    expect(r.meta.base).toBe("main");
  });

  it("分支已存在时附 -2 后缀", async () => {
    initGitRepo(codebasePath, "main");
    // 在 codebase 里预先建一个同名分支占位
    Bun.spawnSync(["git", "-C", codebasePath, "branch", "autopilot/t-wt-2"], { stdout: "pipe", stderr: "pipe" });

    const script = `
import { ensureTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
const codebase = { id: "cb-1", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
ensureTaskWorkspace("t-wt-2", "wf", { git: true }, codebase);
console.log(JSON.stringify({ meta: getTaskWorktreeMeta("t-wt-2") }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.meta.branch).toBe("autopilot/t-wt-2-2");
  });

  it("codebase 非 git 仓库 → warn 退化空目录（不抛错）", async () => {
    // 不 initGitRepo，让 codebasePath 是个普通目录
    mkdirSync(codebasePath, { recursive: true });

    const script = `
import { ensureTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync, readdirSync } from "fs";
const cfg = { git: true };
const codebase = { id: "cb-non-git", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
const ws = ensureTaskWorkspace("t-wt-3", "wf", cfg, codebase);
console.log(JSON.stringify({
  exists: existsSync(ws),
  empty: readdirSync(ws).length === 0,
  meta: getTaskWorktreeMeta("t-wt-3"),
}));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.exists).toBe(true);
    expect(r.empty).toBe(true);
    expect(r.meta).toBeNull(); // 退化路径不写 worktree 元数据
  });

  it("缺 codebase 参数 → 退化空目录", async () => {
    const script = `
import { ensureTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync, readdirSync } from "fs";
const ws = ensureTaskWorkspace("t-wt-4", "wf", { git: true });
console.log(JSON.stringify({
  exists: existsSync(ws),
  empty: readdirSync(ws).length === 0,
  meta: getTaskWorktreeMeta("t-wt-4"),
}));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.exists).toBe(true);
    expect(r.empty).toBe(true);
    expect(r.meta).toBeNull();
  });

  it("removeTaskWorktree → git worktree remove + 清 .worktree.json", async () => {
    initGitRepo(codebasePath, "main");

    const script = `
import { ensureTaskWorkspace, removeTaskWorktree, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync } from "fs";
const codebase = { id: "cb-1", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
const ws = ensureTaskWorkspace("t-wt-5", "wf", { git: true }, codebase);
const before = getTaskWorktreeMeta("t-wt-5");
const removed = removeTaskWorktree("t-wt-5");
const after = getTaskWorktreeMeta("t-wt-5");
console.log(JSON.stringify({
  before: before?.branch,
  removed,
  after,
  wsExists: existsSync(ws),
}));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.before).toBe("autopilot/t-wt-5");
    expect(r.removed).toBe(true);
    expect(r.after).toBeNull();
    expect(r.wsExists).toBe(false); // git worktree remove 同步清掉了 ws 目录
  });

  it("非 worktree task 的 removeTaskWorktree → no-op 返回 false", async () => {
    const script = `
import { removeTaskWorktree } from "${WORKSPACE_MODULE}";
console.log(JSON.stringify({ removed: removeTaskWorktree("t-no-wt") }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.removed).toBe(false);
  });

  it("deleteTaskWorkspace 自动调 removeTaskWorktree", async () => {
    initGitRepo(codebasePath, "main");

    const script = `
import { ensureTaskWorkspace, deleteTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync } from "fs";
const codebase = { id: "cb-1", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
const ws = ensureTaskWorkspace("t-wt-6", "wf", { git: true }, codebase);
const created = getTaskWorktreeMeta("t-wt-6") !== null;
const deleted = deleteTaskWorkspace("t-wt-6");
const afterMeta = getTaskWorktreeMeta("t-wt-6");
console.log(JSON.stringify({ created, deleted, afterMeta, wsExists: existsSync(ws) }));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.created).toBe(true);
    expect(r.deleted).toBe(true);
    expect(r.afterMeta).toBeNull();
    expect(r.wsExists).toBe(false);
  });

  it("git=true 与 template 同时配置 → 忽略 template + warn", async () => {
    initGitRepo(codebasePath, "main");
    const wfDir = join(tmpHome, "workflows", "wf-mix");
    mkdirSync(join(wfDir, "tpl"), { recursive: true });
    writeFileSync(join(wfDir, "tpl", "README.md"), "# from template");

    const script = `
import { ensureTaskWorkspace, getTaskWorktreeMeta } from "${WORKSPACE_MODULE}";
import { existsSync } from "fs";
import { join } from "path";
const cfg = { git: true, template: "tpl" };
const codebase = { id: "cb-1", path: ${JSON.stringify(codebasePath)}, default_branch: "main" };
const ws = ensureTaskWorkspace("t-wt-7", "wf-mix", cfg, codebase);
console.log(JSON.stringify({
  meta: getTaskWorktreeMeta("t-wt-7"),
  // template 应被忽略，所以 README.md 不存在
  hasReadme: existsSync(join(ws, "README.md")),
}));
`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const r = JSON.parse(out.trim());
    expect(r.meta).not.toBeNull(); // worktree 成功
    expect(r.hasReadme).toBe(false); // template 被忽略
  });
});
