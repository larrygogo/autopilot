import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareDeliverMeta } from "../src/core/sandbox";
import {
  acquireAgentSandbox,
  captureAgentSandbox,
  releaseAgentSandbox,
  cumulativePatchPath,
  purgeAgentRuns,
} from "../src/core/agent-sandbox";
import { AUTOPILOT_HOME } from "../src/index";

// 即焚 sandbox + 累积 patch 是最高 churn 的承重路径（13 commit 大重构），坏了=丢全部代码，
// 却一直零回归网（审计 TC-01/EPH-06）。这里用真实临时 git 仓库跑通整条链，钉死关键不变式。
//
// 测试不重定向 AUTOPILOT_HOME（它是 import 期冻结常量）：改用唯一 taskId，元数据/副本/patch
// 落在当前 home 下该 taskId 的独立子目录，afterEach 清掉，不污染真实 home。源仓库在 tmpdir。

function git(args: string[], cwd: string): void {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${new TextDecoder().decode(p.stderr)}`);
  }
}

function gitOut(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout);
}

let srcRepo: string;
let taskId: string;

beforeEach(() => {
  // 临时源仓库（不在 AUTOPILOT_HOME 下；clone --local 的来源）
  srcRepo = join(tmpdir(), `tc01-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(srcRepo, { recursive: true });
  git(["init", "-q"], srcRepo);
  git(["config", "user.email", "t@t.io"], srcRepo);
  git(["config", "user.name", "t"], srcRepo);
  git(["config", "commit.gpgsign", "false"], srcRepo);
  writeFileSync(join(srcRepo, "README.md"), "base\n", "utf-8");
  git(["add", "-A"], srcRepo);
  git(["commit", "-q", "-m", "base"], srcRepo);
  git(["branch", "-M", "main"], srcRepo);

  taskId = `tc01-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
});

afterEach(() => {
  purgeAgentRuns(taskId);
  try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", taskId), { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(srcRepo, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("agent-sandbox 即焚 + 累积 patch 全链路（TC-01/EPH-06）", () => {
  const ws = () => ({ id: "ws-tc01", path: srcRepo, default_branch: "main" });

  it("acquire → 改文件 → capture 写非空 patch → release 即焚删副本", () => {
    prepareDeliverMeta(taskId, ws(), "feat/tc01");

    const h = acquireAgentSandbox(taskId, "develop", "read-write");
    expect(h).not.toBeNull();
    expect(existsSync(h!.dir)).toBe(true);
    expect(h!.base).toBe("main");
    expect(h!.branch).toBe("feat/tc01");

    writeFileSync(join(h!.dir, "feature.ts"), "export const x = 1;\n", "utf-8");
    const cap = captureAgentSandbox(h!);
    expect(cap.patchWritten).toBe(true);

    const patch = cumulativePatchPath(taskId);
    expect(existsSync(patch)).toBe(true);
    const patchText = readFileSync(patch, "utf-8");
    expect(patchText).toContain("feature.ts");
    expect(patchText.trim().length).toBeGreaterThan(0);

    releaseAgentSandbox(h!);
    expect(existsSync(h!.dir)).toBe(false); // 即焚：副本销毁，代码状态只在 patch
  });

  it("二次 acquire apply 累积 patch 后改动在工作树(unstaged)可见——钉死 apply 进 index 回归(926e1ef)", () => {
    prepareDeliverMeta(taskId, ws(), "feat/tc01");

    // 第一轮：修改已跟踪文件（只有 tracked 改动能区分 staged/unstaged）并产出 patch
    const h1 = acquireAgentSandbox(taskId, "develop", "read-write")!;
    writeFileSync(join(h1.dir, "README.md"), "base\nmodified by phase\n", "utf-8");
    expect(captureAgentSandbox(h1).patchWritten).toBe(true);
    releaseAgentSandbox(h1);

    // 第二轮：干净副本 apply 累积 patch。reset -q 把改动从 index 移回工作树，
    // 故 unstaged `git diff` 必须非空 —— 若回退 reset -q，改动停在 index，此 diff 空，
    // code_review 会误判"变更未实现"反复驳回（dogfood 实测 bug）。
    const h2 = acquireAgentSandbox(taskId, "review", "read-only")!;
    const diff = gitOut(["-C", h2.dir, "diff"], h2.dir);
    expect(diff).toContain("modified by phase");
    releaseAgentSandbox(h2);
  });

  it("read-only phase 不回写 patch（capture no-op）", () => {
    prepareDeliverMeta(taskId, ws(), "feat/tc01");
    const h = acquireAgentSandbox(taskId, "design", "read-only")!;
    writeFileSync(join(h.dir, "scratch.txt"), "不应被 capture\n", "utf-8");
    const cap = captureAgentSandbox(h);
    expect(cap.patchWritten).toBe(false);
    expect(existsSync(cumulativePatchPath(taskId))).toBe(false); // read-only 不产生 patch
    releaseAgentSandbox(h);
  });

  it("无交付元数据（非 git 工作流）→ acquire 返回 null", () => {
    // 不调 prepareDeliverMeta → 无 .worktree.json → 按"无代码沙盒"处理
    expect(acquireAgentSandbox(taskId, "develop", "read-write")).toBeNull();
  });
});
