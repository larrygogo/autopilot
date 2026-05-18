/**
 * api-token 持久化测试。
 *
 * 客户局域网部署时这是核心安全屏障：daemon 启动时 reloadApiToken 优先读
 * env，否则读文件。损坏 / 空文件 / 不存在 / 多次写入要稳定行为。
 *
 * 重构：api-token 内部用 process.env.AUTOPILOT_HOME 优先算路径，让测试
 * 用 tmpdir 隔离不污染真实 ~/.autopilot/runtime/api-token。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadApiToken,
  saveApiToken,
  deleteApiToken,
  generateApiToken,
  previewApiToken,
  getTokenFilePath,
} from "../src/core/api-token";

let tmpHome: string;
let oldHome: string | undefined;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `autopilot-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  oldHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome;
  else delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("getTokenFilePath", () => {
  it("反映当前 AUTOPILOT_HOME 环境变量", () => {
    const p = getTokenFilePath();
    expect(p).toBe(join(tmpHome, "runtime", "api-token"));
  });
});

describe("loadApiToken", () => {
  it("文件不存在 → null", () => {
    expect(loadApiToken()).toBe(null);
  });

  it("正常文件 → 返回 token", () => {
    saveApiToken("hello-world");
    expect(loadApiToken()).toBe("hello-world");
  });

  it("空文件 → null（不是空字符串）", () => {
    const p = getTokenFilePath();
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    writeFileSync(p, "", "utf-8");
    expect(loadApiToken()).toBe(null);
  });

  it("只含空白字符 → null（trim 后空）", () => {
    const p = getTokenFilePath();
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    writeFileSync(p, "   \n\n\t  ", "utf-8");
    expect(loadApiToken()).toBe(null);
  });

  it("token 带尾随换行（编辑器 / curl 写入常见） → trim 后返回", () => {
    const p = getTokenFilePath();
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    writeFileSync(p, "actual-token\n", "utf-8");
    expect(loadApiToken()).toBe("actual-token");
  });
});

describe("saveApiToken", () => {
  it("自动创建 runtime 目录（init 没跑过的场景）", () => {
    expect(existsSync(join(tmpHome, "runtime"))).toBe(false);
    saveApiToken("xyz");
    expect(existsSync(join(tmpHome, "runtime"))).toBe(true);
    expect(readFileSync(getTokenFilePath(), "utf-8")).toBe("xyz");
  });

  it("覆盖已有 token", () => {
    saveApiToken("first");
    saveApiToken("second");
    expect(loadApiToken()).toBe("second");
  });

  it("不在 token 末尾追加换行 / 空白", () => {
    saveApiToken("exact-value");
    expect(readFileSync(getTokenFilePath(), "utf-8")).toBe("exact-value");
  });
});

describe("deleteApiToken", () => {
  it("文件存在 → 删", () => {
    saveApiToken("xxx");
    expect(existsSync(getTokenFilePath())).toBe(true);
    deleteApiToken();
    expect(existsSync(getTokenFilePath())).toBe(false);
  });

  it("文件不存在 → 静默不抛", () => {
    expect(() => deleteApiToken()).not.toThrow();
  });

  it("删后 loadApiToken 返回 null", () => {
    saveApiToken("xxx");
    deleteApiToken();
    expect(loadApiToken()).toBe(null);
  });
});

describe("generateApiToken", () => {
  it("返回长度合理的 base64url 字符串", () => {
    const t = generateApiToken();
    // 32 bytes base64url ≈ 43 字符（无 padding）
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(t.length).toBeLessThanOrEqual(44);
  });

  it("base64url 字符集（只含 A-Z a-z 0-9 - _）", () => {
    const t = generateApiToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("两次调用产生不同 token", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a).not.toBe(b);
  });
});

describe("previewApiToken", () => {
  it("长 token → 前 4 + *** + 后 4", () => {
    expect(previewApiToken("abcdefghijklmnop")).toBe("abcd***mnop");
  });

  it("≤12 字符的 token → 八星号（不泄露任何字符）", () => {
    expect(previewApiToken("short")).toBe("********");
    expect(previewApiToken("123456789012")).toBe("********");
  });

  it("13 字符的 token 走 prefix/suffix 路径（边界）", () => {
    expect(previewApiToken("1234567890123")).toBe("1234***0123");
  });
});

describe("integration", () => {
  it("save → load → delete → load 完整生命周期", () => {
    expect(loadApiToken()).toBe(null);
    const token = generateApiToken();
    saveApiToken(token);
    expect(loadApiToken()).toBe(token);
    deleteApiToken();
    expect(loadApiToken()).toBe(null);
  });

  it("save 后切到不同 AUTOPILOT_HOME，原 token 不会泄漏", () => {
    saveApiToken("home1-token");
    const alt = join(tmpdir(), `autopilot-token-alt-${Date.now()}`);
    mkdirSync(alt, { recursive: true });
    try {
      process.env.AUTOPILOT_HOME = alt;
      expect(loadApiToken()).toBe(null); // 新 home 没有 token
    } finally {
      process.env.AUTOPILOT_HOME = tmpHome; // 恢复给 afterEach 清理
      rmSync(alt, { recursive: true, force: true });
    }
  });
});
