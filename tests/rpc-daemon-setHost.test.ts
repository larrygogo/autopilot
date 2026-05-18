/**
 * daemon.setHost RPC 校验测试。
 *
 * 之前只查 IPv4 字面量合法 → 不可达 IP（如 192.0.2.1）也接受 → daemon 重启
 * 时 EADDRNOTAVAIL → supervisor 进崩溃循环、UI 完全失联（QA P0-1）。
 * 现在限定：loopback 字面量 / 0.0.0.0 / 命中本机网卡的 LAN IP。
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { _setDbForTest } from "../src/core/db";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("daemon.setHost 校验", () => {
  let db: Database;
  // 备份 home，避免污染真实用户配置
  let oldHome: string | undefined;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    _setDbForTest(db);
    // 用临时目录承接 saveDaemonConfig 写入
    oldHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = require("os").tmpdir() + "/autopilot-setHost-test-" + Date.now();
    require("fs").mkdirSync(process.env.AUTOPILOT_HOME, { recursive: true });
    registerCoreRpcMethods();
  });

  afterAll(() => {
    _setDbForTest(null);
    if (process.env.AUTOPILOT_HOME) {
      try { require("fs").rmSync(process.env.AUTOPILOT_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome;
    else delete process.env.AUTOPILOT_HOME;
  });

  it("接受 127.0.0.1", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "127.0.0.1" });
    expect(r.ok).toBe(true);
  });

  it("接受 localhost", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "localhost" });
    expect(r.ok).toBe(true);
  });

  it("接受 0.0.0.0", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "0.0.0.0" });
    expect(r.ok).toBe(true);
  });

  it("拒绝不可达 IPv4（如 192.0.2.1 documentation 段）→ INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "192.0.2.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("拒绝非 IPv4 字符串 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("空 host → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("daemon.setHost", { host: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("缺 host 参数 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("daemon.setHost", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });
});
