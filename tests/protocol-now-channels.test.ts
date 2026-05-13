import { describe, it, expect } from "bun:test";
import { getChannelsForEvent, type AutopilotEvent } from "../src/daemon/protocol";
import type { NowCard } from "../src/core/now-types";

const sampleCard: NowCard = {
  id: "await-review:task-5",
  priority: "P1",
  category: "decision",
  title: "Task #5 等审方案",
  subtitle: "design 阶段就绪",
  actions: [],
  dismissable: false,
  created_at: 1700000000,
};

describe("getChannelsForEvent — now:* 事件", () => {
  it("now:card_added 走 now:* 频道", () => {
    const event = { type: "now:card_added", payload: { card: sampleCard } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:card_updated 走 now:* 频道", () => {
    const event = { type: "now:card_updated", payload: { id: "x", patch: {} } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:card_removed 走 now:* 频道", () => {
    const event = { type: "now:card_removed", payload: { id: "x", reason: "resolved" } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });

  it("now:snapshot 走 now:* 频道", () => {
    const event = { type: "now:snapshot", payload: { cards: [] } } as AutopilotEvent;
    expect(getChannelsForEvent(event)).toContain("now:*");
  });
});
