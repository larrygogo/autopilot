/**
 * selfhosted-connector 类型定义
 *
 * autopilot 实例通过此连接器向 reqgenie 注册、接收分配、推全状态镜像、接收命令回传。
 * 与 A 模式（runner/types.ts 的 dev_sessions 线协议）完全独立——端点 /api/selfhosted/*，
 * 业务语义 = 「B-interactive 双向连接」，非「reqgenie 会话执行」。
 */

// ────────────────────────────────────────────────────
// 凭证（复用 runner 凭证结构，落盘路径独立）
// ────────────────────────────────────────────────────

/** selfhosted 实例的长期凭证（注册到 reqgenie 后落盘） */
export interface SelfhostedCredentials {
  control_plane_url: string;
  /** reqgenie 分配的实例 ID（复用 runners 表 id） */
  instance_id: string;
  /** Bearer token（HMAC secret，注册时颁发） */
  secret: string;
}

// ────────────────────────────────────────────────────
// 分配（assignments）
// ────────────────────────────────────────────────────

/** GET /assignments/pending 命中后的分配载荷 */
export interface PendingAssignment {
  assignment_id: string;
  reqgenie_req_id: string;
  title: string;
  spec_md: string;
  repo_urls: string[];
  project_hint?: string | null;
}

// ────────────────────────────────────────────────────
// 命令（commands）
// ────────────────────────────────────────────────────

/** GET /commands/pending 命中后的命令载荷 */
export interface PendingCommand {
  command_id: string;
  autopilot_req_id: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
}

export type CommandKind =
  | "answer_clarification"
  | "finish_clarification"
  | "retry_clarify"
  | "approve"
  | "reject"
  | "accept"
  | "cancel"
  | "set_workspaces";

/** 命令 ack 响应 */
export interface CommandAck {
  ok: boolean;
  reason?: string;
}

// ────────────────────────────────────────────────────
// 镜像事件（mirror events）
// ────────────────────────────────────────────────────

export type MirrorEventType =
  | "status_changed"
  | "clarify_updated"
  | "spec_revised"
  | "clarify_progress"
  | "phase_progress"
  | "pr_updated";

export interface MirrorEvent {
  mirror_seq: number;
  type: MirrorEventType;
  payload: Record<string, unknown>;
}

// ────────────────────────────────────────────────────
// 全量快照（mirror snapshot）
// ────────────────────────────────────────────────────

export interface MirrorSnapshot {
  autopilot_req_id: string;
  /** reqgenie 读取字段名（ingest_mirror_snapshot 协议） */
  mirror_status: string;
  status_reason?: string | null;
  spec_md?: string | null;
  title?: string | null;
  questions: MirrorQuestion[];
  phases: MirrorPhase[];
  prs: MirrorPr[];
  current_step?: string | null;
}

export interface MirrorQuestion {
  autopilot_question_id: string;
  parent_id?: string | null;
  from_role: string;
  body: string;
  status: "open" | "resolved";
  seq?: number;
}

export interface MirrorPhase {
  run_seq: number;
  phase: string;
  label: string;
  status: "pending" | "running" | "awaiting" | "completed" | "error" | "aborted";
  started_at?: string | null;
  finished_at?: string | null;
  seq: number;
}

export interface MirrorPr {
  repo_alias: string;
  pr_url: string;
  pr_status: string;
  seq: number;
}

// ────────────────────────────────────────────────────
// 内部链接记录（instance 内存中维护 reqgenie_req_id ↔ autopilot_req_id）
// ────────────────────────────────────────────────────

export interface ReqLink {
  reqgenie_req_id: string;
  autopilot_req_id: string;
  assignment_id: string;
  /** per-link 单调递增 mirror_seq 计数 */
  mirror_seq: number;
}
