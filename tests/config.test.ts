import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadProviders,
  saveProvider,
  loadGlobalAgents,
  saveAgent,
  deleteAgent,
  PROVIDER_NAMES,
} from "../src/core/config";

// 这些测试通过 DEV_WORKFLOW_CONFIG 指向临时文件，避免污染 AUTOPILOT_HOME
let tmpFile: string;

beforeEach(() => {
  const dir = join(tmpdir(), `autopilot-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpFile = join(dir, "config.yaml");
  writeFileSync(tmpFile, "", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
});

afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (tmpFile && existsSync(tmpFile)) {
    rmSync(join(tmpFile, ".."), { recursive: true, force: true });
  }
});

describe("providers 段读写", () => {
  it("空配置返回三个空对象", () => {
    const providers = loadProviders();
    for (const name of PROVIDER_NAMES) {
      expect(providers[name]).toEqual({});
    }
  });

  it("saveProvider 写入后 loadProviders 可读", () => {
    saveProvider("anthropic", {
      default_model: "claude-sonnet-4-6",
      api_key_env: "ANTHROPIC_API_KEY",
    });
    const providers = loadProviders();
    expect(providers.anthropic.default_model).toBe("claude-sonnet-4-6");
    expect(providers.anthropic.api_key_env).toBe("ANTHROPIC_API_KEY");
    expect(providers.openai).toEqual({});
  });

  it("saveProvider 保留 YAML 其他段", () => {
    writeFileSync(tmpFile, "agents:\n  existing:\n    provider: openai\n", "utf-8");
    saveProvider("anthropic", { default_model: "claude-opus-4-7" });
    const content = readFileSync(tmpFile, "utf-8");
    expect(content).toContain("agents:");
    expect(content).toContain("existing:");
    expect(content).toContain("anthropic:");
    expect(content).toContain("claude-opus-4-7");
  });

  it("saveProvider 拒绝未知 provider", () => {
    expect(() => saveProvider("unknown" as any, {})).toThrow(/未知 provider/);
  });

  it("saveProvider 过滤空字符串和 undefined", () => {
    saveProvider("anthropic", {
      default_model: "claude-sonnet-4-6",
      enabled: undefined,   // 应被清除
      unknown_field: "",    // 应被清除
    } as any);
    const providers = loadProviders();
    expect(providers.anthropic.default_model).toBe("claude-sonnet-4-6");
    expect(providers.anthropic.enabled).toBeUndefined();
    expect((providers.anthropic as any).unknown_field).toBeUndefined();
  });
});

describe("agents 段读写", () => {
  it("saveAgent 写入后 loadGlobalAgents 可读", () => {
    saveAgent("coder", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      system_prompt: "你是编码助手",
    });
    const agents = loadGlobalAgents();
    expect(agents.coder.provider).toBe("anthropic");
    expect(agents.coder.system_prompt).toBe("你是编码助手");
  });

  it("saveAgent 校验名称", () => {
    expect(() => saveAgent("", { provider: "anthropic" })).toThrow(/非法/);
    expect(() => saveAgent("bad name", { provider: "anthropic" })).toThrow(/非法/);
  });

  it("saveAgent 不把 name 字段写入 YAML（避免与 key 重复）", () => {
    saveAgent("coder", { name: "coder", provider: "anthropic" });
    const content = readFileSync(tmpFile, "utf-8");
    // coder key 出现一次（作为 map key），不会在值里重复写 name: coder
    const matches = content.match(/coder/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("deleteAgent 移除条目并返回 true", () => {
    saveAgent("coder", { provider: "anthropic" });
    saveAgent("reviewer", { provider: "anthropic" });
    expect(deleteAgent("coder")).toBe(true);
    const agents = loadGlobalAgents();
    expect(agents.coder).toBeUndefined();
    expect(agents.reviewer).toBeDefined();
  });

  it("deleteAgent 对不存在的返回 false", () => {
    expect(deleteAgent("nonexistent")).toBe(false);
  });
});
