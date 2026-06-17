/**
 * resolveDefaultProvider —— 系统默认 provider 解析的 fallback 链。
 * 取代散落写死的 anthropic：显式默认 → 唯一已配 → 首个 CLI 就绪 → 首个 enabled → 终极兜底。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate041 } from "../src/migrations/041-api-keys";
import { up as migrate047 } from "../src/migrations/047-providers-table";
import { getProviderByName, updateProvider, setProviderCliStatus } from "../src/core/providers";
import {
  resolveDefaultProvider,
  FALLBACK_PROVIDER,
  isProviderUsable,
  listUsableProviders,
  hasUsableProvider,
  ensureDefaultProviderSet,
} from "../src/core/default-provider";
import { loadDefaultProviderName, setDefaultProviderName } from "../src/core/config";

let sqlite: Database;
let cfgDir: string;

beforeEach(() => {
  cfgDir = join(tmpdir(), `autopilot-defprov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.yaml"), "", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = join(cfgDir, "config.yaml");
  sqlite = new Database(":memory:");
  _setDbForTest(sqlite);
  initDb();
  migrate041(sqlite);
  migrate047(sqlite); // seed anthropic/openai/google 为 cli 条目
});
afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("resolveDefaultProvider fallback 链", () => {
  it("seed 三家、无 cli_status、无显式默认 → 首个 enabled = anthropic（与旧硬编码一致，存量零变化）", () => {
    expect(resolveDefaultProvider()).toBe("anthropic");
  });

  it("某 cli 条目 cli_status=ok → 首个就绪者胜出（这正是「跟随我实际可用 provider」的新行为）", () => {
    setProviderCliStatus(getProviderByName("openai")!.id, "ok");
    expect(resolveDefaultProvider()).toBe("openai");
  });

  it("多个就绪 → 优先已就绪的 claude（anthropic），即便它 created_at 不是最早", () => {
    setProviderCliStatus(getProviderByName("openai")!.id, "ok");
    setProviderCliStatus(getProviderByName("anthropic")!.id, "ok");
    expect(resolveDefaultProvider()).toBe("anthropic"); // claude 偏好，不取 created_at 最早的 openai
  });

  it("无 claude 就绪 → 退到首个就绪 cli", () => {
    setProviderCliStatus(getProviderByName("openai")!.id, "ok");
    setProviderCliStatus(getProviderByName("google")!.id, "ok");
    // anthropic 未就绪 → 取首个就绪 cli（created_at 最早 = openai 或 google，按 seed 顺序）
    expect(["openai", "google"]).toContain(resolveDefaultProvider());
  });

  it("显式默认（config providers.default）优先于派生", () => {
    setProviderCliStatus(getProviderByName("openai")!.id, "ok"); // 派生本会选 openai
    setDefaultProviderName("google");
    expect(loadDefaultProviderName()).toBe("google");
    expect(resolveDefaultProvider()).toBe("google");
  });

  it("显式默认指向 disabled 条目 → 跳过、降级派生（陈旧指针不卡死）", () => {
    updateProvider(getProviderByName("google")!.id, { enabled: false });
    setDefaultProviderName("google");
    expect(resolveDefaultProvider()).toBe("anthropic"); // google 跳过 → 首个 enabled
  });

  it("显式默认指向 typo/不存在 → 跳过、降级派生", () => {
    setDefaultProviderName("nonexistent-xyz");
    expect(resolveDefaultProvider()).toBe("anthropic");
  });

  it("唯一 enabled 条目 → 直接用它", () => {
    updateProvider(getProviderByName("anthropic")!.id, { enabled: false });
    updateProvider(getProviderByName("google")!.id, { enabled: false });
    expect(resolveDefaultProvider()).toBe("openai");
  });

  it("全部 disabled → 终极兜底常量 FALLBACK_PROVIDER", () => {
    for (const n of ["anthropic", "openai", "google"]) {
      updateProvider(getProviderByName(n)!.id, { enabled: false });
    }
    expect(resolveDefaultProvider()).toBe(FALLBACK_PROVIDER);
  });

  it("setDefaultProviderName('') 删键 → 回退派生", () => {
    setDefaultProviderName("google");
    expect(loadDefaultProviderName()).toBe("google");
    setDefaultProviderName(undefined);
    expect(loadDefaultProviderName()).toBeUndefined();
  });
});

describe("可用性判定 + 自动设默认（P1）", () => {
  it("isProviderUsable：cli cli_status=ok → true；未就绪 / disabled → false", async () => {
    const a = getProviderByName("anthropic")!;
    expect(await isProviderUsable(a)).toBe(false); // 无 cli_status
    setProviderCliStatus(a.id, "ok");
    expect(await isProviderUsable(getProviderByName("anthropic")!)).toBe(true);
    updateProvider(a.id, { enabled: false });
    expect(await isProviderUsable(getProviderByName("anthropic")!)).toBe(false); // disabled
  });

  it("hasUsableProvider / listUsableProviders 只数 cli 已就绪", async () => {
    expect(await hasUsableProvider()).toBe(false); // 三家 cli 都无 status
    setProviderCliStatus(getProviderByName("openai")!.id, "ok");
    expect((await listUsableProviders()).map((p) => p.name)).toEqual(["openai"]);
    expect(await hasUsableProvider()).toBe(true);
  });

  it("ensureDefaultProviderSet：无显式默认 + 有可用 → 设第一个可用", async () => {
    setProviderCliStatus(getProviderByName("google")!.id, "ok");
    expect(await ensureDefaultProviderSet()).toBe("google");
    expect(loadDefaultProviderName()).toBe("google");
  });

  it("ensureDefaultProviderSet：已显式默认 → 不覆盖用户选择", async () => {
    setDefaultProviderName("openai");
    setProviderCliStatus(getProviderByName("google")!.id, "ok");
    expect(await ensureDefaultProviderSet()).toBe("openai");
  });

  it("ensureDefaultProviderSet：无可用 → null，不写默认", async () => {
    expect(await ensureDefaultProviderSet()).toBeNull();
    expect(loadDefaultProviderName()).toBeUndefined();
  });

  it("ensureDefaultProviderSet：多个可用 + 无显式默认 → 不自动 pin（交给派生，不强写 config）", async () => {
    setProviderCliStatus(getProviderByName("anthropic")!.id, "ok");
    setProviderCliStatus(getProviderByName("openai")!.id, "ok");
    expect(await ensureDefaultProviderSet()).toBeNull();
    expect(loadDefaultProviderName()).toBeUndefined(); // 没强写
    expect(resolveDefaultProvider()).toBe("anthropic"); // 派生 = 首个就绪 cli
  });
});
