// 内存版 reqgenie control-plane —— 实现 spec §4 协议子集，供 autopilot runner-smoke / 契约测试当被测对端。
// 无 PG / 无飞书 / 无 GitHub。seq 后端定、gate_id 后端注入，与真 reqgenie 行为对齐（dev_session_http.rs 契约）。
//
// 鉴权边界（spec §14.1 + §15.3，覆盖旧草稿的「内部 API 用全局 worker secret」写法）：
//  - runner 专有端点（register / heartbeat / sessions/pending / deregister）= per-runner secret bearer。
//  - 内部 session API（/api/internal/dev-sessions/{id}/events|git-token|heartbeat|GET）= **per-runner secret +
//    x-runner-id 头 + 会话归属校验**（session.assigned_runner == x-runner-id）。全局 worker secret **绝不**
//    下发到 runner 机器，故 mock 也不用它（真后端的全局 codex worker 路径不在 A 模式被测范围内）。
//
// DTO 契约（spec §15，与 A2 src/daemon/runner/backend.ts + types.ts 逐字段对齐）：
//  - register 请求 body = {token, name, machine_meta}（token 走 JSON body，与真后端 RunnerRegisterRequest 一致——
//    handler 不读 Authorization 头）；响应 data = {runner_id, secret}。mock 只认 body.token，不回退 header，
//    故 A2 若把 token 放 header 会 401，离线契约测试当场捕获漂移（见 §15 + routes/runners.rs::register）。
//  - pending claim 命中 data = {session_id, current_stage, status="queued"}（C1，非裸 ORM）。
//  - GET /api/internal/dev-sessions/{id} data = {id, status, current_stage, repos[]}，
//    repos 元素 = {repo_id, alias, remote_url, default_branch, primary}（C2）。
//  - POST /events 响应 data = WireEvent {seq, event_type, stage, actor, payload}（后端定 seq + 注入 gate_id）。
//  - GET /events 响应 data = WireEvent[]（after_seq 过滤、升序）。
import { randomUUID } from "crypto";

/** session 关联仓库（dev_session_repos JOIN github_repos，spec §15.2 形状）。 */
export interface MockSessionRepo {
  repo_id: string;
  alias: string;
  remote_url: string;
  default_branch: string;
  primary?: boolean;
}

interface SessionState {
  id: string;
  assigned_runner: string;
  status: string; // created|queued|running|waiting_input|waiting_gate|paused|completed|failed|cancelled
  current_stage: string; // clarify|spec|eng_review|ui_review|dev|pr|done
  spec_md: string | null;
  pr_url: string | null;
  repos: MockSessionRepo[];
}
/** 内存事件行 = reqgenie 线协议 WireEvent（seq + event_type + 嵌套 payload）。 */
interface EventRow {
  seq: number;
  event_type: string;
  stage: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STAGE_ORDER = ["clarify", "spec", "eng_review", "ui_review", "dev", "pr", "done"];

export class MockControlPlane {
  #server: ReturnType<typeof Bun.serve> | null = null;
  #regTokens = new Map<string, boolean>(); // token -> consumed
  #runners = new Map<string, { secret: string; name: string; lastHeartbeat: number; revoked: boolean }>();
  #sessions = new Map<string, SessionState>();
  #events = new Map<string, EventRow[]>();
  #seq = new Map<string, number>();
  #gates = new Map<string, { sessionId: string; stage: string; status: string }>(); // gate_id -> gate
  #gitToken: string | null = null; // injectGitToken 设了才返回
  // claimAny（top-of-plan 修正 #2）：开启后任意在线 runner 可领任意 created session（不限 assigned_runner）。
  // runner-smoke 用它解决「脚本拿不到 daemon 内真实 runner_id」——daemon 自注册的 runner_id 脚本看不见，
  // 故 dispatch 时填占位 assignedRunner，enableClaimAny() 后 daemon 仍能领到。
  #claimAny = false;

