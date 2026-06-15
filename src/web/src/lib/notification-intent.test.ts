import { test, expect } from "bun:test";
import { resolveNotificationIntent } from "./notification-intent";
import type { NotificationContext } from "./notification-types";

const ctx = (requirement_id: string): NotificationContext => ({
  requirement_id,
  requirement_title: "某需求",
});

test("view_task + 有 requirement context → 落需求页（不进独立任务页）", () => {
  const r = resolveNotificationIntent({ kind: "view_task", taskId: "abcd1234" }, ctx("req-023"));
  expect(r.href).toBe("/requirements/req-023");
});

test("view_task + 无 context（极旧通知/游离任务）→ 回退任务页", () => {
  const r = resolveNotificationIntent({ kind: "view_task", taskId: "abcd1234" });
  expect(r.href).toBe("/tasks/abcd1234");
  const r2 = resolveNotificationIntent({ kind: "view_task", taskId: "abcd1234" }, null);
  expect(r2.href).toBe("/tasks/abcd1234");
});

test("reject_review + context → 需求页（驳回在需求页审查卡完成）", () => {
  const r = resolveNotificationIntent({ kind: "reject_review", taskId: "abcd1234" }, ctx("req-9"));
  expect(r.href).toBe("/requirements/req-9");
  expect(r.label).toBe("驳回");
});

test("view_requirement 不受影响", () => {
  const r = resolveNotificationIntent({ kind: "view_requirement", requirementId: "req-1" }, ctx("req-1"));
  expect(r.href).toBe("/requirements/req-1");
});
