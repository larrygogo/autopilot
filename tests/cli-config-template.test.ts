import { describe, it, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { buildConfigTemplate } from "../src/cli/config-template";

describe("config-template", () => {
  it("是合法 yaml", () => {
    expect(() => parseYaml(buildConfigTemplate())).not.toThrow();
  });

  it("anthropic 默认启用且填了 default_model", () => {
    const parsed = parseYaml(buildConfigTemplate()) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect((providers.anthropic as Record<string, unknown>).enabled).toBe(true);
    expect((providers.anthropic as Record<string, unknown>).default_model).toBe("claude-sonnet-4-6");
  });

  it("openai / google 段保持注释", () => {
    const txt = buildConfigTemplate();
    const parsed = parseYaml(txt) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect(providers.openai).toBeUndefined();
    expect(providers.google).toBeUndefined();
    expect(txt).toContain("# openai:");
    expect(txt).toContain("# google:");
  });

  it("含 doctor 引导注释", () => {
    expect(buildConfigTemplate()).toContain("bun run dev config doctor");
  });
});
