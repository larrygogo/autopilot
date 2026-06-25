// reqgenie dev_sessions 线协议类型（A 模式：autopilot 作为自托管 runner 消费）。
// 这些形状镜像 reqgenie 后端，不是 autopilot 自家 DB——勿与 src/core/db.ts Task/Requirement 混淆。

/** dev_sessions 阶段机阶段。 */
export type SessionStage = "clarify" | "spec" | "eng_review" | "ui_review" | "dev" | "pr" | "done";

/** dev_sessions 运行态。 */
export type SessionStatus =
  | "created" | "queued" | "running" | "waiting_input" | "waiting_gate"
  | "paused" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed", "failed", "cancelled",
]);

/** 事件类型（runner 产 + 后端产；seq/gate_id 一律后端定，runner 永不自定）。 */
export type SessionEventType =
  | "assistant_message"
  | "clarification_requested"
  | "stage_artifact"
  | "gate_opened"
  | "gate_decided"
  | "user_message"
  | "pr_created"
  | "limit_hit"
  | "session_failed";

/**
 * 拉取/回写的事件——**runner 域内的扁平形状**（消费/生产侧统一读 `type` + 顶层 text/gate_id/...）。
 * ⚠ 与 reqgenie **线协议**（`WireEvent`：`event_type` + 嵌套 `payload.*`）不同：归一在 `backend.ts`
 * 收口（拉时 wire→flat、推时 flat→wire），session-loop/rounds 只见此扁平形状。回写时 runner 不带 seq（占位 0），后端定序后回填。
 */
export interface SessionEvent {
  seq: number;
  type: SessionEventType;
  /** 文本载荷（assistant_message / user_message / gate_decided 评论 等）。 */
  text?: string;
  /** gate_opened/gate_decided 携带；runner 回写 gate_opened 不带，后端注入。 */
  gate_id?: string;
  /** gate_decided 的决定：approved | rejected。 */
  decision?: "approved" | "rejected";
  /** rejected 时携带的返工目标 stage（reqgenie rework_target_stage）。 */
  rework_target_stage?: SessionStage;
  /** stage_artifact 元信息。 */
  artifact?: { kind: string; content: string };
  /** pr_created 元信息。 */
  pr?: { repo: string; branch_name: string; pr_url: string };
  /** 透传的其他字段（围栏化由消费方负责）。 */
  [key: string]: unknown;
}

/**
 * reqgenie **线协议**事件形状（`/events` GET 返回项 / POST body）。后端事实源 = 052 迁移：
 * `event_type` 列 + 嵌套 `payload` jsonb（gate_id/decision/comment/message/kind/content/pr_url… 都在 payload 里）。
 * 仅 `backend.ts` 触碰此形状，归一为 `SessionEvent` 后才进 runner 域。
 */
export interface WireEvent {
  seq: number;
  event_type: string;
  stage?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * 线协议 → runner 扁平域（fetchEvents 收口）。把 reqgenie 嵌套 `payload.*` 提平到 `SessionEvent` 顶层字段：
 *  - comment / message → text（gate_decided 驳回评论 = payload.comment；user_message = payload.message）
 *  - gate_id / decision / rework_target_stage → 顶层同名
 *  - kind + content → artifact（stage_artifact）
 *  - repo / branch_name / pr_url → pr（pr_created）
 * 未知字段整包透传到顶层（围栏化由消费方负责）。
 */
export function wireToSessionEvent(w: WireEvent): SessionEvent {
  const p = w.payload ?? {};
  const ev: SessionEvent = { seq: w.seq, type: w.event_type as SessionEventType };
  // 文本载荷：assistant_message/clarification_requested 用 message；gate_decided 驳回评论用 comment。
  const text = p.comment ?? p.message ?? p.question ?? p.text;
  if (typeof text === "string") ev.text = text;
  if (typeof p.gate_id === "string") ev.gate_id = p.gate_id;
  if (p.decision === "approved" || p.decision === "rejected") ev.decision = p.decision;
  if (typeof p.rework_target_stage === "string") ev.rework_target_stage = p.rework_target_stage as SessionStage;
  if (typeof p.kind === "string" && typeof p.content === "string") ev.artifact = { kind: p.kind, content: p.content };
  if (typeof p.pr_url === "string") {
    ev.pr = {
      repo: typeof p.repo === "string" ? p.repo : "",
      branch_name: typeof p.branch_name === "string" ? p.branch_name : "",
      pr_url: p.pr_url,
    };
  }
  // 其余 payload 字段整包透传（不覆盖上面已提平的语义字段）。
  for (const [k, v] of Object.entries(p)) if (!(k in ev)) ev[k] = v;
  return ev;
}

/**
 * runner 扁平域 → 线协议 body（postEvent 收口）。把 `SessionEvent` 顶层语义字段塞回 reqgenie `payload`。
 * runner 永不自定 seq（剥离），gate_id 后端注入（gate_opened 回写不带）。
 */
export function sessionEventToWireBody(ev: SessionEvent): { event_type: string; stage?: string; actor: string; payload: Record<string, unknown> } {
  const { seq: _seq, type, text, gate_id, decision, rework_target_stage, artifact, pr, ...rest } = ev;
  const payload: Record<string, unknown> = { ...rest };
  if (text !== undefined) payload.message = text;
  if (gate_id !== undefined) payload.gate_id = gate_id;
  if (decision !== undefined) payload.decision = decision;
  if (rework_target_stage !== undefined) payload.rework_target_stage = rework_target_stage;
  if (artifact) { payload.kind = artifact.kind; payload.content = artifact.content; }
  if (pr) { payload.repo = pr.repo; payload.branch_name = pr.branch_name; payload.pr_url = pr.pr_url; }
  return { event_type: type, actor: "agent", payload };
}

/** GET /dev-sessions/{id} 返回的会话状态快照。 */
export interface SessionState {
  id: string;
  status: SessionStatus;
  current_stage: SessionStage;
  repos: SessionRepo[];
}

/** session 关联的仓库（dev_session_repos）。 */
export interface SessionRepo {
  /**
   * 托管库走 reqgenie git-token 鉴权；**自托管派生库为空**（null/undefined/空串）——
   * 此时 runner 不调 getGitToken、token 用空串走本机 git 凭证（executor 底层已支持空 token）。
   */
  repo_id?: string | null;
  /** 子目录别名（沙盒 codebase/<alias>/）。 */
  alias: string;
  remote_url: string;
  default_branch: string;
  /** 是否主库（submitPrPure primary 用）。 */
  primary?: boolean;
}

/** GET /sessions/pending 命中后返回的派发负载。 */
export interface PendingSession {
  session_id: string;
  /** claim 后 reqgenie 标 queued，runner 接管。 */
  current_stage: SessionStage;
  /** session 运行态（§14.6）。 */
  status?: SessionStatus;
}

/** 落盘的 runner 长期凭证。 */
export interface RunnerCredentials {
  control_plane_url: string;
  runner_id: string;
  secret: string;
}
