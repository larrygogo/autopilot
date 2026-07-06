/**
 * requirements.create RPC handler 透传 source/external_ref/callback_url/callback_secret
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";
import { createProject } from "../src/core/projects";

describe("requirements.create RPC — source 字段透传", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registerCoreRpcMethods();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirements");
    db.run("DELETE FROM projects");
    createProject({ id: "proj-rpc-test", name: "RPC Test Project" });
  });

  it("传入 source/external_ref/callback_url/callback_secret 能落库", async () => {
    const res = await invokeRpcMethod("requirements.create", {
      project_id: "proj-rpc-test",
      title: "来自 reqgenie 的需求",
      spec_md: "规约",
      source: "reqgenie",
      external_ref: "rg-abc-def",
      callback_url: "https://example.com/cb",
      callback_secret: "tok123",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const req = (res.payload as { requirement: { source: string | null; external_ref: string | null; callback_url: string | null; callback_secret: string | null } }).requirement;
      expect(req.source).toBe("reqgenie");
      expect(req.external_ref).toBe("rg-abc-def");
      expect(req.callback_url).toBe("https://example.com/cb");
      expect(req.callback_secret).toBe("tok123");
    }
  });

  it("不传新字段时新字段为 null（现有调用方不受影响）", async () => {
    const res = await invokeRpcMethod("requirements.create", {
      project_id: "proj-rpc-test",
      title: "普通需求",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const req = (res.payload as { requirement: { source: string | null } }).requirement;
      expect(req.source).toBeNull();
    }
  });
});
