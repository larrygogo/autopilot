import { describe, it, expect } from "bun:test";
import { WsRpcClient, RpcCallError } from "../src/web/src/lib/ws-rpc-client";

/** 构造一个 client + 假 ws 的 fixture，捕获 sendRaw 的 frame，方便构造响应 */
function makeFixture(opts?: { isOpen?: boolean }) {
  const isOpenRef = { current: opts?.isOpen ?? true };
  const sent: string[] = [];
  const client = new WsRpcClient(
    (raw) => sent.push(raw),
    () => isOpenRef.current,
  );
  return { client, sent, isOpenRef };
}

describe("WsRpcClient", () => {
  it("call → 发 req frame，含 id/method/params", async () => {
    const { client, sent } = makeFixture();
    const p = client.call("tasks.list", { limit: 5 });
    expect(sent.length).toBe(1);
    const frame = JSON.parse(sent[0]!);
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("tasks.list");
    expect(frame.params).toEqual({ limit: 5 });
    expect(typeof frame.id).toBe("number");

    // 喂 res 让 promise 解析
    client.handleResFrame({ type: "res", id: frame.id, ok: true, payload: ["t1", "t2"] });
    await expect(p).resolves.toEqual(["t1", "t2"]);
  });

  it("id 单调递增，多个并发请求互不干扰", async () => {
    const { client, sent } = makeFixture();
    const p1 = client.call("a");
    const p2 = client.call("b");
    const p3 = client.call("c");
    expect(sent.length).toBe(3);
    const ids = sent.map((s) => (JSON.parse(s) as { id: number }).id);
    expect(new Set(ids).size).toBe(3); // 全不同
    expect(ids[1]).toBeGreaterThan(ids[0]!);
    expect(ids[2]).toBeGreaterThan(ids[1]!);

    // 乱序回响应仍然正确分发
    client.handleResFrame({ type: "res", id: ids[2]!, ok: true, payload: "C" });
    client.handleResFrame({ type: "res", id: ids[0]!, ok: true, payload: "A" });
    client.handleResFrame({ type: "res", id: ids[1]!, ok: true, payload: "B" });
    await expect(p1).resolves.toBe("A");
    await expect(p2).resolves.toBe("B");
    await expect(p3).resolves.toBe("C");
  });

  it("服务端 ok:false → reject RpcCallError 透传 code/message", async () => {
    const { client, sent } = makeFixture();
    const p = client.call("nope");
    const id = (JSON.parse(sent[0]!) as { id: number }).id;
    client.handleResFrame({
      type: "res",
      id,
      ok: false,
      error: { code: "METHOD_NOT_FOUND", message: "未注册的 method: nope" },
    });
    await expect(p).rejects.toBeInstanceOf(RpcCallError);
    try {
      await p;
    } catch (e: unknown) {
      expect((e as RpcCallError).code).toBe("METHOD_NOT_FOUND");
      expect((e as RpcCallError).message).toContain("nope");
    }
  });

  it("ws 未 open → 立刻 reject DISCONNECTED", async () => {
    const { client } = makeFixture({ isOpen: false });
    await expect(client.call("x")).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("超时 → reject TIMEOUT 并 evict pending", async () => {
    const { client } = makeFixture();
    // 必须立即 attach catch 避免 bun test 把 30ms 后的 reject 当 unhandled rejection
    const p = client.call("slow", null, { timeoutMs: 30 });
    const guarded = p.catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    const err = await guarded;
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(client.pendingCount()).toBe(0);
  });

  it("超时后才到的 res frame → 静默忽略，不抛", () => {
    const { client, sent } = makeFixture();
    void client.call("slow", null, { timeoutMs: 10 }).catch(() => { /* 吞错 */ });
    const id = (JSON.parse(sent[0]!) as { id: number }).id;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // pending 已 evict
        expect(client.pendingCount()).toBe(0);
        // 现在喂 late res — 应该静默
        expect(() =>
          client.handleResFrame({ type: "res", id, ok: true, payload: 1 }),
        ).not.toThrow();
        resolve();
      }, 30);
    });
  });

  it("rejectAllPending → 全部 pending 一齐 reject", async () => {
    const { client } = makeFixture();
    const p1 = client.call("a");
    const p2 = client.call("b");
    expect(client.pendingCount()).toBe(2);

    client.rejectAllPending("DISCONNECTED", "ws 断了");

    await expect(p1).rejects.toMatchObject({ code: "DISCONNECTED" });
    await expect(p2).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(client.pendingCount()).toBe(0);
  });

  it("未知 id 的 res → 静默忽略不抛", () => {
    const { client } = makeFixture();
    expect(() =>
      client.handleResFrame({ type: "res", id: 9999, ok: true, payload: 1 }),
    ).not.toThrow();
  });

  it("string id 也能匹配（OpenClaw 协议允许 string）", async () => {
    const { client, sent } = makeFixture();
    const p = client.call("x");
    const numericId = (JSON.parse(sent[0]!) as { id: number }).id;
    // 服务端把 number 转 string 也能匹配回去
    client.handleResFrame({ type: "res", id: String(numericId), ok: true, payload: "ok" });
    await expect(p).resolves.toBe("ok");
  });

  it("sendRaw 抛错 → reject SEND_FAILED + 清掉 pending", async () => {
    const failingSend = () => { throw new Error("net down"); };
    const client = new WsRpcClient(failingSend, () => true);
    const p = client.call("x");
    await expect(p).rejects.toMatchObject({ code: "SEND_FAILED", message: "net down" });
    expect(client.pendingCount()).toBe(0);
  });
});
