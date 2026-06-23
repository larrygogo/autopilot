// tests/runner-mock-control-plane.test.ts
// Task 2：mock control-plane 自验。鉴权契约对齐 spec §14.1/§15.3：内部 API = per-runner secret + x-runner-id +
// 归属校验（不用全局 worker secret）；register 经 Authorization: Bearer <regToken> 头（与 A2 backend.ts 一致）。
import { test, expect, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { MockControlPlane } from "../scripts/runner/mock-control-plane";

// 前置守卫（plan 修正：缺 A2 则报前置阻塞而非测试失败）。Task 2 的 mock 是 A2 客户端的被测对端。
const A2_SESSION_LOOP = join(import.meta.dir, "../src/daemon/runner/session-loop.ts");
if (!existsSync(A2_SESSION_LOOP)) {
  throw new Error(`前置阻塞：A2 未落地（缺 ${A2_SESSION_LOOP}），请先完成 A2 计划。`);
}

let cp: MockControlPlane | null = null;
afterEach(async () => {
  if (cp) {
    await cp.stop();
    cp = null;
  }
});

test("注册换凭证（token 走 JSON body，与真后端 RunnerRegisterRequest 一致）+ 一次性消费", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const regTok = cp.issueRegistrationToken();
  const reg = await fetch(`${cp.url}/api/runners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: regTok, name: "t1", machine_meta: {} }),
  });
  const body = (await reg.json()) as { data: { runner_id: string; secret: string } };
  expect(body.data.runner_id).toBeTruthy();
  expect(body.data.secret).toBeTruthy();
  // 一次性：同 token 再注册 401
  const again = await fetch(`${cp.url}/api/runners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: regTok, name: "t2", machine_meta: {} }),
  });
  expect(again.status).toBe(401);
});

test("register 只认 body.token：token 放 Authorization 头 → 401（捕获 A2↔B header-vs-body 漂移）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const regTok = cp.issueRegistrationToken();
  // 模拟「A2 把 token 放进 header、body 缺 token」的错误形态——真后端会因缺必填 token 反序列化失败/拒绝，mock 同样 401。
  const reg = await fetch(`${cp.url}/api/runners/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regTok}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "t1", machine_meta: {} }),
  });
  expect(reg.status).toBe(401);
});

test("派 session → /sessions/pending 原子 claim 只一次返回 payload（含 status=queued）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: runnerId, repos: [], stage: "clarify" });
  const h = { authorization: `Bearer ${secret}`, "x-runner-id": runnerId };
  const r1 = await fetch(`${cp.url}/api/runners/${runnerId}/sessions/pending?wait=0`, { headers: h });
  expect(r1.status).toBe(200);
  const claimed = (await r1.json()) as { data: { session_id: string; status: string; current_stage: string } };
  expect(claimed.data.session_id).toBe(sid);
  expect(claimed.data.status).toBe("queued"); // claim 翻 created→queued（C1 DTO）
  expect(claimed.data.current_stage).toBe("clarify");
  // 再领 → 无待派 → 204
  const r2 = await fetch(`${cp.url}/api/runners/${runnerId}/sessions/pending?wait=0`, { headers: h });
  expect(r2.status).toBe(204);
});

test("回写事件（内部 API：per-runner secret + x-runner-id + 归属校验）：后端定 seq + gate_opened 注入 gate_id", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const base = cp.url; // 捕获到 const，闭包内不依赖可空的 module-level cp
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: runnerId, repos: [], stage: "spec" });
  const post = (ev: object) =>
    fetch(`${base}/api/internal/dev-sessions/${sid}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-runner-id": runnerId, "content-type": "application/json" },
      body: JSON.stringify(ev),
    }).then((r) => r.json() as Promise<{ data: { seq: number; payload: Record<string, unknown> } }>);
  const e1 = await post({ event_type: "assistant_message", stage: "spec", actor: "agent", payload: { message: "x" } });
  const e2 = await post({ event_type: "gate_opened", stage: "spec", actor: "agent", payload: { stage: "spec" } });
  expect(e2.data.seq).toBeGreaterThan(e1.data.seq);
  expect(e2.data.payload.gate_id).toBeTruthy(); // 后端注入

  // 鉴权负路径：缺 x-runner-id → 401；非归属 runner → 401。
  const noHeader = await fetch(`${base}/api/internal/dev-sessions/${sid}/events?after_seq=0`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(noHeader.status).toBe(401);
  const other = await cp.registerRunner("r2");
  const wrongOwner = await fetch(`${base}/api/internal/dev-sessions/${sid}/events?after_seq=0`, {
    headers: { authorization: `Bearer ${other.secret}`, "x-runner-id": other.runnerId },
  });
  expect(wrongOwner.status).toBe(401); // r2 非该 session 归属
});

