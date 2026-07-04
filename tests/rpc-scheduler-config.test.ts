/**
 * scheduler.get / scheduler.save RPC 测试。
 *
 * 设置页（Web）通过这对 RPC 读写 config.json 的 scheduler.max_concurrent_tasks，
 * 与 CLI 直接编辑 JSON 是同一份配置。save 后调度器下次 tick 现读即生效。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { _setDbForTest } from "../src/core/db";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("scheduler.get / scheduler.save RPC", () => {
  let db: Database;
  let tmpCfgDir: string;
  let tmpCfgFile: string;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    _setDbForTest(db);
    tmpCfgDir = join(tmpdir(), `ap-rpc-sched-${Date.now()}`);
    mkdirSync(tmpCfgDir, { recursive: true });
    tmpCfgFile = join(tmpCfgDir, "config.json");
    writeFileSync(tmpCfgFile, "{}", "utf-8");
    process.env.DEV_WORKFLOW_CONFIG = tmpCfgFile;
    registerCoreRpcMethods();
  });

  afterAll(() => {
    delete process.env.DEV_WORKFLOW_CONFIG;
    if (existsSync(tmpCfgDir)) rmSync(tmpCfgDir, { recursive: true, force: true });
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    writeFileSync(tmpCfgFile, "{}", "utf-8");
  });

  it("get：未配置时 max_concurrent_tasks=null，effective=1", async () => {
    const r = await invokeRpcMethod("scheduler.get", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.payload as { max_concurrent_tasks: number | null; effective_max_concurrent_tasks: number };
      expect(d.max_concurrent_tasks).toBeNull();
      expect(d.effective_max_concurrent_tasks).toBe(1);
    }
  });

  it("save 后 get 读回同值", async () => {
    const s = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: 3 });
    expect(s.ok).toBe(true);
    const r = await invokeRpcMethod("scheduler.get", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.payload as { max_concurrent_tasks: number | null; effective_max_concurrent_tasks: number };
      expect(d.max_concurrent_tasks).toBe(3);
      expect(d.effective_max_concurrent_tasks).toBe(3);
    }
  });

  it("save null → 删除 scheduler 段回落默认 1", async () => {
    await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: 4 });
    const s = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: null });
    expect(s.ok).toBe(true);
    const r = await invokeRpcMethod("scheduler.get", {});
    if (r.ok) {
      const d = r.payload as { max_concurrent_tasks: number | null; effective_max_concurrent_tasks: number };
      expect(d.max_concurrent_tasks).toBeNull();
      expect(d.effective_max_concurrent_tasks).toBe(1);
    }
  });

  it("save 0 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("save 负数 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: -2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("save 浮点数 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: 2.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("save 字符串 → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("scheduler.save", { max_concurrent_tasks: "three" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });
});
