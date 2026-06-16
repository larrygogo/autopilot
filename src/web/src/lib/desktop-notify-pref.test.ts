import { test, expect, beforeEach } from "bun:test";
import { getDesktopNotifyEnabled, setDesktopNotifyEnabled, ensureDesktopNotifyDefault } from "./desktop-notify-pref";

const STORAGE_KEY = "autopilot.desktopNotify.enabled";

// 简易 localStorage mock（测试环境无浏览器 API，通过 globalThis 注入）
class MockStorage {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return key in this.store ? this.store[key] : null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = value;
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

const mockStorage = new MockStorage();
// 注入 globalThis.localStorage，使模块内的 localStorage 全局引用指向 mock
(globalThis as Record<string, unknown>).localStorage = mockStorage;

beforeEach(() => {
  mockStorage.clear();
});

// ── getDesktopNotifyEnabled ──────────────────────────────────────────────────

test("无记录 → 默认返回 true", () => {
  expect(getDesktopNotifyEnabled()).toBe(true);
});

test("记录为 'false' → 返回 false", () => {
  mockStorage.setItem(STORAGE_KEY, "false");
  expect(getDesktopNotifyEnabled()).toBe(false);
});

test("记录为 'true' → 返回 true", () => {
  mockStorage.setItem(STORAGE_KEY, "true");
  expect(getDesktopNotifyEnabled()).toBe(true);
});

// ── setDesktopNotifyEnabled ──────────────────────────────────────────────────

test("setDesktopNotifyEnabled(true) 写入字符串 'true'", () => {
  setDesktopNotifyEnabled(true);
  expect(mockStorage.getItem(STORAGE_KEY)).toBe("true");
});

test("setDesktopNotifyEnabled(false) 写入字符串 'false'", () => {
  setDesktopNotifyEnabled(false);
  expect(mockStorage.getItem(STORAGE_KEY)).toBe("false");
});

// ── ensureDesktopNotifyDefault ───────────────────────────────────────────────

test("ensureDesktopNotifyDefault：无记录时写入 'true' 并返回 true", () => {
  const result = ensureDesktopNotifyDefault();
  expect(result).toBe(true);
  expect(mockStorage.getItem(STORAGE_KEY)).toBe("true");
});

test("ensureDesktopNotifyDefault：已有 'false' 时尊重旧值，不覆盖，返回 false", () => {
  mockStorage.setItem(STORAGE_KEY, "false");
  const result = ensureDesktopNotifyDefault();
  expect(result).toBe(false);
  expect(mockStorage.getItem(STORAGE_KEY)).toBe("false");
});

// ── 异常降级 ─────────────────────────────────────────────────────────────────

test("localStorage 抛 SecurityError 时各函数均降级返回 true", () => {
  const saved = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem() { throw new Error("SecurityError: access denied"); },
    setItem() { throw new Error("SecurityError: access denied"); },
  };

  expect(getDesktopNotifyEnabled()).toBe(true);
  expect(ensureDesktopNotifyDefault()).toBe(true);
  // setDesktopNotifyEnabled 异常时静默忽略，不抛出
  expect(() => setDesktopNotifyEnabled(false)).not.toThrow();

  (globalThis as Record<string, unknown>).localStorage = saved;
});
