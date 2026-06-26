/**
 * selfhosted-mirror 测试
 *
 * 场景覆盖：
 * ① source ≠ 'reqgenie' 的需求状态变化不触发 POST
 * ② source='reqgenie' + callback_url 的需求到里程碑状态（queued/done/awaiting_review/failed）
 *    触发 POST，验证 URL、body、HMAC 签名头
 * ③ fetch 抛出时不向外抛出、不阻塞
 * ④ 同一需求同一状态只发一次（防重复）
 * ⑤ 非里程碑状态（clarifying/running 等）不触发 POST
 * ⑥ dispose 后不再发送
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "crypto";
import { _setDbForTest } from "../src/core/db";
import { enableBus, disableBus, emit } from "../src/core/event-bus";
import { up as migrate050 } from "../src/migrations/050-requirement-source-fields";

// ── DB 夹具 ────────────────────────────────────────────────────────────────────

function setupDb(): Database {
  const db = new Database(":memory:");

  // requirements 基础表
  db.run(`CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    workspace_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'drafting',
    spec_md TEXT NOT NULL DEFAULT '',
    chat_session_id TEXT,
    task_id TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    last_reviewed_event_id TEXT,
    active_question_id TEXT,
    clarifier_error TEXT,
    clarifier_provider TEXT,
    clarifier_model TEXT,
    schedule_error TEXT,
    status_reason TEXT,
    status_reason_source TEXT,
    status_before_terminal TEXT,
    workflow TEXT,
    input_mode TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);

  // 加 source/external_ref/callback_url/callback_secret 列（migration 050）
  migrate050(db);

  // requirement_sub_prs 表（listSubPrs 用）
  db.run(`CREATE TABLE requirement_sub_prs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id TEXT NOT NULL,
    child_workspace_id TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    last_reviewed_event_id TEXT,
    ci_failed_head_sha TEXT,
    ci_fix_count INTEGER DEFAULT 0,
    UNIQUE(requirement_id, child_workspace_id)
  )`);

  return db;
}

// ── 辅助：计算期望签名 ────────────────────────────────────────────────────────

function expectedSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe("selfhosted-mirror", () => {
  let db: Database;
  let dispose: (() => void) | null = null;

  // fetch mock：每个 it 用新 mock，通过 calls 数组断言
  let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    fetchCalls = [];
    // mock fetch：默认返回 200 OK
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    db = setupDb();
    _setDbForTest(db);
    enableBus();

    // 动态 import 保证每次测试拿到带 _sent 清零的 fresh module 实例
    // 注意：bun 会缓存模块，所以 _sent 跨 it 会累积；我们在 initSelfhostedMirror 的
    // dispose 里调了 _sent.clear()，afterEach dispose 确保清零
    const { initSelfhostedMirror } = await import("../src/daemon/selfhosted-mirror");
    dispose = initSelfhostedMirror();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    disableBus();
    globalThis.fetch = originalFetch;
  });

  // ── 辅助：插入需求 ────────────────────────────────────────────────────────
  function seedReq(opts: {
    id?: string;
    source?: string | null;
    external_ref?: string | null;
    callback_url?: string | null;
    callback_secret?: string | null;
    pr_url?: string | null;
  } = {}) {
    const id = opts.id ?? "req-1";
    db.run(
      `INSERT INTO requirements
         (id, project_id, title, status, source, external_ref, callback_url, callback_secret, pr_url, created_at, updated_at)
       VALUES (?, 'proj-1', '需求标题', 'drafting', ?, ?, ?, ?, ?, 0, 0)`,
      [
        id,
        opts.source ?? null,
        opts.external_ref ?? null,
        opts.callback_url ?? null,
        opts.callback_secret ?? null,
        opts.pr_url ?? null,
      ],
    );
    return id;
  }

  function seedSubPr(requirementId: string, prUrl: string, prNumber = 42): void {
    db.run(
      `INSERT INTO requirement_sub_prs (requirement_id, child_workspace_id, pr_url, pr_number, created_at)
       VALUES (?, 'ws-1', ?, ?, 0)`,
      [requirementId, prUrl, prNumber],
    );
  }

  // 等待所有 micro-task（async fetch）跑完
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  // ──────────────────────────────────────────────────────────────────────────
  // ① source ≠ 'reqgenie' 不触发 POST
  // ──────────────────────────────────────────────────────────────────────────
  it("source 为 null 的需求状态变化不触发 POST", async () => {
    seedReq({ source: null, external_ref: "ext-1", callback_url: "http://cb.example/hook" });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();
    expect(fetchCalls.length).toBe(0);
  });

  it("source 为其他字符串不触发 POST", async () => {
    seedReq({ source: "other_system", external_ref: "ext-1", callback_url: "http://cb.example/hook" });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "done" } });
    await flush();
    expect(fetchCalls.length).toBe(0);
  });

  it("source=reqgenie 但无 callback_url 不触发 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: "ext-1", callback_url: null });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();
    expect(fetchCalls.length).toBe(0);
  });

  it("source=reqgenie 但无 external_ref 不触发 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: null, callback_url: "http://cb.example/hook" });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();
    expect(fetchCalls.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ② 里程碑触发 POST（URL / body / 签名头）
  // ──────────────────────────────────────────────────────────────────────────
  it("queued 状态触发 POST，body 含 link_id + status", async () => {
    const cbUrl = "http://reqgenie.example/hook";
    seedReq({
      source: "reqgenie",
      external_ref: "rg-uuid-123",
      callback_url: cbUrl,
      callback_secret: "my-secret",
    });

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    expect(call.url).toBe(cbUrl);
    expect(call.init.method).toBe("POST");

    const body = JSON.parse(call.init.body as string) as Record<string, string>;
    expect(body.link_id).toBe("rg-uuid-123");
    expect(body.autopilot_req_id).toBe("req-1");
    expect(body.status).toBe("queued");
    expect(body.pr_url).toBeUndefined(); // queued 时不取 PR URL

    // 签名验证
    const sig = (call.init.headers as Record<string, string>)["X-Reqgenie-Signature"];
    expect(sig).toBe(expectedSignature(call.init.body as string, "my-secret"));
  });

  it("done 状态触发 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-abc", callback_url: "http://cb.example/hook" });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "awaiting_review", to: "done" } });
    await flush();
    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, string>;
    expect(body.status).toBe("done");
  });

  it("failed 状态触发 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-abc", callback_url: "http://cb.example/hook" });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "running", to: "failed" } });
    await flush();
    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, string>;
    expect(body.status).toBe("failed");
  });

  it("awaiting_review 状态触发 POST，并携带 pr_url（from sub_prs）", async () => {
    const cbUrl = "http://cb.example/hook";
    seedReq({ source: "reqgenie", external_ref: "rg-xyz", callback_url: cbUrl, callback_secret: "sec" });
    seedSubPr("req-1", "https://github.com/org/repo/pull/99", 99);

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "running", to: "awaiting_review" } });
    await flush();

    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, string>;
    expect(body.status).toBe("awaiting_review");
    expect(body.pr_url).toBe("https://github.com/org/repo/pull/99");
  });

  it("awaiting_review + pr_url 从 requirements.pr_url 降级获取（无 sub_prs 时）", async () => {
    seedReq({
      source: "reqgenie",
      external_ref: "rg-fallback",
      callback_url: "http://cb.example/hook",
      pr_url: "https://github.com/org/repo/pull/7",
    });

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "running", to: "awaiting_review" } });
    await flush();

    const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, string>;
    expect(body.pr_url).toBe("https://github.com/org/repo/pull/7");
  });

  it("无 secret 时不带签名头", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-nosec", callback_url: "http://cb.example/hook", callback_secret: null });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["X-Reqgenie-Signature"]).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ③ fetch 抛出时不向外抛出、不阻塞
  // ──────────────────────────────────────────────────────────────────────────
  it("fetch 抛出时不向外抛出（不影响主流程）", async () => {
    globalThis.fetch = mock(async () => { throw new Error("network error"); }) as unknown as typeof fetch;

    seedReq({ source: "reqgenie", external_ref: "rg-fail", callback_url: "http://cb.example/hook" });

    // 不应抛出
    expect(() => {
      emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    }).not.toThrow();

    await flush();
    // 测试到这里说明没有 unhandled rejection 导致测试崩溃
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ④ 防重复：同一需求同一状态只发一次
  // ──────────────────────────────────────────────────────────────────────────
  it("同一需求同一状态重复事件只发一次 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-dedup", callback_url: "http://cb.example/hook" });

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "queued", to: "queued" } }); // from 不同，to 相同
    await flush();

    expect(fetchCalls.length).toBe(1);
  });

  it("同一需求不同里程碑状态各发一次", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-multi", callback_url: "http://cb.example/hook" });

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "running", to: "awaiting_review" } });
    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "awaiting_review", to: "done" } });
    await flush();

    expect(fetchCalls.length).toBe(3);
    const statuses = fetchCalls.map((c) => (JSON.parse(c.init.body as string) as { status: string }).status);
    expect(statuses).toEqual(["queued", "awaiting_review", "done"]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ⑤ 非里程碑状态不触发 POST
  // ──────────────────────────────────────────────────────────────────────────
  it("clarifying / running / drafting 等非里程碑状态不触发 POST", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-skip", callback_url: "http://cb.example/hook" });

    for (const status of ["clarifying", "ready", "running", "drafting", "awaiting_approval"]) {
      emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "x", to: status } });
    }
    await flush();

    expect(fetchCalls.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ⑥ dispose 后不再发送
  // ──────────────────────────────────────────────────────────────────────────
  it("dispose 后不再发送回调", async () => {
    seedReq({ source: "reqgenie", external_ref: "rg-disp", callback_url: "http://cb.example/hook" });

    dispose?.();
    dispose = null;

    emit({ type: "requirement:status-changed", payload: { id: "req-1", from: "ready", to: "queued" } });
    await flush();

    expect(fetchCalls.length).toBe(0);
  });
});
