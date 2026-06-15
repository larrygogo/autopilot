import { describe, it, expect } from "bun:test";
import { probeRemote, buildAuthUrl } from "../src/core/sandbox/workspace-health";

describe("buildAuthUrl", () => {
  it("HTTPS URL 注入 token（纯字母数字 token 无需编码）", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", "mytoken");
    // 纯字母数字 token encodeURIComponent 后不变
    expect(url).toBe("https://oauth2:mytoken@github.com/owner/repo.git");
  });

  it("SSH URL 原样返回（不注入 token）", () => {
    const url = buildAuthUrl("git@github.com:owner/repo.git", "mytoken");
    expect(url).toBe("git@github.com:owner/repo.git");
  });

  it("token 为 null 时原样返回", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", null);
    expect(url).toBe("https://github.com/owner/repo.git");
  });

  it("token 为空字符串时原样返回", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", "  ");
    expect(url).toBe("https://github.com/owner/repo.git");
  });

  it("token 含特殊字符（@/:）时 URL 编码，防止 URL 畸形", () => {
    const url = buildAuthUrl("https://github.com/owner/repo.git", "abc@def:ghi/jkl");
    // @ → %40, : → %3A, / → %2F
    expect(url).toBe("https://oauth2:abc%40def%3Aghi%2Fjkl@github.com/owner/repo.git");
    // 确保只有一个 @（在 oauth2:...@ 处）
    const atCount = (url.match(/@/g) || []).length;
    expect(atCount).toBe(1);
  });

  it("已含 userinfo 的 URL 会被双重注入（调用方需保证传干净 URL）", () => {
    // buildAuthUrl 做纯前缀替换，不检查已有 userinfo —— 调用方（probeRemote/tryCreateClone）
    // 负责确保传入不含凭据的干净 URL（由 redactRemoteUrl 保证）
    const url = buildAuthUrl("https://old-user@github.com/owner/repo.git", "tok");
    // 注入后变成 https://oauth2:tok@old-user@github.com/...（语义明确：调用方 bug）
    expect(url).toContain("oauth2:");
  });
});

describe("probeRemote · 空/非法输入", () => {
  it("空 URL 返回 ok=false", () => {
    const r = probeRemote("");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("纯空白 URL 返回 ok=false", () => {
    const r = probeRemote("   ");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("非法域名 URL 返回 ok=false", () => {
    // git ls-remote 会失败（DNS 解析失败 / ENOTFOUND）
    const r = probeRemote("https://this-domain-does-not-exist-xyz123.invalid/x/y");
    expect(r.ok).toBe(false);
    expect(r.defaultBranch).toBeNull();
  });
});
