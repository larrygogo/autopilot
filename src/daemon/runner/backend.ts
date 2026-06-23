import type { RunnerCredentials, SessionEvent, SessionState, PendingSession } from "./types";

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
    const body = (await res.json()) as { events?: SessionEvent[] };
    return Array.isArray(body.events) ? body.events : [];
  }

  async postEvent(sessionId: string, ev: SessionEvent): Promise<SessionEvent> {
    const url = this.internal(sessionId, "/events");
    // runner 永不自定 seq：剥离 seq 字段，后端定序后回填。
    const { seq: _drop, ...payload } = ev;
    const res = await this.fetchFn(url, { method: "POST", headers: { ...this.auth(), ...JSON_HEADERS }, body: JSON.stringify(payload) });
    if (!res.ok) throw httpError(url, res);
    const body = (await res.json()) as { event: SessionEvent };
    return body.event;
  }

  async getSession(sessionId: string): Promise<SessionState> {
    const url = this.internal(sessionId, "");
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
    return (await res.json()) as SessionState;
  }

  async getGitToken(sessionId: string, repoId: string): Promise<string> {
    const url = this.internal(sessionId, `/git-token?repo_id=${encodeURIComponent(repoId)}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
    const body = (await res.json()) as { token: string };
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
    return (await res.json()) as PendingSession;
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
    const body = (await res.json()) as { runner_id: string; secret: string };
    if (!body.runner_id || !body.secret) throw new Error("register: reqgenie 未返回 runner_id/secret");
    return body;
  }
}
