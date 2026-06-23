// tests/executor-submit-pr.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGit } from "../src/core/executor/git-ops";
import { produceDiff, submitPrPure } from "../src/core/executor/submit-pr";

let base: string, bare: string, work: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "exec-pr-"));
  bare = join(base, "bare.git"); work = join(base, "work");
  runGit(["init", "--bare", "-b", "main", bare], base);
  runGit(["clone", bare, work], base);
  runGit(["config", "user.email", "t@t"], work); runGit(["config", "user.name", "t"], work);
  writeFileSync(join(work, "a.txt"), "1\n"); runGit(["add", "-A"], work);
  runGit(["commit", "-m", "base"], work); runGit(["push", "-u", "origin", "main"], work);
  runGit(["checkout", "-B", "feat/x"], work);
});
afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

test("produceDiff：dev 阶段只产 diff，不提交、不推送，且不留脏 index", () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  const diff = produceDiff(work, "main");
  expect(diff).toContain("a.txt");
  // 未提交：HEAD 仍是 base，远程无 feat/x
  expect(runGit(["rev-list", "--count", "origin/main..HEAD"], work, false).stdout.trim()).toBe("0");
  expect(runGit(["branch", "-a"], bare).stdout).not.toContain("feat/x");
  // 无副作用：intent-to-add 已 reset，index 中无暂存项
  expect(runGit(["diff", "--cached", "--name-only"], work, false).stdout.trim()).toBe("");
});

test("submitPrPure：commit+push（PR 步骤注入桩），返回纯数据无副作用", async () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  const res = await submitPrPure(
    [{ path: work, remoteUrl: bare, branch: "feat/x", base: "main", primary: true, label: "repo" }],
    { title: "T", bodyFor: () => "B", gitToken: null, openPr: () => `https://github.com/o/r/pull/99` },
  );
  expect(res.failures).toEqual([]);
  expect(res.results).toHaveLength(1);
  expect(res.results[0]!.prUrl).toBe("https://github.com/o/r/pull/99");
  expect(res.results[0]!.prNumber).toBe(99); // 从 /pull/N 提取
  expect(runGit(["branch", "-a"], bare).stdout).toContain("feat/x"); // 已 push
});
