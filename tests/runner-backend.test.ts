import { test, expect } from "bun:test";
import { HttpRunnerBackend } from "../src/daemon/runner/backend";

function stubFetch(calls: Array<{ url: string; init?: RequestInit }>, responder: (url: string) => { status: number; body: unknown }) {
  return async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const { status, body } = responder(u);
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
}

const creds = { control_plane_url: "https://rg.example", runner_id: "rnr-1", secret: "sek" };

test("fetchEvents：GET /events?after_seq=N，带 runner bearer，解析 wire events 数组", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  // reqgenie 线协议 = `{success, data: [{seq, event_type, payload}]}`。
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { success: true, data: [{ seq: 5, event_type: "user_message", payload: { message: "hi" } }] } })));
  const evs = await be.fetchEvents("sess-1", 4);
  expect(evs).toHaveLength(1);
  expect(evs[0]!.seq).toBe(5);
  expect(evs[0]!.type).toBe("user_message"); // event_type → type
  expect(evs[0]!.text).toBe("hi");            // payload.message → text
  expect(calls[0]!.url).toBe("https://rg.example/api/internal/dev-sessions/sess-1/events?after_seq=4");
  expect((calls[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer sek");
  expect((calls[0]!.init!.headers as Record<string, string>)["x-runner-id"]).toBe("rnr-1"); // C3: B 双鉴权归属校验
});

test("postEvent：POST /events，body event_type + 嵌套 payload、不含 seq（后端定序），归一回填的 event", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { success: true, data: { seq: 9, event_type: "gate_opened", payload: { gate_id: "g-1" } } } })));
  const out = await be.postEvent("sess-1", { seq: 0, type: "gate_opened" });
  expect(out.seq).toBe(9);
  expect(out.gate_id).toBe("g-1"); // 后端注入，归一回顶层
  expect(calls[0]!.init!.method).toBe("POST");
  const sent = JSON.parse(String(calls[0]!.init!.body));
  expect(sent.seq).toBeUndefined();        // runner 永不自定 seq
  expect(sent.event_type).toBe("gate_opened"); // type → event_type（线协议）
});

test("claimPending：204 → null（无待派）", async () => {
  const be = new HttpRunnerBackend(creds, stubFetch([], () => ({ status: 204, body: null })));
  expect(await be.claimPending(50)).toBeNull();
});

test("claimPending：200 → PendingSession", async () => {
  const be = new HttpRunnerBackend(creds, stubFetch([], () => ({ status: 200, body: { session_id: "sess-2", current_stage: "clarify" } })));
  const p = await be.claimPending(50);
  expect(p?.session_id).toBe("sess-2");
});

test("getGitToken：GET /git-token?repo_id= 返回 token 字符串", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { token: "ghs_xxx" } })));
  expect(await be.getGitToken("sess-1", "repo-9")).toBe("ghs_xxx");
  expect(calls[0]!.url).toBe("https://rg.example/api/internal/dev-sessions/sess-1/git-token?repo_id=repo-9");
});

// ── major：wire（event_type + 嵌套 payload）↔ runner 扁平域（type + 顶层 text/...）归一 ──
// reqgenie 真实线协议 = `{success, data: [{seq, event_type, payload:{...}}]}`（C 的 MockControlPlane / B 后端）。
// backend.fetchEvents 必须把它归一成扁平 SessionEvent，否则 session-loop 读 ev.text/ev.gate_id 全空。

test("fetchEvents：归一 reqgenie 嵌套 payload → 扁平 SessionEvent（gate_decided 评论 = payload.comment → ev.text）", async () => {
  const wire = {
    success: true,
    data: [
      { seq: 5, event_type: "user_message", payload: { message: "用户补充" } },
      { seq: 6, event_type: "gate_decided", payload: { gate_id: "g-1", decision: "rejected", comment: "缺测试", rework_target_stage: "spec" } },
      { seq: 7, event_type: "stage_artifact", payload: { kind: "spec", content: "# 方案" } },
    ],
  };
  const be = new HttpRunnerBackend(creds, stubFetch([], () => ({ status: 200, body: wire })));
  const evs = await be.fetchEvents("sess-1", 4);
  expect(evs).toHaveLength(3);
  expect(evs[0]!.type).toBe("user_message");
  expect(evs[0]!.text).toBe("用户补充"); // payload.message → ev.text
  expect(evs[1]!.type).toBe("gate_decided");
  expect(evs[1]!.gate_id).toBe("g-1");
  expect(evs[1]!.decision).toBe("rejected");
  expect(evs[1]!.text).toBe("缺测试"); // payload.comment → ev.text（驳回评论不丢）
  expect(evs[1]!.rework_target_stage).toBe("spec");
  expect(evs[2]!.artifact).toEqual({ kind: "spec", content: "# 方案" }); // kind+content → artifact
});

test("postEvent：扁平 SessionEvent → wire body（type→event_type，顶层字段塞回 payload），不带 seq", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { success: true, data: { seq: 9, event_type: "gate_opened", payload: { gate_id: "g-2" } } } })));
  const out = await be.postEvent("sess-1", { seq: 0, type: "stage_artifact", artifact: { kind: "dev", content: "diff..." } });
  const sent = JSON.parse(String(calls[0]!.init!.body));
  expect(sent.seq).toBeUndefined();          // runner 永不自定 seq
  expect(sent.event_type).toBe("stage_artifact"); // type → event_type
  expect(sent.payload.kind).toBe("dev");     // artifact 提回 payload
  expect(sent.payload.content).toBe("diff...");
  // 响应（信封 {data: WireEvent}）归一回扁平 + 后端注入 gate_id
  expect(out.seq).toBe(9);
  expect(out.type).toBe("gate_opened");
  expect(out.gate_id).toBe("g-2");
});

test("getSession：解 {success, data} 信封", async () => {
  const be = new HttpRunnerBackend(creds, stubFetch([], () => ({ status: 200, body: { success: true, data: { id: "sess-1", status: "running", current_stage: "spec", repos: [] } } })));
  const s = await be.getSession("sess-1");
  expect(s.id).toBe("sess-1");
  expect(s.current_stage).toBe("spec");
});

test("register：POST /api/runners/register 用注册 token（非 runner secret）换凭证", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out = await HttpRunnerBackend.register("https://rg.example", "reg-token-abc", "my-mac", [], stubFetch(calls, () => ({ status: 200, body: { runner_id: "rnr-7", secret: "newsek" } })));
  expect(out.runner_id).toBe("rnr-7");
  expect(out.secret).toBe("newsek");
  expect(calls[0]!.url).toBe("https://rg.example/api/runners/register");
  // C5：注册 token 走 JSON body（对齐真 reqgenie RunnerRegisterRequest{token}），不放 Authorization 头
  const sent = JSON.parse(String(calls[0]!.init!.body)) as { token?: string; name?: string };
  expect(sent.token).toBe("reg-token-abc");
  expect(sent.name).toBe("my-mac");
  expect((calls[0]!.init!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  // register 尚无 runner_id，不能带 x-runner-id（静态方法，不经 auth()）
  expect((calls[0]!.init!.headers as Record<string, string>)["x-runner-id"]).toBeUndefined();
});
