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

/** 拉取/回写的事件。回写时 runner 不带 seq（占位 0），后端定序后回填。 */
export interface SessionEvent {
  seq: number;
  type: SessionEventType;
  /** 文本载荷（assistant_message / user_message 等）。 */
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

/** GET /dev-sessions/{id} 返回的会话状态快照。 */
export interface SessionState {
  id: string;
  status: SessionStatus;
  current_stage: SessionStage;
  repos: SessionRepo[];
}

/** session 关联的仓库（dev_session_repos）。 */
export interface SessionRepo {
  repo_id: string;
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
