import { describe, it, expect } from "bun:test";
import { isSafeGitRef } from "../src/core/workspaces";

// SEC-4: default_branch 流向 git 位置参数（checkout -B <branch> <base>、gh pr create --base <ref>），
// 用户自设 leading-dash 的 default_branch 会被 git 当选项注入。isSafeGitRef 是写入闸。
describe("isSafeGitRef（SEC-4 git 参数注入硬化）", () => {
  it("合法分支名通过（含中文 / feat 命名空间）", () => {
    for (const ref of ["main", "master", "feat/login", "release-1.2", "feature/中文分支", "dev_x"]) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });

  it("leading-dash（参数注入）→ 拒绝", () => {
    expect(isSafeGitRef("--upload-pack=touch x")).toBe(false);
    expect(isSafeGitRef("-x")).toBe(false);
    expect(isSafeGitRef("--force")).toBe(false);
  });

  it("git 保留字符 / 非法格式 → 拒绝", () => {
    expect(isSafeGitRef("")).toBe(false);
    expect(isSafeGitRef("a b")).toBe(false);          // 空格
    expect(isSafeGitRef("a~b")).toBe(false);          // ~
    expect(isSafeGitRef("a..b")).toBe(false);         // ..
    expect(isSafeGitRef("a/")).toBe(false);           // 结尾 /
    expect(isSafeGitRef("/a")).toBe(false);           // 开头 /
    expect(isSafeGitRef("a.lock")).toBe(false);       // .lock 结尾
    expect(isSafeGitRef("a:b")).toBe(false);          // :
    expect(isSafeGitRef("a\\b")).toBe(false);         // 反斜杠
    expect(isSafeGitRef("a?b")).toBe(false);          // ?
    expect(isSafeGitRef("a\x00b")).toBe(false);       // 控制字符
  });
});