test("裁决 gate / 取消 session 走事件流（驳回评论落 gate_decided.payload.comment）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: runnerId, repos: [], stage: "spec" });
  const h = { authorization: `Bearer ${secret}`, "x-runner-id": runnerId, "content-type": "application/json" };
  const opened = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ event_type: "gate_opened", stage: "spec", actor: "agent", payload: { stage: "spec" } }),
  }).then((r) => r.json() as Promise<{ data: { payload: { gate_id: string } } }>);
  cp.decideGate(sid, opened.data.payload.gate_id, "rejected", "缺测试");
  const evs = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events?after_seq=0`, {
    headers: { authorization: `Bearer ${secret}`, "x-runner-id": runnerId },
  }).then((r) => r.json() as Promise<{ data: Array<{ event_type: string; payload: Record<string, unknown> }> }>);
  const decided = evs.data.find((e) => e.event_type === "gate_decided");
  expect(decided).toBeTruthy();
  expect(decided!.payload.decision).toBe("rejected");
  expect(decided!.payload.comment).toBe("缺测试"); // §14.4：评论在 gate_decided.payload.comment
});

test("摄取 limit_hit → session 置 failed（§14.2，与 session_failed 同语义，对齐 dev_session_service.rs）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: runnerId, repos: [], stage: "dev" });
  const h = { authorization: `Bearer ${secret}`, "x-runner-id": runnerId, "content-type": "application/json" };
  await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ event_type: "limit_hit", stage: "dev", actor: "agent", payload: { reason: "STAGE_MAX" } }),
  });
  expect(cp.sessionStatus(sid)!.status).toBe("failed");
  // 终态后再回写事件被拒（409）。
  const after = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ event_type: "assistant_message", stage: "dev", actor: "agent", payload: {} }),
  });
  expect(after.status).toBe(409);
});

test("claimAny：任意在线 runner 可领 created session（解决脚本拿不到 daemon 真实 runner_id）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  cp.enableClaimAny();
  // dispatch 用占位 assignedRunner（脚本不知道 daemon 自注册的 runner_id）。
  const sid = cp.dispatchSession({ assignedRunner: "placeholder", repos: [], stage: "clarify" });
  const { runnerId, secret } = await cp.registerRunner("daemon-runner");
  const h = { authorization: `Bearer ${secret}`, "x-runner-id": runnerId };
  const r = await fetch(`${cp.url}/api/runners/${runnerId}/sessions/pending?wait=0`, { headers: h });
  expect(r.status).toBe(200);
  const claimed = (await r.json()) as { data: { session_id: string } };
  expect(claimed.data.session_id).toBe(sid);
  // claimAny 领走后归属本 runner → 内部 API 归属校验放行。
  const get = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}`, { headers: h });
  expect(get.status).toBe(200);
});

test("内部 GET 会话状态返回 C2 形状：{id,status,current_stage,repos[]}（repos 元素含 repo_id/alias/remote_url/default_branch/primary）", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({
    assignedRunner: runnerId,
    repos: [
      { repo_id: "rp-1", alias: "main", remote_url: "https://github.com/o/r.git", default_branch: "main", primary: true },
    ],
    stage: "dev",
  });
  const s = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}`, {
    headers: { authorization: `Bearer ${secret}`, "x-runner-id": runnerId },
  }).then((r) => r.json() as Promise<{ data: { id: string; status: string; current_stage: string; repos: Array<Record<string, unknown>> } }>);
  expect(s.data.id).toBe(sid);
  expect(s.data.current_stage).toBe("dev");
  expect(s.data.repos).toHaveLength(1);
  expect(s.data.repos[0]).toEqual({
    repo_id: "rp-1",
    alias: "main",
    remote_url: "https://github.com/o/r.git",
    default_branch: "main",
    primary: true,
  });
});
