import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest, setListenHost, tokenEquals } from "../src/daemon/routes";

// /mcp 应只对本机 loopback 开放（MCP 客户端永远是本机 claude 子进程）；绑 0.0.0.0 时
// 局域网远程请求按来源 socket IP 挡 403——与 /api/fs/list 同款（SEC-2）。
function fakeServer(address: string): import("bun").Server<undefined> {
  return {
    requestIP: () => ({ address, port: 0, family: address.includes(":") ? "IPv6" : "IPv4" }),
  } as unknown as import("bun").Server<undefined>;
}
const loopbackServer = fakeServer("127.0.0.1");
const lanServer = fakeServer("192.168.1.50");

function mcpReq(): Request {
  return new Request("http://127.0.0.1:6180/mcp", {
    method: "POST",
    headers: { authorization: "Bearer whatever", "content-type": "application/json" },
    body: "{}",
  });
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-mcp-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  setListenHost("127.0.0.1");
});

describe("/mcp loopback 闸（SEC-2）", () => {
  it("局域网远程请求 + 绑 0.0.0.0 → 403", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(mcpReq(), lanServer);
    expect(res.status).toBe(403);
  });

  it("拿不到来源 IP（server 缺失）→ 403（保守拒绝）", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(mcpReq(), undefined);
    expect(res.status).toBe(403);
  });

  it("本机 loopback 请求 → 不被 loopback 闸挡（放行进 MCP handler）", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(mcpReq(), loopbackServer);
    // 过了 loopback 闸后 MCP runtime 未初始化 → 503；关键是 NOT 403（没被来源闸拦）
    expect(res.status).not.toBe(403);
  });
});

describe("tokenEquals 常量时间比较（SEC-3）", () => {
  it("相等 → true", () => {
    expect(tokenEquals("s3cr3t-token-abc", "s3cr3t-token-abc")).toBe(true);
  });
  it("不等（同长）→ false", () => {
    expect(tokenEquals("s3cr3t-token-abc", "s3cr3t-token-xyz")).toBe(false);
  });
  it("长度不同 → false（不抛错）", () => {
    expect(tokenEquals("short", "a-much-longer-token")).toBe(false);
    expect(tokenEquals("", "x")).toBe(false);
  });
  it("空对空 → true", () => {
    expect(tokenEquals("", "")).toBe(true);
  });
});
