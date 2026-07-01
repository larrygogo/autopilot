/**
 * selfhosted-connector HTTP 后端客户端
 *
 * 封装所有对 reqgenie /api/selfhosted/* 端点的出站调用。
 * 与 runner/backend.ts 相同的 Bearer 鉴权模式，但端点语义全新。
 */

import type { SelfhostedCredentials, PendingAssignment, PendingCommand, CommandAck, MirrorEvent, MirrorSnapshot } from "./types";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "Content-Type": "application/json" };

function httpError(path: string, res: Response, extra = ""): Error {
  return new Error(`reqgenie ${path} 返回 ${res.status}${extra ? `：${extra}` : ""}`);
}

/** reqgenie 统一响应信封 `{success, data}`；兼容裸 payload */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export class SelfhostedBackend {
  private readonly base: string;

  constructor(
    private readonly creds: SelfhostedCredentials,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.base = creds.control_plane_url.replace(/\/+$/, "");
  }

  private auth(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.creds.secret}`,
      "x-instance-id": this.creds.instance_id,
    };
  }

  private instancePath(suffix: string): string {
    return `${this.base}/api/selfhosted/instances/${this.creds.instance_id}${suffix}`;
  }

  // ── 心跳 ──────────────────────────────────────

  async heartbeat(): Promise<void> {
    const url = this.instancePath("/heartbeat");
    const res = await this.fetchFn(url, { method: "POST", headers: this.auth() });
    if (!res.ok) throw httpError(url, res);
  }

  // ── 分配（assignments）──────────────────────

  /**
   * 长轮询拉待分配。204 → null（无活）；200 → PendingAssignment。
   * waitSeconds: 服务端挂起秒数（正常 50，测试 0）。
   */
  async claimAssignment(waitSeconds: number): Promise<PendingAssignment | null> {
    const url = this.instancePath(`/assignments/pending?wait=${waitSeconds}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(url, res);
    return unwrap<PendingAssignment>(await res.json());
  }

  /** 确认分配已接收并告知本机创建的 autopilot_req_id。 */
  async ackAssignment(assignmentId: string, autopilotReqId: string): Promise<void> {
    const url = this.instancePath(`/assignments/${assignmentId}/ack`);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify({ autopilot_req_id: autopilotReqId }),
    });
    if (!res.ok) throw httpError(url, res, await res.text().catch(() => ""));
  }

  // ── 镜像（mirror）──────────────────────────

  /**
   * 批量推送增量 mirror 事件。
   * 正常 200；409 = seq-gap（调用方需回退到 snapshot 重置基线）。
   */
  async postMirrorEvents(events: MirrorEvent[], autopilotReqId: string): Promise<{ seqGap: boolean }> {
    const url = this.instancePath("/mirror/events");
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify({ autopilot_req_id: autopilotReqId, events }),
    });
    if (res.status === 409) return { seqGap: true };
    if (!res.ok) throw httpError(url, res);
    return { seqGap: false };
  }

  /** 推送全量快照（重置 reqgenie 侧镜像基线）。 */
  async postMirrorSnapshot(snapshot: MirrorSnapshot): Promise<void> {
    const url = this.instancePath("/mirror/snapshot");
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) throw httpError(url, res, await res.text().catch(() => ""));
  }

  // ── 命令（commands）────────────────────────

  /**
   * 长轮询拉待执行命令。204 → null；200 → PendingCommand。
   */
  async claimCommand(waitSeconds: number): Promise<PendingCommand | null> {
    const url = this.instancePath(`/commands/pending?wait=${waitSeconds}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(url, res);
    return unwrap<PendingCommand>(await res.json());
  }

  /** 回传命令执行结果（ok=true 成功；ok=false 带 reason）。 */
  async ackCommand(commandId: string, ack: CommandAck): Promise<void> {
    const url = this.instancePath(`/commands/${commandId}/ack`);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify(ack),
    });
    if (!res.ok) throw httpError(url, res, await res.text().catch(() => ""));
  }

  // ── 注册（静态方法，注册时还没有 creds）──────

  /**
   * 一次性注册：注册 token 换长期凭证（instance_id + secret）。
   * 复用 reqgenie /api/selfhosted/instances/register 端点（与 runner register 同语义）。
   */
  static async register(
    controlPlaneUrl: string,
    registrationToken: string,
    name: string,
    fetchFn: FetchLike = fetch,
  ): Promise<{ instance_id: string; secret: string }> {
    const base = controlPlaneUrl.replace(/\/+$/, "");
    const url = `${base}/api/selfhosted/instances/register`;
    const machine_meta = {
      platform: process.platform,
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
    };
    const res = await fetchFn(url, {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ token: registrationToken, name, machine_meta }),
    });
    if (!res.ok) throw httpError(url, res, await res.text().catch(() => ""));
    const body = unwrap<{ instance_id: string; secret: string }>(await res.json());
    if (!body.instance_id || !body.secret) {
      throw new Error("register: reqgenie 未返回 instance_id/secret");
    }
    return body;
  }

  /** 优雅下线（best-effort，失败忽略）。 */
  async deregister(): Promise<void> {
    const url = this.instancePath("/deregister");
    try {
      await this.fetchFn(url, { method: "POST", headers: this.auth() });
    } catch {
      /* 下线 best-effort，忽略错误 */
    }
  }
}