  get url(): string {
    if (!this.#server) throw new Error("control-plane 未启动");
    return `http://127.0.0.1:${this.#server.port}`;
  }

  async start(port = 0): Promise<void> {
    this.#server = Bun.serve({ port, fetch: (req) => this.#handle(req) });
  }
  async stop(): Promise<void> {
    if (this.#server) {
      this.#server.stop(true);
      this.#server = null;
    }
  }

  // ── 脚本化驱动（测试 / smoke 用，非 HTTP）──
  /** 颁发一次性注册 token（真后端 admin `runner_manage` 路径的内存替身）。 */
  issueRegistrationToken(): string {
    const t = randomUUID();
    this.#regTokens.set(t, false);
    return t;
  }
  /** 撤销某 runner 凭证（reaper / admin revoke 替身）：之后用其 secret 调用一律 401。 */
  revokeRunner(runnerId: string): void {
    const r = this.#runners.get(runnerId);
    if (r) r.revoked = true;
  }
  /** 便捷注册：颁 token → 调真 register 端点换凭证（token 走 JSON body，与真后端 RunnerRegisterRequest 一致）。 */
  async registerRunner(name: string): Promise<{ runnerId: string; secret: string }> {
    const tok = this.issueRegistrationToken();
    const r = await fetch(`${this.url}/api/runners/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tok, name, machine_meta: {} }),
    });
    const b = (await r.json()) as { data: { runner_id: string; secret: string } };
    return { runnerId: b.data.runner_id, secret: b.data.secret };
  }
  /** 开启 claimAny（top-of-plan 修正 #2）：任意在线 runner 可领任意 created session。 */
  enableClaimAny(): void {
    this.#claimAny = true;
  }
  dispatchSession(opts: { assignedRunner: string; repos: MockSessionRepo[]; stage?: string }): string {
    const id = randomUUID();
    const stage = opts.stage ?? "clarify";
    this.#sessions.set(id, {
      id,
      assigned_runner: opts.assignedRunner,
      status: "created",
      current_stage: stage,
      spec_md: null,
      pr_url: null,
      repos: opts.repos,
    });
    this.#events.set(id, []);
    this.#seq.set(id, 0);
    this.#appendEvent(id, "stage_change", stage, "agent", { to: stage });
    return id;
  }
  decideGate(sessionId: string, gateId: string, decision: "approved" | "rejected", comment = ""): void {
    const g = this.#gates.get(gateId);
    if (!g || g.sessionId !== sessionId || g.status !== "pending") throw new Error(`gate ${gateId} 不可裁决`);
    g.status = decision;
    // 驳回评论放进 gate_decided.payload.comment（spec §14.4，对齐 agent-worker，不另追 user_message）。
    this.#appendEvent(sessionId, "gate_decided", g.stage, "user", { gate_id: gateId, decision, comment });
    const s = this.#sessions.get(sessionId)!;
    if (decision === "approved") {
      const idx = STAGE_ORDER.indexOf(s.current_stage);
      const next = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)]!;
      s.current_stage = next;
      s.status = next === "done" ? "completed" : "running";
    } else {
      s.status = "running"; // 留本 stage 带评论重做
    }
  }
  injectUserMessage(sessionId: string, message: string, byName = "tester"): void {
    this.#appendEvent(sessionId, "user_message", null, "user", { message, by_name: byName });
    const s = this.#sessions.get(sessionId);
    if (s && s.status === "waiting_input") s.status = "running";
  }
  cancelSession(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.status = "cancelled";
    this.#appendEvent(sessionId, "session_cancelled", null, "user", { by_name: "tester" });
  }
  /** 模拟 runner 心跳超时被 reaper 回收：session 回退 created、保留 assigned_runner（spec §4.2 拉模型回收）。 */
  reapStaleRunner(runnerId: string): void {
    for (const s of this.#sessions.values()) {
      if (s.assigned_runner === runnerId && !TERMINAL.has(s.status) && s.status !== "created") s.status = "created";
    }
  }
  injectGitToken(token: string): void {
    this.#gitToken = token;
  }
  sessionStatus(id: string): SessionState | undefined {
    return this.#sessions.get(id);
  }
  events(id: string): EventRow[] {
    return this.#events.get(id) ?? [];
  }

  // ── 内部 ──
  #appendEvent(
    sid: string,
    event_type: string,
    stage: string | null,
    actor: string | null,
    payload: Record<string, unknown>,
  ): EventRow {
    const seq = (this.#seq.get(sid) ?? 0) + 1;
    this.#seq.set(sid, seq);
    const p = { ...payload };
    if (event_type === "gate_opened") {
      const gateId = randomUUID();
      this.#gates.set(gateId, { sessionId: sid, stage: stage ?? "", status: "pending" });
      p.gate_id = gateId; // 后端注入 gate_id（runner 回写不带）
      const s = this.#sessions.get(sid);
      if (s) s.status = "waiting_gate";
    }
    if (event_type === "clarification_requested") {
      const s = this.#sessions.get(sid);
      if (s) s.status = "waiting_input";
    }
    if (event_type === "stage_artifact" && payload.kind === "spec") {
      const s = this.#sessions.get(sid);
      if (s) s.spec_md = String(payload.content ?? "");
    }
    if (event_type === "pr_created") {
      // B 摄取分支：写 pr_url + session 收口 done/completed（spec §5.2 + §14）。
      const s = this.#sessions.get(sid);
      if (s) {
        s.pr_url = String(payload.pr_url ?? "");
        s.current_stage = "done";
        s.status = "completed";
      }
    }
    if (event_type === "session_failed" || event_type === "limit_hit") {
      // B 摄取补分支（spec §14.2，对齐 dev_session_service.rs:637-644）：成本闸门触顶让大脑可见——
      // session_failed 与 limit_hit 同语义，均置 session failed（不静默退出）。
      const s = this.#sessions.get(sid);
      if (s) s.status = "failed";
    }
    const row: EventRow = { seq, event_type, stage, actor, payload: p };
    this.#events.get(sid)!.push(row);
    return row;
  }
  #bearer(req: Request): string | null {
    const h = req.headers.get("authorization");
    return h?.startsWith("Bearer ") ? h.slice(7) : null;
  }
  #runnerBySecret(secret: string | null): string | null {
    if (!secret) return null;
    for (const [id, r] of this.#runners) if (r.secret === secret && !r.revoked) return id;
    return null;
  }
  /**
   * 内部 session API 双鉴权 + 归属校验（spec §14.1 + §15.3）：
   *  - bearer = per-runner secret（活跃、未撤销）。
   *  - x-runner-id 头 == 该 secret 对应 runner_id（防张冠李戴）。
   *  - session.assigned_runner == 调用 runner（claimAny 开时放宽：任意在线 runner 可访问）。
   * 返回 runner_id（通过）或 null（拒绝）。
   */
  #authInternal(req: Request, session: SessionState): string | null {
    const rid = this.#runnerBySecret(this.#bearer(req));
    if (!rid) return null;
    const headerRid = req.headers.get("x-runner-id");
    if (headerRid !== rid) return null; // x-runner-id 必须与 secret 主体一致
    if (!this.#claimAny && session.assigned_runner !== rid) return null; // 归属校验
    return rid;
  }
  async #handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ success: status < 400, data }), {
        status,
        headers: { "content-type": "application/json" },
      });

    // ── 注册（token 走 JSON body，与真后端 routes/runners.rs::register 一致：Json(RunnerRegisterRequest{token,name,machine_meta})，
    //    handler 完全不读 Authorization 头。**故意只认 body.token、不回退 header**——若 A2 把 token 放进 header 会因缺
    //    必填 token 而 401，让离线契约测试当场捕获 A2↔B 漂移，而非假绿。）──
    if (req.method === "POST" && u.pathname === "/api/runners/register") {
      const b = (await req.json().catch(() => ({}))) as { name?: string; token?: string; machine_meta?: unknown };
      const tok = b.token ?? "";
      if (!this.#regTokens.has(tok) || this.#regTokens.get(tok) === true) {
        return json({ error: "token 无效或已消费" }, 401);
      }
      this.#regTokens.set(tok, true); // 一次性消费
      const runnerId = randomUUID();
      const secret = randomUUID();
      this.#runners.set(runnerId, { secret, name: b.name ?? "", lastHeartbeat: Date.now(), revoked: false });
      return json({ runner_id: runnerId, secret });
    }
    // ── runner 心跳（per-runner secret）──
    const hbMatch = u.pathname.match(/^\/api\/runners\/([^/]+)\/heartbeat$/);
    if (req.method === "POST" && hbMatch) {
      const rid = this.#runnerBySecret(this.#bearer(req));
      if (!rid) return json({ error: "unauthorized" }, 401);
      this.#runners.get(rid)!.lastHeartbeat = Date.now();
      return json({});
    }
    // ── 优雅下线（per-runner secret）──
    const deregMatch = u.pathname.match(/^\/api\/runners\/([^/]+)\/deregister$/);
    if (req.method === "POST" && deregMatch) {
      const rid = this.#runnerBySecret(this.#bearer(req));
      if (!rid) return json({ error: "unauthorized" }, 401);
      return json({});
    }
    // ── 长轮询领待派 + 原子 claim（per-runner secret；claimAny 时不限 assigned_runner）──
    const pendMatch = u.pathname.match(/^\/api\/runners\/([^/]+)\/sessions\/pending$/);
    if (req.method === "GET" && pendMatch) {
      const rid = this.#runnerBySecret(this.#bearer(req));
      if (!rid) return json({ error: "unauthorized" }, 401);
      const claimable = [...this.#sessions.values()].find(
        (s) => (this.#claimAny || s.assigned_runner === rid) && s.status === "created",
      );
      if (!claimable) return new Response(null, { status: 204 });
      claimable.status = "queued"; // 原子 claim（内存单线程，天然原子）
      if (this.#claimAny) claimable.assigned_runner = rid; // claimAny：领走即归属本 runner
      return json({ session_id: claimable.id, current_stage: claimable.current_stage, status: claimable.status });
    }

    // ── 内部 session API（per-runner secret + x-runner-id + 归属校验，spec §14.1/§15.3）──
    const evMatch = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/events$/);
    if (evMatch) {
      const sid = evMatch[1]!;
      const s = this.#sessions.get(sid);
      if (!s) return json({ error: "not found" }, 404);
      if (!this.#authInternal(req, s)) return json({ error: "unauthorized" }, 401);
      if (req.method === "POST") {
        if (TERMINAL.has(s.status)) return json({ error: "终态会话拒绝事件" }, 409);
        const b = (await req.json()) as {
          event_type: string;
          stage?: string;
          actor?: string;
          payload?: Record<string, unknown>;
        };
        if (s.status === "queued") s.status = "running";
        const row = this.#appendEvent(sid, b.event_type, b.stage ?? null, b.actor ?? "agent", b.payload ?? {});
        return json(row);
      }
      if (req.method === "GET") {
        const after = Number(u.searchParams.get("after_seq") ?? 0);
        return json((this.#events.get(sid) ?? []).filter((e) => e.seq > after));
      }
    }
    const sGet = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)$/);
    if (sGet && req.method === "GET") {
      const s = this.#sessions.get(sGet[1]!);
      if (!s) return json({ error: "not found" }, 404);
      if (!this.#authInternal(req, s)) return json({ error: "unauthorized" }, 401);
      // C2 形状：{id, status, current_stage, repos[]}（repos 元素 spec §15.2）。
      return json({ id: s.id, status: s.status, current_stage: s.current_stage, repos: s.repos });
    }
    const sHb = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/heartbeat$/);
    if (sHb && req.method === "POST") {
      const s = this.#sessions.get(sHb[1]!);
      if (!s) return json({ error: "not found" }, 404);
      if (!this.#authInternal(req, s)) return json({ error: "unauthorized" }, 401);
      if (TERMINAL.has(s.status)) return json({ error: "终态" }, 409);
      return json({});
    }
    const gitTok = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/git-token$/);
    if (gitTok && req.method === "GET") {
      const s = this.#sessions.get(gitTok[1]!);
      if (!s) return json({ error: "not found" }, 404);
      if (!this.#authInternal(req, s)) return json({ error: "unauthorized" }, 401);
      if (this.#gitToken == null) return json({ error: "无 git 凭据" }, 400);
      return json({ token: this.#gitToken, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    return json({ error: `未实现：${req.method} ${u.pathname}` }, 404);
  }
}

// 直接运行：起一个 control-plane 供手动联调（端口固定 3099）
if (import.meta.main) {
  const cp = new MockControlPlane();
  await cp.start(3099);
  console.log(`mock control-plane 起在 ${cp.url}（Ctrl-C 退出）`);
}
