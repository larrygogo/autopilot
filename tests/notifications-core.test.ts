import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate035 } from "../src/migrations/035-notifications";
import { _setDbForTest } from "../src/core/db";
import {
  createNotification,
  getNotification,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  dismissNotification,
  pruneNotifications,
} from "../src/core/notifications";

describe("notifications core", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    migrate035(db);
    _setDbForTest(db);
  });

  it("createNotification 落库并按 type 映射 severity", () => {
    const n = createNotification({
      type: "task_failed",
      title: "任务失败",
      body: "确定性失败",
      related: { type: "task", id: "abc12345" },
      context: { requirement_id: "req-001", requirement_title: "测试需求" },
      actions: [{ intent: { kind: "view_task", taskId: "abc12345" }, kind: "primary" }],
    });
    expect(n.id).toBeGreaterThan(0);
    expect(n.severity).toBe("error");
    expect(n.read_at).toBeNull();
    expect(n.dismissed_at).toBeNull();
    expect(n.context?.requirement_title).toBe("测试需求");
    expect(n.actions[0]?.intent.kind).toBe("view_task");

    const done = createNotification({ type: "task_done", title: "任务完成" });
    expect(done.severity).toBe("info");
    const approval = createNotification({ type: "requirement_awaiting_approval", title: "等待审批" });
    expect(approval.severity).toBe("action");
  });

  it("listNotifications 倒序 + 游标分页 + 过滤", () => {
    for (let i = 1; i <= 5; i++) {
      createNotification({ type: "task_done", title: `n${i}` });
    }
    const page1 = listNotifications({ limit: 2 });
    expect(page1.items.map((n) => n.title)).toEqual(["n5", "n4"]);
    expect(page1.next_before_id).toBe(page1.items[1].id);

    const page2 = listNotifications({ limit: 2, before_id: page1.next_before_id! });
    expect(page2.items.map((n) => n.title)).toEqual(["n3", "n2"]);

    // unread_only：标记 n5 已读后不再出现
    const n5 = page1.items[0];
    markRead([n5.id]);
    const unread = listNotifications({ unread_only: true });
    expect(unread.items.find((n) => n.id === n5.id)).toBeUndefined();

    // dismissed 默认隐藏，include_dismissed 可见
    const n4 = page1.items[1];
    dismissNotification(n4.id);
    expect(listNotifications({}).items.find((n) => n.id === n4.id)).toBeUndefined();
    expect(
      listNotifications({ include_dismissed: true }).items.find((n) => n.id === n4.id),
    ).toBeDefined();
  });

  it("unreadCount 排除已读与已删", () => {
    const a = createNotification({ type: "task_done", title: "a" });
    const b = createNotification({ type: "task_failed", title: "b" });
    createNotification({ type: "agent_question", title: "c" });
    expect(unreadCount()).toBe(3);
    markRead([a.id]);
    expect(unreadCount()).toBe(2);
    dismissNotification(b.id);
    expect(unreadCount()).toBe(1);
  });

  it("markRead 幂等且只动指定行；markAllRead 清空未读", () => {
    const a = createNotification({ type: "task_done", title: "a" });
    const b = createNotification({ type: "task_done", title: "b" });
    expect(markRead([a.id])).toBe(1);
    expect(markRead([a.id])).toBe(0); // 幂等
    expect(getNotification(b.id)?.read_at).toBeNull();
    expect(markAllRead()).toBe(1);
    expect(unreadCount()).toBe(0);
    expect(markAllRead()).toBe(0);
  });

  it("dismissNotification：存在返回 true（幂等），不存在返回 false", () => {
    const a = createNotification({ type: "task_done", title: "a" });
    expect(dismissNotification(a.id)).toBe(true);
    const at = getNotification(a.id)?.dismissed_at;
    expect(at).not.toBeNull();
    expect(dismissNotification(a.id)).toBe(true); // 幂等，不覆盖时间戳
    expect(getNotification(a.id)?.dismissed_at).toBe(at!);
    expect(dismissNotification(99999)).toBe(false);
  });

  it("pruneNotifications 按天 + 按行数上限清理", () => {
    for (let i = 0; i < 10; i++) {
      createNotification({ type: "task_done", title: `n${i}` });
    }
    // 行数上限 5 → 删 5 条最旧
    expect(pruneNotifications({ retention_days: 30, max_rows: 5 })).toBe(5);
    expect(listNotifications({ limit: 50 }).items.length).toBe(5);
    // retention 0 天 → 全删（created_at < now 的都算过期需要 cutoff > created_at；用 -1 天保证）
    expect(pruneNotifications({ retention_days: -1, max_rows: 500 })).toBe(5);
    expect(listNotifications({ limit: 50 }).items.length).toBe(0);
  });

  it("脏 context_json 不阻断读取", () => {
    const n = createNotification({ type: "task_done", title: "a" });
    const { getDb } = require("../src/core/db");
    getDb().run("UPDATE notifications SET context_json = ? WHERE id = ?", ["{bad json", n.id]);
    const loaded = getNotification(n.id);
    expect(loaded?.context).toBeNull();
    expect(loaded?.title).toBe("a");
  });
});
