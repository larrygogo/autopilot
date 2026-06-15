/**
 * A2 鉴权模型测试 —— authResolve 统一 HTTP/WS 口径 + JWT 服务端强制 + 启动门 SEC-6。
 * 全套测「无 API token」场景（验证 JWT/零配置/loopback 的新行为）；token 路径由
 * routes-auth-token.test.ts 既有 8 用例守护（R3/R5/R6 不变）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { deleteApiToken } from "../src/core/api-token";
import { handleRequest, reloadApiToken, checkWebSocketAuth, startupAuthBlocked } from "../src/daemon/routes";
import { createUser, signJwt, makeSessionCookie } from "../src/core/auth";

const fakeLoopback = { requestIP: () => ({ address: "127.0.0.1", port: 0, family: "IPv4" }) } as unknown as import("bun").Server<undefined>;
const fakeLan = { requestIP: () => ({ address: "192.168.1.42", port: 0, family: "IPv4" }) } as unknown as import("bun").Server<undefined>;

let tmpHome: string;
let oldHome: string | undefined;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "autopilot-authresolve-"));
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  oldHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  deleteApiToken();   // 本套全部测「无 API token」场景
  reloadApiToken();
});
afterEach(() => {
  // ⚠️ deleteApiToken 的路径按「调用时」的 AUTOPILOT_HOME 重算 —— 必须在恢复 env 之前调，
  // 否则删的是用户真实 ~/.autopilot/runtime/api-token（2026-06-11 事故：每跑一次
  // bun test 就清一次生产 token，远程访问全挂）。
  try { deleteApiToken(); } catch { /* ignore */ }
  if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome; else delete process.env.AUTOPILOT_HOME;
  reloadApiToken();
  _setDbForTest(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

async function jwtCookieHeader(): Promise<string> {
  const user = await createUser("a@b.io", "pw123456");
  const jwt = await signJwt(user.id, user.email);
  return makeSessionCookie(jwt); // "autopilot_session=<jwt>; HttpOnly; ..."（extractJwtFromCookie 取首段）
}

describe("authResolve · 零配置 / JWT 强制（HTTP）", () => {
  it("R2 无 token 无用户 + LAN 无凭证 → 200（零配置放行）", async () => {
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLan);
    expect(res.status).toBe(200);
  });

  it("R4 无 token 有用户 + LAN 无凭证 → 401（JWT 被服务端强制）", async () => {
    await createUser("u@b.io", "pw123456"); // hasAnyUser=true
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLan);
    expect(res.status).toBe(401);
  });

  it("R1 无 token 有用户 + loopback 无凭证 → 200（本机豁免，CLI/TUI 命脉）", async () => {
    await createUser("u@b.io", "pw123456");
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLoopback);
    expect(res.status).toBe(200);
  });

  it("R7-HTTP LAN + 有效 JWT cookie → 200", async () => {
    const cookie = await jwtCookieHeader();
    const res = await handleRequest(new Request("http://localhost/api/status", { headers: { Cookie: cookie } }), fakeLan);
    expect(res.status).toBe(200);
  });

  it("R8 LAN + 伪造 JWT cookie → 401", async () => {
    await createUser("u@b.io", "pw123456");
    const res = await handleRequest(
      new Request("http://localhost/api/status", { headers: { Cookie: makeSessionCookie("not.a.jwt") } }),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });
});

describe("authResolve · WS 同口径（checkWebSocketAuth 改 async）", () => {
  it("R7-WS LAN + 有效 JWT cookie → 放行（半不一致根除点）", async () => {
    const cookie = await jwtCookieHeader();
    const ok = await checkWebSocketAuth(
      new Request("http://localhost/ws", { headers: { Cookie: cookie } }),
      fakeLan,
    );
    expect(ok).toBe(true);
  });

  it("R4-WS LAN 有用户无凭证 → 拒绝", async () => {
    await createUser("u@b.io", "pw123456");
    const ok = await checkWebSocketAuth(new Request("http://localhost/ws"), fakeLan);
    expect(ok).toBe(false);
  });

  it("R1-WS loopback 无凭证 → 放行（CLI/TUI 命脉）", async () => {
    await createUser("u@b.io", "pw123456");
    const ok = await checkWebSocketAuth(new Request("http://localhost/ws"), fakeLoopback);
    expect(ok).toBe(true);
  });
});

describe("startupAuthBlocked（SEC-6 启动门谓词）", () => {
  it("暴露 host + 无 token 无用户 + 未 insecure → 阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", false, false, false)).toBe(true);
  });
  it("暴露 host + 有用户（无 token）→ 不阻塞（JWT 已是服务端一等鉴权）", () => {
    expect(startupAuthBlocked("0.0.0.0", false, true, false)).toBe(false);
  });
  it("暴露 host + 有 token → 不阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", true, false, false)).toBe(false);
  });
  it("loopback host → 永不阻塞", () => {
    expect(startupAuthBlocked("127.0.0.1", false, false, false)).toBe(false);
  });
  it("insecure 逃生口 → 不阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", false, false, true)).toBe(false);
  });
});
