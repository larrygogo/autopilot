/**
 * 生命周期 agent 配置（lifecycle: 段）：config.json 读写 + clarify 生效配置字段级 merge。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { loadLifecycleConfig, saveLifecycleAgent } from "../src/core/config";
import { effectiveClarifyConfig } from "../src/daemon/clarifier-agent";
import { effectiveFixConfig } from "../src/daemon/fix-revision-runner";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate041 } from "../src/migrations/041-api-keys";
import { up as migrate047 } from "../src/migrations/047-providers-table";

let tmpFile: string;
let sqlite: Database;

beforeEach(() => {
  const dir = join(tmpdir(), `autopilot-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpFile = join(dir, "config.json");
  writeFileSync(tmpFile, "{}", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
  // effective.provider 现在走 resolveDefaultProvider()（读 providers 条目表）。
  // 给一个 seed 三家、无 cli_status 的 DB → 解析确定性返回 anthropic（首个 enabled），
  // 让下面「无配置 → 默认 anthropic」的断言可复现。
  sqlite = new Database(":memory:");
  _setDbForTest(sqlite);
  initDb();
  migrate041(sqlite);
  migrate047(sqlite);
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
    writeFileSync(tmpFile, JSON.stringify({ providers: { anthropic: { default_model: "x" } } }, null, 2), "utf-8");
    saveLifecycleAgent("clarify", { provider: "kimi-code" });
    const parsed = JSON.parse(require("fs").readFileSync(tmpFile, "utf-8"));
    expect(parsed.providers?.anthropic?.default_model).toBe("x");
    expect(parsed.lifecycle?.clarify?.provider).toBe("kimi-code");
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

describe("effectiveFixConfig 字段级 merge（修复轮人设可被 lifecycle.fix 覆盖）", () => {
  it("无配置 → 生效=内置默认（anthropic / 40 / bypassPermissions）", () => {
    const { effective, userConfig } = effectiveFixConfig();
    expect(effective.provider).toBe("anthropic");
    expect(effective.max_turns).toBe(40);
    expect(effective.permission_mode).toBe("bypassPermissions");
    expect(typeof effective.system_prompt).toBe("string");
    expect(Object.keys(userConfig).length).toBe(0);
  });

  it("配 system_prompt → 覆盖修复取向人设，其余保默认（修小而准 → 可改成允许重构）", () => {
    saveLifecycleAgent("fix", { system_prompt: "修 bug 时顺手清理技术债，允许重构" });
    const { effective } = effectiveFixConfig();
    expect(effective.system_prompt).toBe("修 bug 时顺手清理技术债，允许重构");
    expect(effective.provider).toBe("anthropic");   // 未覆盖 → 默认
    expect(effective.max_turns).toBe(40);           // 未覆盖 → 默认
  });
});
