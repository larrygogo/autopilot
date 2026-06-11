/**
 * notifications.* RPC 测试 —— 事件型通知流的 WS RPC 契约。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate035 } from "../src/migrations/035-notifications";
import { _setDbForTest } from "../src/core/db";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";
import { createNotification } from "../src/core/notifications";

describe("notifications.* RPC", () => {
  let db: Database;

  beforeAll(() => {
    registerCoreRpcMethods();
  });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate035(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
  });

  it("list / unreadCount 基础链路", async () => {
    createNotification({ type: "task_done", title: "a" });
    createNotification({ type: "task_failed", title: "b" });
    const list = await invokeRpcMethod("notifications.list", {});
    expect(list.ok).toBe(true);
    if (list.ok) {
      const d = list.payload as { items: Array<{ title: string }>; next_before_id: number | null };
      expect(d.items.map((n) => n.title)).toEqual(["b", "a"]);
    }
    const count = await invokeRpcMethod("notifications.unreadCount", {});
    expect(count.ok).toBe(true);
    if (count.ok) expect((count.payload as { count: number }).count).toBe(2);
  });

  it("markRead 校验入参并幂等", async () => {
    const n = createNotification({ type: "task_done", title: "a" });
    const bad = await invokeRpcMethod("notifications.markRead", { ids: [] });
    expect(bad.ok).toBe(false);
    const ok = await invokeRpcMethod("notifications.markRead", { ids: [n.id] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.payload as { updated: number }).updated).toBe(1);
    const again = await invokeRpcMethod("notifications.markRead", { ids: [n.id] });
    if (again.ok) expect((again.payload as { updated: number }).updated).toBe(0);
  });

  it("markAllRead + dismiss + NOT_FOUND", async () => {
    const a = createNotification({ type: "task_done", title: "a" });
    createNotification({ type: "task_done", title: "b" });
    const all = await invokeRpcMethod("notifications.markAllRead", {});
    expect(all.ok).toBe(true);
    if (all.ok) expect((all.payload as { updated: number }).updated).toBe(2);

    const dis = await invokeRpcMethod("notifications.dismiss", { id: a.id });
    expect(dis.ok).toBe(true);
    const missing = await invokeRpcMethod("notifications.dismiss", { id: 99999 });
    expect(missing.ok).toBe(false);

    const list = await invokeRpcMethod("notifications.list", {});
    if (list.ok) {
      expect((list.payload as { items: unknown[] }).items.length).toBe(1);
    }
  });

  it("providers.health 返回数组", async () => {
    const r = await invokeRpcMethod("providers.health", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.payload)).toBe(true);
  });
});
