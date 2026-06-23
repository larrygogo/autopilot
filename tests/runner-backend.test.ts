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

test("fetchEvents：GET /events?after_seq=N，带 runner bearer，解析 events 数组", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { events: [{ seq: 5, type: "user_message", text: "hi" }] } })));
  const evs = await be.fetchEvents("sess-1", 4);
  expect(evs).toHaveLength(1);
  expect(evs[0]!.seq).toBe(5);
  expect(calls[0]!.url).toBe("https://rg.example/api/internal/dev-sessions/sess-1/events?after_seq=4");
  expect((calls[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer sek");
});

test("postEvent：POST /events，body 不含 seq（后端定序），返回后端回填的 event", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const be = new HttpRunnerBackend(creds, stubFetch(calls, () => ({ status: 200, body: { event: { seq: 9, type: "gate_opened", gate_id: "g-1" } } })));
  const out = await be.postEvent("sess-1", { seq: 0, type: "gate_opened" });
  expect(out.seq).toBe(9);
  expect(out.gate_id).toBe("g-1");
  expect(calls[0]!.init!.method).toBe("POST");
  const sent = JSON.parse(String(calls[0]!.init!.body));
  expect(sent.seq).toBeUndefined(); // runner 永不自定 seq
  expect(sent.type).toBe("gate_opened");
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

test("register：POST /api/runners/register 用注册 token（非 runner secret）换凭证", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out = await HttpRunnerBackend.register("https://rg.example", "reg-token-abc", "my-mac", stubFetch(calls, () => ({ status: 200, body: { runner_id: "rnr-7", secret: "newsek" } })));
  expect(out.runner_id).toBe("rnr-7");
  expect(out.secret).toBe("newsek");
  expect(calls[0]!.url).toBe("https://rg.example/api/runners/register");
  expect((calls[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer reg-token-abc");
});
