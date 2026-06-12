/**
 * 需求级浅 clone（澄清阶段的只读代码快照）—— Stage 3 全集多库子目录布局。
 * 复用 sandbox 测试的 spawn 子进程模式（AUTOPILOT_HOME env 注入 tmpdir）。
 * clone 失败用不存在的本地路径模拟（git 快速失败，不吃超时）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MODULE = join(import.meta.dir, "..", "src", "core", "requirement-clone").replace(/\\/g, "/");

let tmpHome: string;
let repoA: string;
let repoB: string;

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
  repoA = join(tmpdir(), `${slug}-repo-a`);
  repoB = join(tmpdir(), `${slug}-repo-b`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
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

describe("requirement-clone（全集多库）", () => {
  it("单库：clone 成功进 <alias>/ 子目录 + 幂等复用 + delete 清理", async () => {
    initGitRepo(repoA);
    const out = await runInHome(`
import { ensureRequirementClones, deleteRequirementClone, getRequirementCloneDir } from "${MODULE}";
import { existsSync } from "fs";
const ws = { id: "ws-1", alias: "front", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" };
const r1 = await ensureRequirementClones("req-001", [ws]);
const hasReadme = r1.cloned.length === 1 ? existsSync(r1.cloned[0].path + "/README.md") : false;
const r2 = await ensureRequirementClones("req-001", [ws]);  // 幂等：复用
const deleted = deleteRequirementClone("req-001");
const goneAfter = !existsSync(getRequirementCloneDir("req-001"));
console.log(JSON.stringify({
  clonedDirs: r1.cloned.map((c) => c.dir),
  failed: r1.failed.length,
  rootIsParent: r1.cloned[0]?.path === r1.root + "/" + r1.cloned[0]?.dir
    || r1.cloned[0]?.path === r1.root + "\\\\" + r1.cloned[0]?.dir,
  hasReadme,
  samePath: r1.cloned[0]?.path === r2.cloned[0]?.path,
  deleted, goneAfter,
}));
`);
    const r = JSON.parse(out);
    expect(r.clonedDirs).toEqual(["front"]);
    expect(r.failed).toBe(0);
    expect(r.rootIsParent).toBe(true);
    expect(r.hasReadme).toBe(true);
    expect(r.samePath).toBe(true);
    expect(r.deleted).toBe(true);
    expect(r.goneAfter).toBe(true);
  });

  it("多库：并行 clone 到各自 alias 子目录；非法 alias 回退 ws.id", async () => {
    initGitRepo(repoA);
    initGitRepo(repoB);
    const out = await runInHome(`
import { ensureRequirementClones } from "${MODULE}";
import { existsSync } from "fs";
import { join } from "path";
const list = [
  { id: "ws-1", alias: "front", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" },
  { id: "ws-2", alias: "back", remote_url: ${JSON.stringify(repoB)}, default_branch: "main" },
  { id: "ws-3", alias: "团队 前端", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" },
];
const r = await ensureRequirementClones("req-002", list);
console.log(JSON.stringify({
  clonedDirs: r.cloned.map((c) => c.dir),
  failed: r.failed.length,
  allHaveReadme: r.cloned.every((c) => existsSync(join(c.path, "README.md"))),
}));
`);
    const r = JSON.parse(out);
    expect(r.clonedDirs).toEqual(["front", "back", "ws-3"]); // 中文 alias 净化为空 → 回退 ws.id
    expect(r.failed).toBe(0);
    expect(r.allHaveReadme).toBe(true);
  });

  it("部分失败：好库进子目录、坏库进 failed（不拖垮、无残留）", async () => {
    initGitRepo(repoA);
    const bad = join(tmpdir(), "definitely-not-a-repo-abc");
    const out = await runInHome(`
import { ensureRequirementClones } from "${MODULE}";
import { existsSync } from "fs";
import { join } from "path";
const list = [
  { id: "ws-1", alias: "front", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" },
  { id: "ws-2", alias: "back", remote_url: ${JSON.stringify(bad.replace(/\\/g, "/"))}, default_branch: "main" },
];
const r = await ensureRequirementClones("req-003", list);
console.log(JSON.stringify({
  clonedDirs: r.cloned.map((c) => c.dir),
  failedIds: r.failed.map((w) => w.id),
  goodHasReadme: r.cloned[0] ? existsSync(join(r.cloned[0].path, "README.md")) : false,
  badResidue: existsSync(join(r.root, "back")),
}));
`);
    const r = JSON.parse(out);
    expect(r.clonedDirs).toEqual(["front"]);
    expect(r.failedIds).toEqual(["ws-2"]);
    expect(r.goodHasReadme).toBe(true);
    expect(r.badResidue).toBe(false);
  });

  it("全失败：无远程 + 坏远程 → cloned 空、全进 failed（退化纯文本）", async () => {
    const bad = join(tmpdir(), "definitely-not-a-repo-abc");
    const out = await runInHome(`
import { ensureRequirementClones } from "${MODULE}";
import { existsSync, readdirSync } from "fs";
const list = [
  { id: "ws-1", alias: "front", remote_url: null, default_branch: "main" },
  { id: "ws-2", alias: "back", remote_url: ${JSON.stringify(bad.replace(/\\/g, "/"))}, default_branch: "main" },
];
const r = await ensureRequirementClones("req-004", list);
console.log(JSON.stringify({
  cloned: r.cloned.length,
  failedIds: r.failed.map((w) => w.id),
  subdirResidue: existsSync(r.root) ? readdirSync(r.root).length : 0,
}));
`);
    const r = JSON.parse(out);
    expect(r.cloned).toBe(0);
    expect(r.failedIds).toEqual(["ws-1", "ws-2"]);
    expect(r.subdirResidue).toBe(0);
  });

  it("旧单库平铺布局（workspace/.git 存在）→ 整目录重建为子目录布局", async () => {
    initGitRepo(repoA);
    const out = await runInHome(`
import { ensureRequirementClones, getRequirementCloneDir } from "${MODULE}";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
// 伪造旧平铺布局：root 本身是仓库根
const root = getRequirementCloneDir("req-005");
mkdirSync(join(root, ".git"), { recursive: true });
writeFileSync(join(root, "old-flat-file.txt"), "legacy");
const ws = { id: "ws-1", alias: "front", remote_url: ${JSON.stringify(repoA)}, default_branch: "main" };
const r1 = await ensureRequirementClones("req-005", [ws]);
const r2 = await ensureRequirementClones("req-005", [ws]);  // 重建后幂等
console.log(JSON.stringify({
  flatGitGone: !existsSync(join(root, ".git")),
  flatFileGone: !existsSync(join(root, "old-flat-file.txt")),
  clonedDirs: r1.cloned.map((c) => c.dir),
  hasReadme: r1.cloned[0] ? existsSync(join(r1.cloned[0].path, "README.md")) : false,
  samePath: r1.cloned[0]?.path === r2.cloned[0]?.path,
}));
`);
    const r = JSON.parse(out);
    expect(r.flatGitGone).toBe(true);
    expect(r.flatFileGone).toBe(true);
    expect(r.clonedDirs).toEqual(["front"]);
    expect(r.hasReadme).toBe(true);
    expect(r.samePath).toBe(true);
  });
});
