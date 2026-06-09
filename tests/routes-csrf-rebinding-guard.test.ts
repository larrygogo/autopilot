import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { authResolve, reloadApiToken } from "../src/daemon/routes";

/**
 * loopback 豁免的 CSRF / DNS rebinding 闸（审计 H1）。
 *
 * 背景：authResolve 对「socket peer IP 是 loopback」的请求免鉴权——这本意是放行
 * 本机 CLI/TUI/浏览器。但浏览器恶意页面可借本机 socket 越权：
 *   - 跨源 WebSocket：evil.com 页面 `new WebSocket("ws://127.0.0.1:6180/ws")`，
 *     WS 无 same-origin 限制，socket 真是 127.0.0.1 → 旧逻辑直接豁免 → 可跑 RPC（写工作流=RCE）。
 *   - DNS rebinding：evil.com 解析到 127.0.0.1，页面 fetch 到自身源 → Host=evil.com，
 *     socket 仍是 loopback → 旧逻辑豁免。
 *
 * 防御：loopback 豁免叠加来源校验——浏览器自动设置的 Origin/Host（攻击 JS 改不了）若
 * 暴露外部域则不豁免。非浏览器客户端（无 Origin、Host 为本机）不受影响。
 */

function fakeServer(address: string): import("bun").Server<undefined> {
  return {
    requestIP: () => ({ address, port: 0, family: address.includes(":") ? "IPv6" : "IPv4" }),
  } as unknown as import("bun").Server<undefined>;
}
const loopback = fakeServer("127.0.0.1");

function req(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:6180/api/tasks", { method: "POST", headers });
}

describe("loopback 豁免的 CSRF / DNS rebinding 闸", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    delete process.env.AUTOPILOT_API_TOKEN;
    reloadApiToken(); // 零配置：无 token、无用户（users 表空）
  });

  // ── 合法来源：必须继续放行（不能误伤）──
  it("CLI/TUI：loopback + 无 Origin → 放行", async () => {
    expect(await authResolve(req({ host: "127.0.0.1:6180" }), loopback)).toBe(true);
  });

  it("CLI/TUI 极简：loopback + 既无 Host 又无 Origin → 放行", async () => {
    expect(await authResolve(req({}), loopback)).toBe(true);
  });

  it("本机 Web UI：loopback + 同源 Origin(127.0.0.1) → 放行", async () => {
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "http://127.0.0.1:6180" }), loopback),
    ).toBe(true);
  });

  it("本机 Web UI：loopback + 同源 Origin(localhost) → 放行", async () => {
    expect(
      await authResolve(req({ host: "localhost:6180", origin: "http://localhost:6180" }), loopback),
    ).toBe(true);
  });

  it("本机 Web UI：IPv6 loopback + 同源 Origin(http://[::1]) → 放行（FP-IPv6 回归）", async () => {
    const ipv6Loopback = fakeServer("::1");
    expect(
      await authResolve(req({ host: "[::1]:6180", origin: "http://[::1]:6180" }), ipv6Loopback),
    ).toBe(true);
  });

  // ── 攻击来源：必须拒绝 ──
  it("跨源 WS 攻击：loopback socket + 外部 Origin → 拒绝", async () => {
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "http://evil.com" }), loopback),
    ).toBe(false);
  });

  it("DNS rebinding（GET 无 Origin）：loopback socket + 外部 Host → 拒绝", async () => {
    expect(await authResolve(req({ host: "evil.com:6180" }), loopback)).toBe(false);
  });

  it("DNS rebinding（POST）：外部 Host + 外部 Origin → 拒绝", async () => {
    expect(
      await authResolve(req({ host: "evil.com:6180", origin: "http://evil.com:6180" }), loopback),
    ).toBe(false);
  });

  it("零配置下也不被放行短路：loopback + 外部 Host → 拒绝", async () => {
    // 无 token 无 user 时旧逻辑会在「零配置放行」分支返回 true，新闸须先拦下。
    expect(await authResolve(req({ host: "attacker.example:6180" }), loopback)).toBe(false);
  });

  it("畸形 Origin → 拒绝（保守）", async () => {
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "not-a-url" }), loopback),
    ).toBe(false);
  });

  // BYPASS-1（对抗复核）：本机判定不能把「以 127. 开头的域名」当成 loopback。
  // 攻击者注册 127.0.0.1.evil.com / 127.evil.com 子域，hostname 以 "127." 起头但
  // 是外部域，绝不能被判可信。
  it("子域绕过：127.x.evil.com 形态的 Host → 拒绝", async () => {
    expect(await authResolve(req({ host: "127.0.0.1.evil.com:6180" }), loopback)).toBe(false);
    expect(await authResolve(req({ host: "127.evil.com:6180" }), loopback)).toBe(false);
  });

  it("子域绕过：127.x.evil.com 形态的 Origin（跨源 WS/POST）→ 拒绝", async () => {
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "http://127.0.0.1.evil.com" }), loopback),
    ).toBe(false);
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "http://127.evil.com" }), loopback),
    ).toBe(false);
  });

  it("子域绕过：localhost.evil.com 形态 → 拒绝", async () => {
    expect(
      await authResolve(req({ host: "127.0.0.1:6180", origin: "http://localhost.evil.com" }), loopback),
    ).toBe(false);
    expect(await authResolve(req({ host: "localhost.evil.com:6180" }), loopback)).toBe(false);
  });
});
