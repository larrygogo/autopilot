import { getDb } from "./db";
import { emit } from "./event-bus";
import { resolveComment } from "./requirement-comments";
import { listWorkspaces } from "./workspaces";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/**
 * requirements 字段适配 project + workspace 模型。
 *  - project_id：必填，requirement 归属的 project
 *  - workspace_id：可选（spec §5.1：高层需求可以不绑定具体 workspace）
 *
 * 创建时如果带了 workspace_id，会自动写一条 requirement_workspaces 关联。
 */
export interface Requirement {
  id: string;
  project_id: string;
  workspace_id: string | null;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  active_question_id: string | null;
  clarifier_error: string | null;
  clarifier_provider: string | null;
  clarifier_model: string | null;
  /** 调度器起 task 失败（回滚 ready）时记录的原因；成功起 task 时清空。 */
  schedule_error: string | null;
  /** 进入 cancelled / failed 终态时的人话短摘要（task_logs.note 或用户输入）；failed 重试时清空。 */
  status_reason: string | null;
  /** status_reason 的来源：user（用户手动）/ task（任务级联）/ system（调度等系统路径）。 */
  status_reason_source: StatusReasonSource | null;
  /** 转入终态时的 from 状态（步骤条据此把 ✗ 画在死亡步）；failed 重试时清空。 */
  status_before_terminal: string | null;
  /** 执行用的工作流名；NULL = 未显式选择，调度时回退默认 "dev"。审批后随内容冻结。 */
  workflow: string | null;
  created_at: number;
  updated_at: number;
}

export type StatusReasonSource = "user" | "task" | "system";

export interface CreateRequirementOpts {
  id: string;
  project_id: string;
  workspace_id?: string | null;
  title: string;
  spec_md?: string;
  chat_session_id?: string | null;
}

export interface UpdateRequirementOpts {
  title?: string;
  spec_md?: string;
  workspace_id?: string | null;
  chat_session_id?: string | null;
  task_id?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  last_reviewed_event_id?: string | null;
  clarifier_error?: string | null;
  clarifier_provider?: string | null;
  clarifier_model?: string | null;
  schedule_error?: string | null;
  workflow?: string | null;
}

// ──────────────────────────────────────────────
// 状态机
// ──────────────────────────────────────────────

/**
 * 状态转换表（spec §3.2 + P1 Task 14 临时兼容）。
 *
 * 注：
 *   - queued → ready 也是合法的（P2 enqueue 失败时回滚需要）。
 *   - 新流程引入 awaiting_approval（spec §5.3）；P4 才完全重写状态机，
 *     T14 阶段先把 drafting/clarifying/ready/queued/failed → awaiting_approval 这条临时通路打开。
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  drafting: ["clarifying", "ready", "awaiting_approval", "cancelled"],
  clarifying: ["drafting", "ready", "awaiting_approval", "cancelled"],
  ready: ["queued", "awaiting_approval", "drafting", "cancelled"],
  queued: ["running", "awaiting_approval", "ready", "cancelled"],
  awaiting_approval: ["queued", "running", "drafting", "cancelled"],
  running: ["awaiting_review", "done", "failed", "cancelled"],
  // awaiting_review → failed：task 在 await_review 期失败时 bridge 要能同步需求到 failed，
  // 否则需求永卡 awaiting_review、pr-poller 持续轮询死 task（SC-4）。
  awaiting_review: ["fix_revision", "done", "failed", "cancelled"],
  fix_revision: ["awaiting_review", "failed", "cancelled"],
  done: [],
  cancelled: [],
  failed: ["queued", "awaiting_approval"],
};

export function canTransitionStatus(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** 从某状态出发可以合法转去的全部状态。给错误信息当 hint 用。 */
export function legalTransitionsFrom(from: string): string[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? [])];
}

// ──────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function createRequirement(opts: CreateRequirementOpts): Requirement {
  // 自动关联：若未指定 workspace_id 且 project 下只有 1 个 workspace，自动选它
  let resolvedWorkspaceId: string | null = opts.workspace_id ?? null;
  if (resolvedWorkspaceId === null && opts.project_id) {
    const wss = listWorkspaces({ projectId: opts.project_id, includeSubmodules: false });
    if (wss.length === 1) {
      resolvedWorkspaceId = wss[0].id;
    }
  }

  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO requirements (id, project_id, workspace_id, title, status, spec_md, chat_session_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?)",
    [
      opts.id,
      opts.project_id,
      resolvedWorkspaceId,
      opts.title,
      opts.spec_md ?? "",
      opts.chat_session_id ?? null,
      ts,
      ts,
    ],
  );
  // 有 workspace_id 时自动写多对多关联（spec §5.1）
  if (resolvedWorkspaceId) {
    db.run(
      "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) VALUES (?, ?)",
      [opts.id, resolvedWorkspaceId],
    );
  }
  return getRequirementById(opts.id) as Requirement;
}

