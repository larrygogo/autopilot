import { describe, it, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { buildConfigTemplate } from "../src/cli/config-template";

describe("config-template（零配置模板）", () => {
  it("是合法 yaml", () => {
    expect(() => parseYaml(buildConfigTemplate())).not.toThrow();
  });

  it("解析后 providers / agents 都不存在（全是注释）", () => {
    const parsed = parseYaml(buildConfigTemplate()) as Record<string, unknown> | null;
    // 全注释 yaml 解析结果应为 null 或空对象
    if (parsed) {
      expect(parsed.providers).toBeUndefined();
      expect(parsed.agents).toBeUndefined();
    }
  });

  it("注释里给出 override 示例（providers / agents）", () => {
    const txt = buildConfigTemplate();
    expect(txt).toContain("# providers:");
    expect(txt).toContain("# agents:");
  });

  it("含 doctor 引导注释", () => {
    expect(buildConfigTemplate()).toContain("bun run dev config doctor");
  });

  it("说明零配置语义", () => {
    expect(buildConfigTemplate()).toContain("零配置");
  });
});
