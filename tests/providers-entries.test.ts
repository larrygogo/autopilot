/**
 * Provider 条目化（P1）：迁移 047 种子/导入 + core/providers CRUD。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate041 } from "../src/migrations/041-api-keys";
import { up as migrate047 } from "../src/migrations/047-providers-table";
import {
  listProviders,
  getProviderByName,
  getProviderById,
  createProvider,
  updateProvider,
  deleteProvider,
} from "../src/core/providers";

function tmpConfig(content: string | Record<string, unknown>): string {
  const dir = join(tmpdir(), `autopilot-prov-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "config.json");
  const text = typeof content === "string" ? (content || "{}") : JSON.stringify(content, null, 2);
  writeFileSync(f, text, "utf-8");
  return f;
}

describe("providers 迁移种子（空 config）+ CRUD", () => {
  let sqlite: Database;
  let cfgFile: string;

  beforeAll(() => {
    cfgFile = tmpConfig("");
    process.env.DEV_WORKFLOW_CONFIG = cfgFile;
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate041(sqlite);
    migrate047(sqlite);
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    try { rmSync(join(cfgFile, ".."), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("种子三家官方为 cli 条目，name 保持原名、subtype 正确", () => {
    const all = listProviders();
    const byName = Object.fromEntries(all.map((p) => [p.name, p]));
    expect(byName.anthropic?.type).toBe("cli");
    expect(byName.anthropic?.subtype).toBe("claude");
    expect(byName.anthropic?.origin).toBe("seed");
    expect(byName.openai?.subtype).toBe("codex");
    expect(byName.google?.subtype).toBe("gemini");
  });

  it("createProvider / getProviderByName / update / delete", () => {
    const created = createProvider({
      name: "my-deepseek",
      display_name: "我的 DeepSeek",
      type: "api",
      subtype: "openai-compat",
      base_url: "https://api.deepseek.com",
      default_model: "deepseek-chat",
    });
    expect(created.id).toMatch(/^prov-\d+$/);
    expect(getProviderByName("my-deepseek")?.base_url).toBe("https://api.deepseek.com");

    updateProvider(created.id, { default_model: "deepseek-reasoner" });
    expect(getProviderByName("my-deepseek")?.default_model).toBe("deepseek-reasoner");

    deleteProvider(created.id);
    expect(getProviderById(created.id)).toBeNull();
    expect(getProviderByName("my-deepseek")).toBeNull();
  });

  it("拒绝重名与非法名", () => {
    expect(() => createProvider({ name: "anthropic", display_name: "x", type: "cli", subtype: "claude" }))
      .toThrow(/已存在/);
    expect(() => createProvider({ name: "bad name!", display_name: "x", type: "api", subtype: "openai-compat" }))
      .toThrow(/非法/);
  });
});

describe("providers 迁移导入（config 含 mode:api + compat）", () => {
  let sqlite: Database;
  let cfgFile: string;

  beforeAll(() => {
    cfgFile = tmpConfig({
      providers: {
        anthropic: { mode: "api", default_model: "claude-fable-5" },
        deepseek: { base_url: "https://api.deepseek.com" },
      },
    });
    process.env.DEV_WORKFLOW_CONFIG = cfgFile;
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate041(sqlite);
    migrate047(sqlite);
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    try { rmSync(join(cfgFile, ".."), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("config 写了 mode:api 的官方家种成 api 条目（尊重用户选择）", () => {
    const a = getProviderByName("anthropic");
    expect(a?.type).toBe("api");
    expect(a?.subtype).toBe("anthropic");
    expect(a?.default_model).toBe("claude-fable-5");
  });

  it("config 自定义 compat 导入为 api/openai-compat 条目", () => {
    const d = getProviderByName("deepseek");
    expect(d?.type).toBe("api");
    expect(d?.subtype).toBe("openai-compat");
    expect(d?.base_url).toBe("https://api.deepseek.com");
  });
});
