import { describe, it, expect } from "bun:test";
import { detectProviderCli, detectAllProviders } from "../src/agents/cli-status";

// CI 环境不一定安装了 claude/codex/gemini。这些测试只断言返回结构
// 与错误处理正确性，不断言具体安装状态。

describe("detectProviderCli", () => {
  it("未知 provider 返回错误", async () => {
    const r = await detectProviderCli("unknown" as any);
    expect(r.cli_installed).toBe(false);
    expect(r.error).toContain("未知");
  });

  it("对每家返回结构完整的结果", async () => {
    for (const name of ["anthropic", "openai", "google"] as const) {
      const r = await detectProviderCli(name);
      expect(r.name).toBe(name);
      expect(typeof r.cli_installed).toBe("boolean");
      // installed → 有 path；not installed → 有 install_hint
      if (r.cli_installed) {
        expect(typeof r.cli_path).toBe("string");
      } else {
        expect(typeof r.install_hint).toBe("string");
      }
    }
  });
});

describe("detectAllProviders", () => {
  it("返回三家的结果", async () => {
    const all = await detectAllProviders();
    expect(Object.keys(all).sort()).toEqual(["anthropic", "google", "openai"]);
  });
});
