import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadProviders,
  saveProvider,
  setProviderDefaultModel,
  PROVIDER_NAMES,
  loadGithubConfig,
} from "../src/core/config";

// 这些测试通过 DEV_WORKFLOW_CONFIG 指向临时文件，避免污染 AUTOPILOT_HOME
let tmpFile: string;

beforeEach(() => {
  const dir = join(tmpdir(), `autopilot-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpFile = join(dir, "config.json");
  writeFileSync(tmpFile, "{}", "utf-8");
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

  it("saveProvider 保留 JSON 其他段", () => {
    writeFileSync(tmpFile, JSON.stringify({ agents: { existing: { provider: "openai" } } }, null, 2), "utf-8");
    saveProvider("anthropic", { default_model: "claude-opus-4-7" });
    const content = readFileSync(tmpFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.agents).toBeDefined();
    expect(parsed.agents.existing).toBeDefined();
    expect(parsed.providers.anthropic.default_model).toBe("claude-opus-4-7");
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

describe("setProviderDefaultModel（字段级写默认模型）", () => {
  it("写 compat provider 默认模型 → loadProviders 可读", () => {
    setProviderDefaultModel("deepseek", "deepseek-reasoner");
    expect(loadProviders().deepseek?.default_model).toBe("deepseek-reasoner");
  });

  it("不丢兄弟字段：只改 default_model，base_url / env_key_name 仍在", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({ providers: { mimo: { base_url: "https://api.mimo.ai/v1", env_key_name: "MIMO_API_KEY" } } }, null, 2),
      "utf-8",
    );
    setProviderDefaultModel("mimo", "mimo-large");
    const mimo = loadProviders().mimo as Record<string, unknown>;
    expect(mimo.default_model).toBe("mimo-large");
    expect(mimo.base_url).toBe("https://api.mimo.ai/v1");
    expect(mimo.env_key_name).toBe("MIMO_API_KEY");
  });

  it("空 model 删除 default_model 字段", () => {
    setProviderDefaultModel("deepseek", "deepseek-chat");
    expect(loadProviders().deepseek?.default_model).toBe("deepseek-chat");
    setProviderDefaultModel("deepseek", "");
    expect(loadProviders().deepseek?.default_model).toBeUndefined();
  });

  it("段不存在时自动创建，只含 default_model", () => {
    setProviderDefaultModel("kimi", "moonshot-v1-32k");
    const kimi = loadProviders().kimi as Record<string, unknown>;
    expect(kimi.default_model).toBe("moonshot-v1-32k");
    expect(Object.keys(kimi)).toEqual(["default_model"]);
  });

  it("非法 name 抛错", () => {
    expect(() => setProviderDefaultModel("", "x")).toThrow(/非法 provider/);
    expect(() => setProviderDefaultModel("bad name!", "x")).toThrow(/非法 provider/);
  });
});

describe("github 段读取", () => {
  it("空配置返回默认值", () => {
    const cfg = loadGithubConfig();
    expect(cfg.cli).toBe("gh");
    expect(cfg.poll_interval_seconds).toBe(300);
  });

  it("自定义 cli 和 poll_interval_seconds", () => {
    writeFileSync(tmpFile, JSON.stringify({ github: { cli: "/usr/local/bin/gh", poll_interval_seconds: 60 } }, null, 2), "utf-8");
    const cfg = loadGithubConfig();
    expect(cfg.cli).toBe("/usr/local/bin/gh");
    expect(cfg.poll_interval_seconds).toBe(60);
  });

  it("poll_interval_seconds < 30 走默认值", () => {
    writeFileSync(tmpFile, JSON.stringify({ github: { cli: "gh", poll_interval_seconds: 20 } }, null, 2), "utf-8");
    const cfg = loadGithubConfig();
    expect(cfg.cli).toBe("gh");
    expect(cfg.poll_interval_seconds).toBe(300);
  });

  it("ci_fix_limit / ci_fix_conclusions 缺省", () => {
    const cfg = loadGithubConfig();
    expect(cfg.ci_fix_limit).toBe(2);
    expect(cfg.ci_fix_conclusions).toEqual(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);
  });

  it("ci_fix_limit / ci_fix_conclusions 用户可覆盖（含 0=关闭、结论集大写归一）", () => {
    writeFileSync(tmpFile, JSON.stringify({ github: { ci_fix_limit: 0, ci_fix_conclusions: ["failure", "cancelled"] } }, null, 2), "utf-8");
    const cfg = loadGithubConfig();
    expect(cfg.ci_fix_limit).toBe(0);
    expect(cfg.ci_fix_conclusions).toEqual(["FAILURE", "CANCELLED"]);
  });

  it("非法 ci_fix_limit（负数 / 非整数）走默认 2；空结论集走默认", () => {
    writeFileSync(tmpFile, JSON.stringify({ github: { ci_fix_limit: -1, ci_fix_conclusions: [] } }, null, 2), "utf-8");
    const cfg = loadGithubConfig();
    expect(cfg.ci_fix_limit).toBe(2);
    expect(cfg.ci_fix_conclusions).toEqual(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);
  });
});
