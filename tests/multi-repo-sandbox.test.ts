/**
 * 多代码库沙盒（Phase 2：多库可写、各自交付）。
 *
 * 覆盖：
 *   - 集合 >1 → workspace/<alias>/ 子目录各自 clone + .worktree.json v2（mode=multi-clone）
 *   - 顶层字段镜像主库（旧 reader 兼容）
 *   - listTaskRepos：多库展开 / 单库单项指向根 / 无 meta 返回 []
 *   - 单库（单元素数组）走原路径：meta mode=clone、无 repos 字段（存量 byte 级兼容）
 *   - 任一库 clone 失败 → 整体退化空目录（不留半套布局）
 *
 * 复用 sandbox-worktree.test.ts 的 spawn 子进程模式（AUTOPILOT_HOME env 注入 tmpdir）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SANDBOX_MODULE = join(import.meta.dir, "..", "src", "core", "sandbox").replace(/\\/g, "/");

let tmpHome: string;
let repoA: string;
let repoB: string;

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
  const slug = `autopilot-mr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), slug);
  repoA = join(tmpdir(), `${slug}-a`);
  repoB = join(tmpdir(), `${slug}-b`);
  mkdirSync(join(tmpHome, "runtime", "tasks"), { recursive: true });
});

afterEach(() => {
  for (const p of [tmpHome, repoA, repoB]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

async function runInHome(script: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
  });
  await proc.exited;
  const err = await new Response(proc.stderr).text();
  const out = await new Response(proc.stdout).text();
  if (!out.trim()) throw new Error(`子进程无输出，stderr: ${err.slice(0, 500)}`);
  return out.trim();
}

describe("多代码库沙盒", () => {
  it("集合 >1 → 子目录各自 clone + v2 meta + listTaskRepos 展开", async () => {
    initGitRepo(repoA, "main");
    initGitRepo(repoB, "main");
    const out = await runInHome(`
import { ensureTaskSandbox, getTaskWorktreeMeta, listTaskRepos } from "${SANDBOX_MODULE}";
import { existsSync } from "fs";
const cfg = { git: true };
const refs = [
  { id: "ws-001", alias: "backend", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" },
  { id: "ws-002", alias: "frontend", remote_url: ${JSON.stringify(repoB)}, default_branch: "main" },
];
const ws = ensureTaskSandbox("t-mr-1", "wf", cfg, refs, "feat/demo-t-mr-1");
const meta = getTaskWorktreeMeta("t-mr-1");
const repos = listTaskRepos("t-mr-1");
console.log(JSON.stringify({
  backendGit: existsSync(ws + "/backend/.git"),
  frontendGit: existsSync(ws + "/frontend/.git"),
  meta, repos,
}));
`);
    const r = JSON.parse(out);
    expect(r.backendGit).toBe(true);
    expect(r.frontendGit).toBe(true);
    expect(r.meta.mode).toBe("multi-clone");
    expect(r.meta.repos.length).toBe(2);
    // 顶层镜像主库（旧 reader 兼容）
    expect(r.meta.workspace_id).toBe("ws-001");
    expect(r.meta.branch).toBe("feat/demo-t-mr-1");
    expect(r.meta.repos[0].primary).toBe(true);
    // listTaskRepos 展开
    expect(r.repos.length).toBe(2);
    expect(r.repos[0].alias).toBe("backend");
    expect(r.repos[0].primary).toBe(true);
    expect(r.repos[0].dir).toBe("backend");
    expect(r.repos[1].dir).toBe("frontend");
    expect(r.repos[0].path.replace(/\\/g, "/").endsWith("workspace/backend")).toBe(true);
  });

  it("单库（单元素数组）→ 原路径：mode=clone、无 repos 字段（存量兼容）；listTaskRepos 单项指向根", async () => {
    initGitRepo(repoA, "main");
    const out = await runInHome(`
import { ensureTaskSandbox, listTaskRepos } from "${SANDBOX_MODULE}";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
const cfg = { git: true };
const refs = [{ id: "ws-001", alias: "solo", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" }];
const ws = ensureTaskSandbox("t-mr-2", "wf", cfg, refs, "feat/demo-t-mr-2");
const rawMeta = JSON.parse(readFileSync(join(ws, "..", ".worktree.json"), "utf8"));
const repos = listTaskRepos("t-mr-2");
console.log(JSON.stringify({ rootGit: existsSync(ws + "/.git"), rawMeta, repos }));
`);
    const r = JSON.parse(out);
    expect(r.rootGit).toBe(true);
    expect(r.rawMeta.mode).toBe("clone");
    expect("repos" in r.rawMeta).toBe(false); // 单库不写 repos —— 与存量文件 byte 级兼容
    expect(r.repos.length).toBe(1);
    expect(r.repos[0].dir).toBe("");
    expect(r.repos[0].primary).toBe(true);
    expect(r.repos[0].path.replace(/\\/g, "/").endsWith("/workspace")).toBe(true);
  });

  it("任一库 clone 失败 → 整体退化空目录，不留半套布局", async () => {
    initGitRepo(repoA, "main");
    const badRemote = join(tmpdir(), "definitely-not-a-repo-xyz");
    const out = await runInHome(`
import { ensureTaskSandbox, getTaskWorktreeMeta } from "${SANDBOX_MODULE}";
import { existsSync, readdirSync } from "fs";
const cfg = { git: true };
const refs = [
  { id: "ws-001", alias: "good", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" },
  { id: "ws-002", alias: "bad", remote_url: ${JSON.stringify(badRemote)}, default_branch: "main" },
];
const ws = ensureTaskSandbox("t-mr-3", "wf", cfg, refs, "feat/demo-t-mr-3");
console.log(JSON.stringify({
  entries: existsSync(ws) ? readdirSync(ws) : null,
  meta: getTaskWorktreeMeta("t-mr-3"),
}));
`);
    const r = JSON.parse(out);
    expect(r.entries).toEqual([]); // 空目录退化
    expect(r.meta).toBeNull();     // 不写 meta（半套布局比空目录更危险）
  });
});
