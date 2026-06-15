/**
 * 需求级 codebase（v2 R4：代码 clone 归需求所有）—— ensureCodebase 核心语义：
 *   - shallow 幂等复用 / full 幂等命中（fix run 零重 clone）
 *   - 浅→全升级 = 整库删除重 clone（不 --unshallow）
 *   - full 交付分支不匹配 = 删除重 clone（需求级重跑）
 *   - shallow 请求复用既有 full clone（failed 重澄清，带 fidelity/branch 让 prompt 如实声明）
 *   - checkoutExisting 续作 / 远程无分支停默认分支
 *   - 旧 workspace/ 浅 clone 布局删除重建
 *   - deleteRequirementCodebase 全清 / onlyIfNoFull 跳过含 full 的 codebase
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ensureCodebase,
  deleteRequirementCodebase,
  getRequirementCodebaseRoot,
  readCodebaseManifest,
} from "../src/core/sandbox/codebase";

let tmpHome: string;
let prevHome: string | undefined;
let repoA: string;
let reqN = 0;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

function initGitRepo(path: string, featBranch?: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# demo repo\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "t@t.t");
  git(path, "config", "user.name", "t");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "init");
  if (featBranch) git(path, "branch", featBranch);
}

function nextReq(): string {
  reqN += 1;
  return `req-cb-${reqN}`;
}

beforeEach(() => {
  const slug = `autopilot-cb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), slug);
  repoA = join(tmpdir(), `${slug}-repo-a`);
  mkdirSync(tmpHome, { recursive: true });
  prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
  initGitRepo(repoA, "feat/old-run-ab12");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prevHome;
  for (const p of [tmpHome, repoA]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

// file:// URL：本地路径直 clone 会忽略 --depth（git 本地传输优化），file:// 走真传输才有真浅 clone
const fileUrl = (p: string) => "file:///" + p.replace(/\\/g, "/").replace(/^\//, "");
const ws = () => ({ id: "ws-1", alias: "app", remote_url: fileUrl(repoA), default_branch: "main" });

describe("ensureCodebase · shallow（澄清）", () => {
  it("浅 clone 进 codebase/<alias>/，清单落账，幂等复用（标记文件存活）", async () => {
    const reqId = nextReq();
    const r1 = await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    expect(r1.failed.length).toBe(0);
    expect(r1.repos.length).toBe(1);
    expect(r1.repos[0]!.fidelity).toBe("shallow");
    expect(r1.repos[0]!.reused).toBe(false);
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    expect(r1.repos[0]!.path).toBe(dest);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(existsSync(join(dest, ".git", "shallow"))).toBe(true); // 真浅 clone

    const manifest = readCodebaseManifest(reqId);
    expect(manifest?.repos[0]?.fidelity).toBe("shallow");
    expect(manifest?.repos[0]?.ws_id).toBe("ws-1");

    writeFileSync(join(dest, "marker.txt"), "幂等复用不应清我");
    const r2 = await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    expect(r2.repos[0]!.reused).toBe(true);
    expect(existsSync(join(dest, "marker.txt"))).toBe(true);
  });

  it("旧 workspace/ 浅 clone 布局（R4 前澄清快照）→ 删除重建到 codebase/", async () => {
    const reqId = nextReq();
    const legacy = join(tmpHome, "runtime", "requirements", reqId, "workspace", "app");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "old.txt"), "legacy");
    const r = await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    expect(r.failed.length).toBe(0);
    expect(existsSync(join(tmpHome, "runtime", "requirements", reqId, "workspace"))).toBe(false);
    expect(existsSync(join(getRequirementCodebaseRoot(reqId), "app", "README.md"))).toBe(true);
  });

  it("坏远程进 failed、无残留；好库不受拖累（按库降级）", async () => {
    const reqId = nextReq();
    const bad = { id: "ws-2", alias: "bad", remote_url: join(tmpdir(), "definitely-not-a-repo-xyz"), default_branch: "main" };
    const r = await ensureCodebase(reqId, [ws(), bad], { fidelity: "shallow" });
    expect(r.repos.map((c) => c.dir)).toEqual(["app"]);
    expect(r.failed.map((w) => w.id)).toEqual(["ws-2"]);
    expect(existsSync(join(getRequirementCodebaseRoot(reqId), "bad"))).toBe(false);
  });
});

describe("ensureCodebase · full（执行）", () => {
  it("浅→全升级 = 整库删除重 clone（marker 消失、不再 shallow、基于 origin/main 建交付分支）", async () => {
    const reqId = nextReq();
    await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    writeFileSync(join(dest, "marker.txt"), "浅 clone 可能被弄脏——升级必须重 clone");

    const r = await ensureCodebase(reqId, [ws()], { fidelity: "full", deliverBranch: "feat/new-run-cd34" });
    expect(r.failed.length).toBe(0);
    expect(r.repos[0]!.reused).toBe(false);
    expect(existsSync(join(dest, "marker.txt"))).toBe(false);
    expect(existsSync(join(dest, ".git", "shallow"))).toBe(false); // 完整 clone
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/new-run-cd34");
    expect(readCodebaseManifest(reqId)?.repos[0]?.fidelity).toBe("full");
    expect(readCodebaseManifest(reqId)?.repos[0]?.branch).toBe("feat/new-run-cd34");
  });

  it("full 幂等命中（fidelity+分支匹配）= 复用，工作树原地（fix run 零重 clone）", async () => {
    const reqId = nextReq();
    await ensureCodebase(reqId, [ws()], { fidelity: "full", deliverBranch: "feat/run-ef56" });
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    writeFileSync(join(dest, "wip.txt"), "上一轮交付分支工作树——fix run 必须原地复用");

    const r = await ensureCodebase(reqId, [ws()], {
      fidelity: "full", deliverBranch: "feat/run-ef56", checkoutExisting: true,
    });
    expect(r.repos[0]!.reused).toBe(true);
    expect(existsSync(join(dest, "wip.txt"))).toBe(true);
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/run-ef56");
  });

  it("交付分支不匹配 = 删除重 clone（需求级重跑换新分支）", async () => {
    const reqId = nextReq();
    await ensureCodebase(reqId, [ws()], { fidelity: "full", deliverBranch: "feat/round-1" });
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    writeFileSync(join(dest, "stale.txt"), "旧轮残留");

    const r = await ensureCodebase(reqId, [ws()], { fidelity: "full", deliverBranch: "feat/round-2" });
    expect(r.repos[0]!.reused).toBe(false);
    expect(existsSync(join(dest, "stale.txt"))).toBe(false);
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/round-2");
  });

  it("checkoutExisting：远程有交付分支 → 续作 checkout；远程没有 → 停默认分支（只读参考）", async () => {
    const reqId = nextReq();
    const r1 = await ensureCodebase(reqId, [ws()], {
      fidelity: "full", deliverBranch: "feat/old-run-ab12", checkoutExisting: true,
    });
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    expect(r1.failed.length).toBe(0);
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/old-run-ab12");

    const reqId2 = nextReq();
    await ensureCodebase(reqId2, [ws()], {
      fidelity: "full", deliverBranch: "feat/ghost-branch", checkoutExisting: true,
    });
    const dest2 = join(getRequirementCodebaseRoot(reqId2), "app");
    expect(git(dest2, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("缺 deliverBranch 直接抛错（API 误用快速失败）", async () => {
    await expect(ensureCodebase(nextReq(), [ws()], { fidelity: "full" })).rejects.toThrow(/deliverBranch/);
  });
});

describe("ensureCodebase · shallow 复用既有 full（failed 重澄清）", () => {
  it("既有 full clone 不被降级重 clone；返回 fidelity=full + 交付分支供 prompt 声明", async () => {
    const reqId = nextReq();
    await ensureCodebase(reqId, [ws()], { fidelity: "full", deliverBranch: "feat/run-gh78" });
    const dest = join(getRequirementCodebaseRoot(reqId), "app");
    writeFileSync(join(dest, "dirty.txt"), "上一轮执行的脏树——重澄清不静默 reset");

    const r = await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    expect(r.repos[0]!.reused).toBe(true);
    expect(r.repos[0]!.fidelity).toBe("full");
    expect(r.repos[0]!.branch).toBe("feat/run-gh78");
    expect(existsSync(join(dest, "dirty.txt"))).toBe(true);
  });
});

describe("deleteRequirementCodebase", () => {
  it("全清：codebase/ + .codebase.json 一并删除", async () => {
    const reqId = nextReq();
    await ensureCodebase(reqId, [ws()], { fidelity: "shallow" });
    expect(deleteRequirementCodebase(reqId)).toBe(true);
    expect(existsSync(getRequirementCodebaseRoot(reqId))).toBe(false);
    expect(readCodebaseManifest(reqId)).toBeNull();
  });

  it("onlyIfNoFull：纯浅 clone 即清；含 full（未交付改动可能想救回）跳过", async () => {
    const shallowReq = nextReq();
    await ensureCodebase(shallowReq, [ws()], { fidelity: "shallow" });
    expect(deleteRequirementCodebase(shallowReq, { onlyIfNoFull: true })).toBe(true);
    expect(existsSync(getRequirementCodebaseRoot(shallowReq))).toBe(false);

    const fullReq = nextReq();
    await ensureCodebase(fullReq, [ws()], { fidelity: "full", deliverBranch: "feat/keep-me" });
    expect(deleteRequirementCodebase(fullReq, { onlyIfNoFull: true })).toBe(false);
    expect(existsSync(join(getRequirementCodebaseRoot(fullReq), "app", "README.md"))).toBe(true);
    // 不带 onlyIfNoFull 仍可全清（done / 删除需求路径）
    expect(deleteRequirementCodebase(fullReq)).toBe(true);
  });
});

describe("retention 新轨（需求级 codebase）", () => {
  it("终态需求超期被清、非终态永不清；旧任务轨不受影响", async () => {
    const { applyRetentionPolicy } = await import("../src/core/sandbox/retention");
    const { utimesSync } = await import("fs");
    const now = Date.now();
    const old = (now - 30 * 86400 * 1000) / 1000;

    const reqsRoot = join(tmpHome, "runtime", "requirements");
    const seedCb = (reqId: string) => {
      const cb = join(reqsRoot, reqId, "codebase", "app");
      mkdirSync(cb, { recursive: true });
      writeFileSync(join(cb, "data.bin"), Buffer.alloc(1024, 0x42));
      utimesSync(join(reqsRoot, reqId, "codebase"), old, old);
      return join(reqsRoot, reqId, "codebase");
    };
    const doneCb = seedCb("req-done");
    const runCb = seedCb("req-running");
    // 旧任务轨同场扫描
    const taskWs = join(tmpHome, "runtime", "tasks", "tk-old", "workspace");
    mkdirSync(taskWs, { recursive: true });
    writeFileSync(join(taskWs, "data.bin"), Buffer.alloc(1024, 0x42));
    utimesSync(taskWs, old, old);

    const r = applyRetentionPolicy(
      { days: 7 },
      {
        now,
        tasksRoot: join(tmpHome, "runtime", "tasks"),
        requirementsRoot: reqsRoot,
        isTerminal: () => true,
        isRequirementTerminal: (id) => id === "req-done",
      },
    );
    expect(r.removed).toContain("codebase:req-done");
    expect(r.removed).toContain("tk-old");
    expect(existsSync(doneCb)).toBe(false);
    expect(existsSync(runCb)).toBe(true); // 非终态需求 codebase 永不清
  });

  it("不传 isRequirementTerminal → codebase 一律不清（保守默认）", async () => {
    const { applyRetentionPolicy } = await import("../src/core/sandbox/retention");
    const { utimesSync } = await import("fs");
    const now = Date.now();
    const old = (now - 30 * 86400 * 1000) / 1000;
    const reqsRoot = join(tmpHome, "runtime", "requirements");
    const cb = join(reqsRoot, "req-x", "codebase", "app");
    mkdirSync(cb, { recursive: true });
    writeFileSync(join(cb, "data.bin"), Buffer.alloc(64, 0x42));
    utimesSync(join(reqsRoot, "req-x", "codebase"), old, old);

    const r = applyRetentionPolicy(
      { days: 7 },
      { now, tasksRoot: join(tmpHome, "runtime", "tasks"), requirementsRoot: reqsRoot, isTerminal: () => true },
    );
    expect(r.removed).toEqual([]);
    expect(existsSync(cb)).toBe(true);
  });
});
