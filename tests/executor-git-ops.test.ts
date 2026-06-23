// tests/executor-git-ops.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGit, hasChanges, diffStat, pushToRemote, buildGhPrArgs } from "../src/core/executor/git-ops";

let base: string, bare: string, work: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "exec-gitops-"));
  bare = join(base, "bare.git");
  work = join(base, "work");
  runGit(["init", "--bare", "-b", "main", bare], base);
  runGit(["clone", bare, work], base);
  runGit(["config", "user.email", "t@t"], work);
  runGit(["config", "user.name", "t"], work);
  writeFileSync(join(work, "a.txt"), "1\n");
  runGit(["add", "-A"], work);
  runGit(["commit", "-m", "base"], work);
  runGit(["push", "-u", "origin", "main"], work);
});
afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

test("hasChanges：干净树 false，改动后 true", () => {
  expect(hasChanges(work, "main")).toBe(false);
  writeFileSync(join(work, "a.txt"), "2\n");
  expect(hasChanges(work, "main")).toBe(true);
});

test("diffStat：返回非空统计", () => {
  writeFileSync(join(work, "a.txt"), "2\n");
  runGit(["add", "-A"], work); runGit(["commit", "-m", "c"], work);
  expect(diffStat(work, "main")).toContain("a.txt");
});

test("pushToRemote：把交付分支推到远程（file:// 远程, token 走 noop）", () => {
  runGit(["checkout", "-B", "feat/x"], work);
  writeFileSync(join(work, "a.txt"), "2\n");
  runGit(["add", "-A"], work); runGit(["commit", "-m", "c"], work);
  pushToRemote(work, bare, "feat/x", null);            // file:// 远程，token=null
  const branches = runGit(["branch", "-a"], bare).stdout;
  expect(branches).toContain("feat/x");
});

test("pushToRemote：退化态（HEAD 停在 main、无本地 feat/x）应抛错且不推错内容", () => {
  // 模拟 checkout -B feat/x 失败的退化态：工作树仍在 main，本地无 feat/x 分支
  writeFileSync(join(work, "a.txt"), "2\n");
  runGit(["add", "-A"], work); runGit(["commit", "-m", "on-main"], work);
  // 推显式本地分支 refs/heads/feat/x —— 本地不存在 → git push 安全失败
  expect(() => pushToRemote(work, bare, "feat/x", null)).toThrow();
  // 没把 main 的内容静默推上交付分支
  expect(runGit(["branch", "-a"], bare).stdout).not.toContain("feat/x");
});

test("buildGhPrArgs：拼出正确的 gh pr create 参数", () => {
  const args = buildGhPrArgs({ title: "T", body: "B", base: "main", head: "feat/x" });
  expect(args).toEqual(["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--head", "feat/x"]);
});
