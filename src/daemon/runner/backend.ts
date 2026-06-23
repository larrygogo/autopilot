import type { RunnerCredentials, SessionEvent, SessionState, PendingSession, WireEvent } from "./types";
import { wireToSessionEvent, sessionEventToWireBody } from "./types";

/** 注入点：默认全局 fetch；测试桩可替换。 */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * 对 reqgenie 后端全部出站 HTTP 调用的抽象（§4.1/§4.2）。session-loop / poller 依赖此接口、
 * 不依赖具体 fetch，便于 mock 做移植保真测试（喂同一事件流、断言 seq 不自定 / gate_id 匹配）。
 */
export interface RunnerBackend {
  /** GET /events?after_seq=N —— 拉增量事件流（唯一事实源）。 */
  fetchEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
  /** POST /events —— 回写事件（不带 seq，后端定序 + 注入 gate_id），返回后端回填的 event。 */
  postEvent(sessionId: string, ev: SessionEvent): Promise<SessionEvent>;
  /** GET /dev-sessions/{id} —— 拉会话状态（检测终态 / 当前 stage）。 */
  getSession(sessionId: string): Promise<SessionState>;
  /** GET /git-token?repo_id= —— 现取 git 凭证（installation token；push 前现取防过期）。 */
  getGitToken(sessionId: string, repoId: string): Promise<string>;
  /** POST /dev-sessions/{id}/heartbeat —— session 心跳；409=终态（调用方优雅退出）。 */
  sessionHeartbeat(sessionId: string): Promise<{ terminal: boolean }>;
  /** POST /api/runners/{id}/heartbeat —— runner 级心跳（在线/离线）。 */
  runnerHeartbeat(): Promise<void>;
  /** GET /api/runners/{id}/sessions/pending?wait= —— 长轮询领待派 session；204→null。 */
  claimPending(waitSeconds: number): Promise<PendingSession | null>;
  /** POST /api/runners/{id}/deregister —— 优雅下线。 */
  deregister(): Promise<void>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** reqgenie 后端常见错误转成可读 Error（含 path / status）。 */
function httpError(path: string, res: Response, extra = ""): Error {
  return new Error(`reqgenie ${path} 返回 ${res.status}${extra ? `：${extra}` : ""}`);
}

/** reqgenie 统一响应信封 `{success, data}`；兼容裸 payload（旧测试桩 / 非信封后端）。 */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export class HttpRunnerBackend implements RunnerBackend {
  private readonly base: string;
  constructor(private readonly creds: RunnerCredentials, private readonly fetchFn: FetchLike = fetch) {
    this.base = creds.control_plane_url.replace(/\/+$/, "");
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.creds.secret}` };
  }
  private internal(sessionId: string, suffix: string): string {
    return `${this.base}/api/internal/dev-sessions/${sessionId}${suffix}`;
  }
  private runnerPath(suffix: string): string {
    return `${this.base}/api/runners/${this.creds.runner_id}${suffix}`;
  }

  async fetchEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]> {
    const url = this.internal(sessionId, `/events?after_seq=${afterSeq}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
    const body = await res.json();
    // 线协议事实源 = `{success, data: WireEvent[]}`；兼容旧测试桩 `{events: [...]}`。
    const rows = unwrap<WireEvent[]>(
      body && typeof body === "object" && "events" in (body as Record<string, unknown>) ? (body as { events: unknown }).events : body,
    );
    return Array.isArray(rows) ? rows.map(wireToSessionEvent) : [];
  }

  async postEvent(sessionId: string, ev: SessionEvent): Promise<SessionEvent> {
    const url = this.internal(sessionId, "/events");
    // runner 永不自定 seq（归一时已剥离）；扁平域 → 线协议 body（event_type + 嵌套 payload）。
    const wireBody = sessionEventToWireBody(ev);
    const res = await this.fetchFn(url, { method: "POST", headers: { ...this.auth(), ...JSON_HEADERS }, body: JSON.stringify(wireBody) });
    if (!res.ok) throw httpError(url, res);
    const body = await res.json();
    // 后端定 seq + 注入 gate_id；信封 `{data: WireEvent}`，兼容旧测试桩 `{event: ...}`。
    const row = unwrap<WireEvent>(
      body && typeof body === "object" && "event" in (body as Record<string, unknown>) ? (body as { event: unknown }).event : body,
    );
    return wireToSessionEvent(row);
  }

  async getSession(sessionId: string): Promise<SessionState> {
    const url = this.internal(sessionId, "");
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
    return unwrap<SessionState>(await res.json());
  }

  async getGitToken(sessionId: string, repoId: string): Promise<string> {
    const url = this.internal(sessionId, `/git-token?repo_id=${encodeURIComponent(repoId)}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
    const body = unwrap<{ token: string }>(await res.json());
    return body.token;
  }

  async sessionHeartbeat(sessionId: string): Promise<{ terminal: boolean }> {
    const url = this.internal(sessionId, "/heartbeat");
    const res = await this.fetchFn(url, { method: "POST", headers: this.auth() });
    if (res.status === 409) return { terminal: true }; // 终态
    if (!res.ok) throw httpError(url, res);
    return { terminal: false };
  }

  async runnerHeartbeat(): Promise<void> {
    const url = this.runnerPath("/heartbeat");
    const res = await this.fetchFn(url, { method: "POST", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
  }

  async claimPending(waitSeconds: number): Promise<PendingSession | null> {
    const url = this.runnerPath(`/sessions/pending?wait=${waitSeconds}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(url, res);
    return unwrap<PendingSession>(await res.json());
  }

  async deregister(): Promise<void> {
    const url = this.runnerPath("/deregister");
    try { await this.fetchFn(url, { method: "POST", headers: this.auth() }); } catch { /* 下线 best-effort */ }
  }

  /**
   * 一次性注册：注册 token（非 runner secret）换长期凭证。静态方法——注册时还没有 creds。
   */
  static async register(
    controlPlaneUrl: string,
    registrationToken: string,
    name: string,
    fetchFn: FetchLike = fetch,
  ): Promise<{ runner_id: string; secret: string }> {
    const base = controlPlaneUrl.replace(/\/+$/, "");
    const url = `${base}/api/runners/register`;
    const machine_meta = { platform: process.platform, hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "" };
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${registrationToken}`, ...JSON_HEADERS },
      body: JSON.stringify({ name, machine_meta }),
    });
    if (!res.ok) throw httpError(url, res, await res.text().catch(() => ""));
    const body = unwrap<{ runner_id: string; secret: string }>(await res.json());
    if (!body.runner_id || !body.secret) throw new Error("register: reqgenie 未返回 runner_id/secret");
    return body;
  }
}
