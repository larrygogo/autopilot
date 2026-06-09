import { describe, it, expect, beforeEach } from "bun:test";
import { createProviderErrorSource } from "../../src/core/card-sources/provider-error";
import {
  recordProviderFailure,
  recordProviderSuccess,
  _resetForTest,
} from "../../src/core/provider-health";

describe("CardSource: provider-error", () => {
  beforeEach(() => _resetForTest());

  it("name 与订阅", () => {
    const src = createProviderErrorSource();
    expect(src.name).toBe("provider-error");
    expect(src.subscribes).toEqual(["provider:health-changed"]);
  });

  it("scan 从 provider-health 拉所有 unhealthy provider 出 P0 卡", async () => {
    // 阈值 2：两次失败后才不健康
    recordProviderFailure("anthropic", "auth 401");
    recordProviderFailure("anthropic", "auth 401");
    recordProviderFailure("openai", "rate limit"); // 一次 → 仍 healthy

    const cards = await createProviderErrorSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("provider-error:anthropic");
    expect(cards[0].priority).toBe("P0");
    expect(cards[0].category).toBe("error");
    expect(cards[0].subtitle).toContain("auth 401");
    expect(cards[0].dismissable).toBe(true);
    expect(cards[0].actions[0]?.intent.kind).toBe("configure_providers");
  });

  it("onEvent: health-changed healthy=false → add 卡", async () => {
    recordProviderFailure("anthropic", "kaboom");
    const deltas = await createProviderErrorSource().onEvent({
      type: "provider:health-changed",
      payload: { provider: "anthropic", healthy: false, reason: "kaboom", ts: Date.now() },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("provider-error:anthropic");
      expect(deltas[0].card.subtitle).toContain("kaboom");
    } else {
      throw new Error("expected add delta");
    }
  });

  it("onEvent: health-changed healthy=true → remove 卡", async () => {
    const deltas = await createProviderErrorSource().onEvent({
      type: "provider:health-changed",
      payload: { provider: "anthropic", healthy: true, ts: Date.now() },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") {
      expect(deltas[0].id).toBe("provider-error:anthropic");
    }
  });

  it("无关事件返回空", async () => {
    const deltas = await createProviderErrorSource().onEvent({
      type: "task:transition",
      payload: { taskId: "t1", from: "a", to: "b", trigger: "t" },
    });
    expect(deltas).toEqual([]);
  });
});

describe("provider-health 阈值与状态转换", () => {
  beforeEach(() => _resetForTest());

  it("单次失败不触发不健康（threshold=2）", async () => {
    recordProviderFailure("p", "x");
    const cards = await createProviderErrorSource().scan();
    expect(cards).toEqual([]);
  });

  it("连续 2 次失败 → 不健康", async () => {
    recordProviderFailure("p", "x");
    recordProviderFailure("p", "y");
    const cards = await createProviderErrorSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].subtitle).toContain("y"); // 用最近一次原因
  });

  it("一次成功重置 consecutive_failures", async () => {
    recordProviderFailure("p", "x");
    recordProviderFailure("p", "y"); // 触发不健康
    recordProviderSuccess("p");      // 重置
    const cards = await createProviderErrorSource().scan();
    expect(cards).toEqual([]);
  });
});
