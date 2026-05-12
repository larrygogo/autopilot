import { describe, it, expect } from "bun:test";
import { createProviderErrorSource } from "../../src/core/card-sources/provider-error";

describe("CardSource: provider-error (stub)", () => {
  it("name 与接口正常", () => {
    const src = createProviderErrorSource();
    expect(src.name).toBe("provider-error");
    expect(src.subscribes).toEqual([]);
  });

  it("scan 返回空（stub）", async () => {
    expect(await createProviderErrorSource().scan()).toEqual([]);
  });

  it("onEvent 返回空（stub）", async () => {
    const deltas = await createProviderErrorSource().onEvent({
      type: "task:transition",
      payload: { taskId: "x", from: "a", to: "b", trigger: "t" },
    });
    expect(deltas).toEqual([]);
  });
});