export function getRequirementById(id: string): Requirement | null {
  const db = getDb();
  return db
    .query<Requirement, [string]>("SELECT * FROM requirements WHERE id = ?")
    .get(id) ?? null;
}

export function listRequirements(
  filters: { workspace_id?: string; project_id?: string; status?: string } = {},
): Requirement[] {
  const db = getDb();
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (filters.workspace_id) {
    where.push("workspace_id = ?");
    vals.push(filters.workspace_id);
  }
  if (filters.project_id) {
    where.push("project_id = ?");
    vals.push(filters.project_id);
  }
  if (filters.status) {
    where.push("status = ?");
    vals.push(filters.status);
  }
  const sql =
    "SELECT * FROM requirements" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at ASC";
  return db.query<Requirement, typeof vals>(sql).all(...vals);
}

/**
 * 列出某 project 下所有 requirement（spec §5.1 一个 project 多 workspace 共享需求池）。
 */
export function listRequirementsByProject(projectId: string): Requirement[] {
  const db = getDb();
  return db
    .query<Requirement, [string]>(
      "SELECT * FROM requirements WHERE project_id = ? ORDER BY created_at ASC",
    )
    .all(projectId);
}

export function updateRequirement(id: string, opts: UpdateRequirementOpts): Requirement | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];
  const updatable = [
    "title",
    "spec_md",
    "workspace_id",
    "chat_session_id",
    "task_id",
    "pr_url",
    "pr_number",
    "last_reviewed_event_id",
    "clarifier_error",
    "clarifier_provider",
    "clarifier_model",
    "schedule_error",
    "workflow",
  ] as const;
  for (const k of updatable) {
    if (opts[k] !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(opts[k] as string | number | null);
    }
  }
  if (fields.length === 0) return getRequirementById(id);
  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);
  db.run(`UPDATE requirements SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getRequirementById(id);
}

/**
 * 删除需求 + 级联删反馈、sub_prs 和 requirement_workspaces 关联。仅供调用方自己保证 id 处于终态（cancelled / done / failed）。
 *
 * 抽出此函数是为了让 REST handler / chat tools 不直接写 SQL，集中数据库写入到 core 层。
 */
export function deleteRequirement(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // requirement_comments 已有 ON DELETE CASCADE，但显式删一次便于无 FK 场景（如旧 DB / 测试纯表）
    db.run("DELETE FROM requirement_comments WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_workspaces WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirements WHERE id = ?", [id]);
  })();
}

/**
 * 设置状态。校验状态机合法性后写入，并 emit event-bus 事件。
 * 调用方（REST handler / chat tool）应只通过此函数改 status，
 * 不要直接 UPDATE status 列（会跳过校验和事件）。
 */
export function setRequirementStatus(
  id: string,
  to: string,
  opts?: { reason?: string | null; reason_source?: StatusReasonSource },
): Requirement {
  const cur = getRequirementById(id);
  if (!cur) throw new Error(`requirement not found: ${id}`);
  if (cur.status === to) return cur;
  if (!canTransitionStatus(cur.status, to)) {
    // 把当前合法目标列出来，客户读 daemon log 时知道下一步可以走哪
    const allowed = legalTransitionsFrom(cur.status);
    const hint = allowed.length > 0 ? `（合法去向：${allowed.join(" / ")}）` : "（无合法去向，已是终态）";
    throw new Error(`requirement ${id} 非法状态转换：${cur.status} → ${to}${hint}`);
  }
  const db = getDb();
  const ts = nowMs();
  const isTerminal = to === "cancelled" || to === "failed";
  const reason = isTerminal ? opts?.reason ?? null : null;
  if (isTerminal) {
    // 终态统一记 status_before_terminal（即便无 reason），步骤条据此定位死亡步
    db.run(
      "UPDATE requirements SET status = ?, status_reason = ?, status_reason_source = ?, status_before_terminal = ?, updated_at = ? WHERE id = ?",
      [to, reason, reason ? opts?.reason_source ?? "system" : null, cur.status, ts, id],
    );
  } else if (cur.status === "failed") {
    // failed → queued / awaiting_approval 重试：清掉上一轮的失败原因（与 schedule_error 成功清空同理）
    db.run(
      "UPDATE requirements SET status = ?, status_reason = NULL, status_reason_source = NULL, status_before_terminal = NULL, updated_at = ? WHERE id = ?",
      [to, ts, id],
    );
  } else {
    db.run("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?", [to, ts, id]);
  }
  // 需求级状态转移日志（与 task_logs 对称）：审批/排队时间、终态审计的真理来源
  try {
    db.run(
      "INSERT INTO requirement_status_logs (requirement_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, cur.status, to, reason, ts],
    );
  } catch {
    // 表不存在（迁移未跑的旧库/测试纯表夹具）：日志是增强，不阻塞状态转换
  }
  emit({ type: "requirement:status-changed", payload: { id, from: cur.status, to, reason } });
  return getRequirementById(id) as Requirement;
}

export interface RequirementStatusLog {
  id: number;
  requirement_id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  created_at: number;
}

/** 需求状态转移历史（升序）。 */
export function listRequirementStatusLogs(requirementId: string): RequirementStatusLog[] {
  const db = getDb();
  try {
    return db
      .query<RequirementStatusLog, [string]>(
        "SELECT * FROM requirement_status_logs WHERE requirement_id = ? ORDER BY id ASC",
      )
      .all(requirementId);
  } catch {
    return [];
  }
}

/**
 * 只更新终态原因两列、不动 status。给「级联停 task 时 bridge 抢先把需求置 cancelled」
 * 的手动取消路径用：随后用 user 来源覆盖 bridge 写入的 task 来源（这次取消的根因是用户操作）。
 */
export function setRequirementStatusReason(
  id: string,
  reason: string | null,
  source: StatusReasonSource | null,
): void {
  const db = getDb();
  db.run(
    "UPDATE requirements SET status_reason = ?, status_reason_source = ?, updated_at = ? WHERE id = ?",
    [reason, reason === null ? null : source, nowMs(), id],
  );
}

/**
 * 设置 active_question_id 字段，并 emit requirement:active-question-changed 事件。
 * 传入 null 表示清空（没有等回答的问题）。
 */
export function setActiveQuestionId(requirementId: string, questionId: string | null): void {
  const db = getDb();
  db.run(
    "UPDATE requirements SET active_question_id = ?, updated_at = ? WHERE id = ?",
    [questionId, nowMs(), requirementId],
  );
  emit({
    type: "requirement:active-question-changed",
    payload: { id: requirementId, question_id: questionId },
  });
}

/**
 * 用户强制结束澄清（"够了，直接审批"），或 clarifier 决定 done=true 时调用。
 *
 * 流程：
 * 1. 若 active_question_id 非空 → resolveQuestion 该 question
 * 2. active_question_id = NULL
 * 3. status = awaiting_approval（走 setRequirementStatus 保证校验 + emit）
 */
export function finishClarification(requirementId: string): void {
  const db = getDb();
  db.transaction(() => {
    const req = getRequirementById(requirementId);
    if (!req) return;
    if (req.active_question_id) {
      resolveComment(req.active_question_id);
    }
    db.run(
      "UPDATE requirements SET active_question_id = NULL, updated_at = ? WHERE id = ?",
      [nowMs(), requirementId],
    );
    emit({
      type: "requirement:active-question-changed",
      payload: { id: requirementId, question_id: null },
    });
  })();
  setRequirementStatus(requirementId, "awaiting_approval");
}

/**
 * 生成下一个 requirement id，格式 "req-NNN"。
 *
 * TODO: 当 requirements 数 > 999 时，3 位 padding 会让 lex 排序出错
 * （"req-1000" < "req-999"），需要改成更宽 padding 或用 CAST 数字排序。
 * 跟 nextRepoId 的同名 TODO 一致。
 */
export function nextRequirementId(): string {
  const db = getDb();
  // 同时扫 requirements 和 requirement_comments，防止需求被删后评论残留导致 ID 复用
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirements WHERE id LIKE 'req-%' " +
      "UNION SELECT requirement_id AS id FROM requirement_comments WHERE requirement_id LIKE 'req-%' " +
      "ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "req-001";
  const n = parseInt(rows[0].id.replace("req-", ""), 10) + 1;
  return `req-${String(n).padStart(3, "0")}`;
}
