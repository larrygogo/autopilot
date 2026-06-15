/**
 * routes.ts checkAuth 鉴权路径测试 —— QA 第一轮盲区。
 *
 * 覆盖：
 * - loopback 来源自动豁免（127.0.0.1）
 * - 非 loopback + Authorization: Bearer 头
 * - 非 loopback + X-Autopilot-Token 头
 * - 非 loopback + ?token= URL query（浏览器 WS API 无法塞 header 必走 query）
 * - 非 loopback + 无 token → 401
 * - 非 loopback + 错 token → 401
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { saveApiToken, deleteApiToken } from "../src/core/api-token";
import { handleRequest, reloadApiToken } from "../src/daemon/routes";

const TEST_TOKEN = "test-token-abc123";

// 备份 + 恢复真实 ~/.autopilot/runtime/api-token，防测试清理路径误删
// 真实 token（之前 routes-auth-token 跑过一次把真实 token 删了，daemon 起不来）。
let realTokenBackup: string | null = null;
const REAL_AUTOPILOT_HOME = process.env.AUTOPILOT_HOME;
const fakeLoopback = {
  requestIP: () => ({ address: "127.0.0.1", port: 0, family: "IPv4" }),
} as unknown as import("bun").Server<undefined>;
const fakeLan = {
  requestIP: () => ({ address: "192.168.1.42", port: 0, family: "IPv4" }),
} as unknown as import("bun").Server<undefined>;

describe("checkAuth 鉴权路径", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeAll(async () => {
    // 先备份真实 token（如果存在），避免测试副作用删用户生产 token
    try {
      const fs = require("fs");
      const path = require("path");
      const homedir = require("os").homedir();
      const realHome = REAL_AUTOPILOT_HOME ?? path.join(homedir, ".autopilot");
      const realTokenPath = path.join(realHome, "runtime", "api-token");
      if (fs.existsSync(realTokenPath)) {
        realTokenBackup = fs.readFileSync(realTokenPath, "utf-8");
      }
    } catch { /* 备份失败不阻塞，但 deleteApiToken 仍只删 tmpHome 下文件 */ }

    tmpHome = mkdtempSync(join(tmpdir(), "autopilot-auth-test-"));
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    oldHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = tmpHome;
    _setDbForTest(new Database(":memory:"));
    initDb();
    await runPendingMigrations();
    saveApiToken(TEST_TOKEN);
    reloadApiToken();
  });

  afterAll(() => {
    // ⚠️ deleteApiToken 的路径按「调用时」的 AUTOPILOT_HOME 重算 —— 必须在恢复 env
    // 之前调（此时还指向 tmpHome）。旧代码顺序反了：先恢复 env 再删，删的是用户真实
    // ~/.autopilot/runtime/api-token，只是被下面的备份兜底掩盖了。
    try { deleteApiToken(); } catch { /* ignore */ }
    if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome;
    else delete process.env.AUTOPILOT_HOME;
    reloadApiToken();
    _setDbForTest(null);
    // 兜底：如果 backup 有但真实文件不在，恢复
    try {
      const fs = require("fs");
      const path = require("path");
      const homedir = require("os").homedir();
      const realHome = REAL_AUTOPILOT_HOME ?? path.join(homedir, ".autopilot");
      const realTokenPath = path.join(realHome, "runtime", "api-token");
      if (realTokenBackup && !fs.existsSync(realTokenPath)) {
        fs.mkdirSync(path.dirname(realTokenPath), { recursive: true });
        fs.writeFileSync(realTokenPath, realTokenBackup, "utf-8");
      }
    } catch { /* ignore */ }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("loopback 来源即使无 token 也豁免", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status"),
      fakeLoopback,
    );
    expect(res.status).toBe(200);
  });

  it("非 loopback + Authorization: Bearer 正确 → 200", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status", {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      }),
      fakeLan,
    );
    expect(res.status).toBe(200);
  });

  it("非 loopback + X-Autopilot-Token 正确 → 200", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status", {
        headers: { "X-Autopilot-Token": TEST_TOKEN },
      }),
      fakeLan,
    );
    expect(res.status).toBe(200);
  });

  it("非 loopback + ?token= 正确 → 200（浏览器 WebSocket 必走 query 路径）", async () => {
    const res = await handleRequest(
      new Request(`http://localhost/api/status?token=${encodeURIComponent(TEST_TOKEN)}`),
      fakeLan,
    );
    expect(res.status).toBe(200);
  });

  it("非 loopback + 完全无 token → 401", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status"),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });

  it("非 loopback + 错 Authorization Bearer → 401", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });

  it("非 loopback + 错 ?token= → 401", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status?token=wrong"),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });

  it("非 loopback + 错 X-Autopilot-Token → 401", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/status", {
        headers: { "X-Autopilot-Token": "wrong" },
      }),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });
});
