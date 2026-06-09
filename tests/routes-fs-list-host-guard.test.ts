import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest, setListenHost } from "../src/daemon/routes";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

// /api/fs/list 守卫按「请求来源 socket IP」判断（不是 daemon 绑定地址）：
//   本机 loopback 请求放行；局域网远程请求禁用——即使 daemon 绑 0.0.0.0。
function fakeServer(address: string): import("bun").Server<undefined> {
  return {
    requestIP: () => ({ address, port: 0, family: address.includes(":") ? "IPv6" : "IPv4" }),
  } as unknown as import("bun").Server<undefined>;
}
const loopbackServer = fakeServer("127.0.0.1");
const ipv6LoopbackServer = fakeServer("::1");
const lanServer = fakeServer("192.168.1.50");

let tmpHome: string;
let testDb: Database;

// authResolve 现在会调 hasAnyUser() 查 users 表（A2 鉴权），夹具需跑真实迁移建表，
// 否则抛 "no such table: users"，掩盖真正要测的来源校验逻辑。
beforeAll(async () => {
  testDb = new Database(":memory:");
  _setDbForTest(testDb);
  initDb();
  await runPendingMigrations();
});

afterAll(() => {
  _setDbForTest(null);
  testDb.close();
});

function req(path: string): Request {
  return new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(path)}`);
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-fs-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  setListenHost("127.0.0.1");
});

describe("/api/fs/list 来源校验（按请求 socket IP）", () => {
  it("本机 loopback 请求 + 绑 127.0.0.1 → 200", async () => {
    setListenHost("127.0.0.1");
    const res = await handleRequest(req(tmpHome), loopbackServer);
    expect(res.status).toBe(200);
  });

  it("本机 loopback 请求 + 绑 0.0.0.0 → 200（放行：本机可信，不被公网绑定连累）", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(req(tmpHome), loopbackServer);
    expect(res.status).toBe(200);
  });

  it("IPv6 ::1 本机请求 + 绑 0.0.0.0 → 200", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(req(tmpHome), ipv6LoopbackServer);
    expect(res.status).toBe(200);
  });

  // 非 loopback 请求被挡：可能是 fs 守卫的 403，也可能先被 token 鉴权 401 拦下
  //（取决于是否配了 API token）——两者都代表「远程无法浏览本机文件树」。
  it("局域网远程请求（192.168.x）+ 绑 0.0.0.0 → 被挡（401/403）", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(req(tmpHome), lanServer);
    expect([401, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("拿不到来源 IP（server 缺失）→ 被挡（401/403，保守拒绝）", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(req(tmpHome), undefined);
    expect([401, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});
