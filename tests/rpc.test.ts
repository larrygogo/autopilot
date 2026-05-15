import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerRpcMethod,
  invokeRpcMethod,
  hasRpcMethod,
  listRpcMethods,
  RpcError,
  _resetRpcRegistryForTest,
} from "../src/daemon/rpc";

describe("rpc registry", () => {
  beforeEach(() => {
    _resetRpcRegistryForTest();
  });

  it("注册 + 查询 + 列表", () => {
    expect(hasRpcMethod("a")).toBe(false);
    registerRpcMethod({ method: "a", handler: () => 1 });
    registerRpcMethod({ method: "b", handler: () => 2 });
    expect(hasRpcMethod("a")).toBe(true);
    expect(listRpcMethods()).toEqual(["a", "b"]);
  });

  it("重复注册抛错避免静默覆盖", () => {
    registerRpcMethod({ method: "a", handler: () => 1 });
    expect(() => registerRpcMethod({ method: "a", handler: () => 2 })).toThrow();
  });
});

describe("invokeRpcMethod", () => {
  beforeEach(() => {
    _resetRpcRegistryForTest();
  });

  it("成功 → { ok:true, payload }", async () => {
    registerRpcMethod({ method: "echo", handler: (p) => ({ got: p }) });
    const r = await invokeRpcMethod("echo", { hello: 1 });
    expect(r).toEqual({ ok: true, payload: { got: { hello: 1 } } });
  });

  it("异步 handler → 等 promise 解析", async () => {
    registerRpcMethod({
      method: "delay",
      handler: async (p) => {
        await new Promise((res) => setTimeout(res, 5));
        return { p };
      },
    });
    const r = await invokeRpcMethod("delay", "x");
    expect(r).toEqual({ ok: true, payload: { p: "x" } });
  });

  it("未注册的 method → METHOD_NOT_FOUND", async () => {
    const r = await invokeRpcMethod("nope", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("METHOD_NOT_FOUND");
      expect(r.error.message).toContain("nope");
    }
  });

  it("handler 抛 RpcError → 透传 code/message", async () => {
    registerRpcMethod({
      method: "badparam",
      handler: () => {
        throw new RpcError("INVALID_PARAM", "需要 id");
      },
    });
    const r = await invokeRpcMethod("badparam", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({ code: "INVALID_PARAM", message: "需要 id" });
    }
  });

  it("handler 抛普通 Error → 包成 INTERNAL", async () => {
    registerRpcMethod({
      method: "crash",
      handler: () => {
        throw new Error("boom");
      },
    });
    const r = await invokeRpcMethod("crash", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toBe("boom");
    }
  });

  it("handler 抛非 Error（如字符串） → INTERNAL + stringify", async () => {
    registerRpcMethod({
      method: "weird",
      handler: () => {
        throw "string error";
      },
    });
    const r = await invokeRpcMethod("weird", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toBe("string error");
    }
  });

  it("永不抛——即使 handler 也抛了，invokeRpcMethod 仍然 resolve", async () => {
    registerRpcMethod({
      method: "throws",
      handler: () => {
        throw new Error("x");
      },
    });
    // 不会进 catch 分支
    let caught = false;
    try {
      await invokeRpcMethod("throws", null);
    } catch {
      caught = true;
    }
    expect(caught).toBe(false);
  });
});
