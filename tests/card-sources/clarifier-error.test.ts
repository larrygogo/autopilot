import { describe, it, expect } from "bun:test";
import { createClarifierErrorSource } from "../../src/core/card-sources/clarifier-error";

describe("CardSource: clarifier-error", () => {
  it("name='clarifier-error'，订阅 requirement:clarifier-error", () => {
    const src = createClarifierErrorSource();
    expect(src.name).toBe("clarifier-error");
    expect(src.subscribes).toEqual(["requirement:clarifier-error"]);
  });

  it("scan 返回空（瞬时通知，不持久化）", async () => {
    expect(await createClarifierErrorSource().scan()).toEqual([]);
  });

  it("onEvent: clarifier-error → P0 add 卡，dismissable=false", async () => {
    const deltas = await createClarifierErrorSource().onEvent({
      type: "requirement:clarifier-error",
      payload: { id: "r1", reason: "JSON parse failed" },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("clarifier-error:r1");
      expect(deltas[0].card.priority).toBe("P0");
      expect(deltas[0].card.category).toBe("error");
      expect(deltas[0].card.dismissable).toBe(false);
      expect(deltas[0].card.subtitle).toContain("JSON parse failed");
      const hasHref = deltas[0].card.actions.some(
        a => a.href === `/requirements/r1`,
      );
      const hasInvoke = deltas[0].card.actions.some(a =>
        a.invoke?.method === "POST" &&
        a.invoke?.path === `/api/requirements/r1/retry-clarify`,
      );
      expect(hasHref).toBe(true);
      expect(hasInvoke).toBe(true);
    }
  });
});
