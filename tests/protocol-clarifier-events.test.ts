import { describe, it, expect } from "bun:test";
import { getChannelsForEvent, type AutopilotEvent } from "../src/daemon/protocol";

describe("protocol — clarifier 新事件 channel 路由", () => {
  it("requirement:active-question-changed → requirement:*", () => {
    const ev = { type: "requirement:active-question-changed", payload: { id: "r1", question_id: "q1" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:spec-revised → requirement:*", () => {
    const ev = { type: "requirement:spec-revised", payload: { id: "r1", revision_id: 5 } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:clarifier-error → requirement:*", () => {
    const ev = { type: "requirement:clarifier-error", payload: { id: "r1", reason: "JSON parse failed" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });

  it("requirement:question-resolved → requirement:*", () => {
    const ev = { type: "requirement:question-resolved", payload: { id: "r1", question_id: "q1" } } as AutopilotEvent;
    expect(getChannelsForEvent(ev)).toContain("requirement:*");
  });
});
