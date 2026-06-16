import { describe, it, expect } from "bun:test";
import { getChannelsForEvent } from "../src/daemon/protocol";
import type { AutopilotEvent } from "../src/core/events";
import type { Notification } from "../src/core/notify/types";

const fakeNotification: Notification = {
  id: 1,
  type: "task_done",
  severity: "info",
  title: "任务完成",
  body: "t",
  related_type: "task",
  related_id: "t1",
  context: null,
  actions: [],
  read_at: null,
  dismissed_at: null,
  created_at: 0,
};

describe("notification:* 频道分发", () => {
  const cases: AutopilotEvent[] = [
    { type: "notification:created", payload: { notification: fakeNotification } },
    { type: "notification:read", payload: { ids: [1, 2] } },
    { type: "notification:all_read", payload: {} },
    { type: "notification:dismissed", payload: { id: 1 } },
  ];

  for (const event of cases) {
    it(`${event.type} → notification:*`, () => {
      expect(getChannelsForEvent(event)).toContain("notification:*");
    });
  }

  it("requirement:schedule-error → requirement:*（recorder 触发源）", () => {
    const channels = getChannelsForEvent({
      type: "requirement:schedule-error",
      payload: { id: "req-1", reason: "x" },
    });
    expect(channels).toContain("requirement:*");
  });
});
