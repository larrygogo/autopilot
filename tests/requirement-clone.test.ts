/**
 * 需求级浅 clone（澄清阶段的只读代码快照）。
 * 复用 sandbox 测试的 spawn 子进程模式（AUTOPILOT_HOME env 注入 tmpdir）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MODULE = join(import.meta.dir, "..", "src", "core", "requirement-clone").replace(/\\/g, "/");

let tmpHome: string;
let repoPath: string;

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# demo repo\n");
  const runs: string[][] = [
    ["git", "-C", path, "init", "-q", "-b", "main"],
    ["git", "-C", path, "config", "user.email", "t@autopilot.local"],
    ["git", "-C", path, "config", "user.name", "T"],
    ["git", "-C", path, "add", "-A"],
    ["git", "-C", path, "commit", "-q", "-m", "init"],
  ];
  for (const argv of runs) {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git 失败 [${argv.join(" ")}]: ${new TextDecoder().decode(r.stderr)}`);
  }
}

beforeEach(() => {
  const slug = `autopilot-rc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), slug);
  repoPath = join(tmpdir(), `${slug}-repo`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
});

afterEach(() => {
  for (const p of [tmpHome, repoPath]) {
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

describe("requirement-clone", () => {
  it("ensure：浅 clone 成功 + 幂等复用 + delete 清理", async () => {
    initGitRepo(repoPath);
    const out = await runInHome(`
import { ensureRequirementClone, deleteRequirementClone, getRequirementCloneDir } from "${MODULE}";
import { existsSync } from "fs";
const ws = { id: "ws-1", remote_url: ${JSON.stringify(repoPath)}, default_branch: "main" };
const dir1 = await ensureRequirementClone("req-001", ws);
const hasReadme = dir1 ? existsSync(dir1 + "/README.md") : false;
const dir2 = await ensureRequirementClone("req-001", ws);  // 幂等：复用
const deleted = deleteRequirementClone("req-001");
const goneAfter = !existsSync(getRequirementCloneDir("req-001"));
console.log(JSON.stringify({ dir1: !!dir1, hasReadme, same: dir1 === dir2, deleted, goneAfter }));
`);
    const r = JSON.parse(out);
    expect(r.dir1).toBe(true);
    expect(r.hasReadme).toBe(true);
    expect(r.same).toBe(true);
    expect(r.deleted).toBe(true);
    expect(r.goneAfter).toBe(true);
  });

  it("无远程 / clone 失败 → null（退化无代码模式，目录不残留）", async () => {
    const bad = join(tmpdir(), "definitely-not-a-repo-abc");
    const out = await runInHome(`
import { ensureRequirementClone, getRequirementCloneDir } from "${MODULE}";
import { existsSync } from "fs";
const noRemote = await ensureRequirementClone("req-002", { id: "ws-1", remote_url: null, default_branch: "main" });
const badClone = await ensureRequirementClone("req-003", { id: "ws-1", remote_url: ${JSON.stringify(bad)}, default_branch: "main" });
console.log(JSON.stringify({
  noRemote, badClone,
  residue: existsSync(getRequirementCloneDir("req-003")),
}));
`);
    const r = JSON.parse(out);
    expect(r.noRemote).toBeNull();
    expect(r.badClone).toBeNull();
    expect(r.residue).toBe(false);
  });
});
