import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { listProviderModels, getCatalog } from "../src/agents/model-list";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // 清理每家的 API key env，确保 fallback 到 catalog（避免测试环境真的有 key）
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("listProviderModels fallback → catalog", () => {
  it("无 API key 时直接返回 catalog", async () => {
    for (const name of ["anthropic", "openai", "google"] as const) {
      const r = await listProviderModels(name);
      expect(r.name).toBe(name);
      expect(r.source).toBe("catalog");
      expect(r.models.length).toBeGreaterThan(0);
      // catalog 内容与 getCatalog 一致
      expect(r.models).toEqual(getCatalog(name));
    }
  });

  it("未知 provider 返回空列表 + error", async () => {
    const r = await listProviderModels("unknown" as any);
    expect(r.models).toEqual([]);
    expect(r.error).toContain("未知");
  });
});

describe("catalog 完整性", () => {
  it("三家都有至少 3 个模型", () => {
    expect(getCatalog("anthropic").length).toBeGreaterThanOrEqual(3);
    expect(getCatalog("openai").length).toBeGreaterThanOrEqual(3);
    expect(getCatalog("google").length).toBeGreaterThanOrEqual(3);
  });
});
