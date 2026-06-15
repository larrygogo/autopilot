/**
 * 生命周期 agent 配置（lifecycle: 段）：config.yaml 读写 + clarify 生效配置字段级 merge。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadLifecycleConfig, saveLifecycleAgent } from "../src/core/config";
import { effectiveClarifyConfig } from "../src/daemon/clarifier-agent";

let tmpFile: string;

beforeEach(() => {
  const dir = join(tmpdir(), `autopilot-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpFile = join(dir, "config.yaml");
  writeFileSync(tmpFile, "", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
});
afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (tmpFile && existsSync(tmpFile)) rmSync(join(tmpFile, ".."), { recursive: true, force: true });
});

describe("lifecycle 配置读写", () => {
  it("save → load 往返；reset(null) 删段", () => {
    saveLifecycleAgent("clarify", { provider: "kimi-code", max_turns: 20 });
    expect(loadLifecycleConfig().clarify).toEqual({ provider: "kimi-code", max_turns: 20 });
    saveLifecycleAgent("clarify", null);
    expect(loadLifecycleConfig().clarify).toBeUndefined();
  });

  it("非法 name 抛错", () => {
    expect(() => saveLifecycleAgent("Bad Name!", {})).toThrow(/非法/);
  });

  it("保留其他段（providers 不受影响）", () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    default_model: x\n", "utf-8");
    saveLifecycleAgent("clarify", { provider: "kimi-code" });
    const raw = require("fs").readFileSync(tmpFile, "utf-8");
    expect(raw).toContain("providers:");
    expect(raw).toContain("default_model: x");
    expect(raw).toContain("lifecycle:");
  });
});

describe("effectiveClarifyConfig 字段级 merge", () => {
  it("无配置 → 生效=内置默认（anthropic / 15 / bypassPermissions）", () => {
    const { effective, userConfig } = effectiveClarifyConfig();
    expect(effective.provider).toBe("anthropic");
    expect(effective.max_turns).toBe(15);
    expect(effective.permission_mode).toBe("bypassPermissions");
    expect(typeof effective.system_prompt).toBe("string");
    expect(Object.keys(userConfig).length).toBe(0);
  });

  it("只配 provider → 仅覆盖 provider，其余字段保默认", () => {
    saveLifecycleAgent("clarify", { provider: "kimi-code" });
    const { effective } = effectiveClarifyConfig();
    expect(effective.provider).toBe("kimi-code");
    expect(effective.max_turns).toBe(15);                 // 未覆盖 → 默认
    expect(effective.permission_mode).toBe("bypassPermissions"); // 未覆盖 → 默认
  });

  it("配 system_prompt + max_turns → 覆盖这两项", () => {
    saveLifecycleAgent("clarify", { system_prompt: "自定义澄清提示", max_turns: 8 });
    const { effective } = effectiveClarifyConfig();
    expect(effective.system_prompt).toBe("自定义澄清提示");
    expect(effective.max_turns).toBe(8);
    expect(effective.provider).toBe("anthropic");         // 未覆盖 → 默认
  });
});
