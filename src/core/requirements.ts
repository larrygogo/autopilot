import { getDb } from "./db";
import { emit } from "../daemon/event-bus";
import { resolveQuestion } from "./requirement-questions";
import { listCodebases } from "./codebases";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/**
 * P1 Task 14：requirements 字段适配 project + codebase 模型。
 *  - project_id：必填，requirement 归属的 project
 *  - codebase_id：可选（spec §5.1：高层需求可以不绑定具体 codebase），rename 自旧字段 repo_id
 *
 * 创建时如果带了 codebase_id，会自动写一条 requirement_codebases 关联。
 */
export interface Requirement {
  id: string;
  project_id: string;
  codebase_id: string | null;
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
  created_at: number;
  updated_at: number;
}

export interface CreateRequirementOpts {
  id: string;
  project_id: string;
  codebase_id?: string | null;
  title: string;
  spec_md?: string;
  chat_session_id?: string | null;
}

export interface UpdateRequirementOpts {
  title?: string;
  spec_md?: string;
  codebase_id?: string | null;
  chat_session_id?: string | null;
  task_id?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  last_reviewed_event_id?: string | null;
  clarifier_error?: string | null;
  clarifier_provider?: string | null;
  clarifier_model?: string | null;
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
  awaiting_approval: ["running", "drafting", "cancelled"],
  running: ["awaiting_review", "failed", "cancelled"],
  awaiting_review: ["fix_revision", "done", "cancelled"],
  fix_revision: ["awaiting_review", "failed", "cancelled"],
  done: [],
  cancelled: [],
  failed: ["queued", "awaiting_approval"],
};

export function canTransitionStatus(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
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
  // 自动关联：若未指定 codebase_id 且 project 下只有 1 个 codebase，自动选它
  let resolvedCodebaseId: string | null = opts.codebase_id ?? null;
  if (resolvedCodebaseId === null && opts.project_id) {
    const cbs = listCodebases({ projectId: opts.project_id, includeSubmodules: false });
    if (cbs.length === 1) {
      resolvedCodebaseId = cbs[0].id;
    }
  }

  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO requirements (id, project_id, codebase_id, title, status, spec_md, chat_session_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?)",
    [
      opts.id,
      opts.project_id,
      resolvedCodebaseId,
      opts.title,
      opts.spec_md ?? "",
      opts.chat_session_id ?? null,
      ts,
      ts,
    ],
  );
  // 有 codebase_id 时自动写多对多关联（spec §5.1）
  if (resolvedCodebaseId) {
    db.run(
      "INSERT OR IGNORE INTO requirement_codebases (requirement_id, codebase_id) VALUES (?, ?)",
      [opts.id, resolvedCodebaseId],
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
  filters: { codebase_id?: string; project_id?: string; status?: string } = {},
): Requirement[] {
  const db = getDb();
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (filters.codebase_id) {
    where.push("codebase_id = ?");
    vals.push(filters.codebase_id);
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
 * 列出某 project 下所有 requirement（spec §5.1 一个 project 多 codebase 共享需求池）。
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
    "codebase_id",
    "chat_session_id",
    "task_id",
    "pr_url",
    "pr_number",
    "last_reviewed_event_id",
    "clarifier_error",
    "clarifier_provider",
    "clarifier_model",
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
 * 删除需求 + 级联删反馈、sub_prs 和 requirement_codebases 关联。仅供调用方自己保证 id 处于终态（cancelled / done / failed）。
 *
 * 抽出此函数是为了让 REST handler / chat tools 不直接写 SQL，集中数据库写入到 core 层。
 */
export function deleteRequirement(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // 先删问题的回复，再删问题本身
    db.run(
      "DELETE FROM requirement_question_replies WHERE question_id IN " +
      "(SELECT id FROM requirement_questions WHERE requirement_id = ?)",
      [id],
    );
    db.run("DELETE FROM requirement_questions WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_feedbacks WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_codebases WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirements WHERE id = ?", [id]);
  })();
}

/**
 * 设置状态。校验状态机合法性后写入，并 emit event-bus 事件。
 * 调用方（REST handler / chat tool）应只通过此函数改 status，
 * 不要直接 UPDATE status 列（会跳过校验和事件）。
 */
export function setRequirementStatus(id: string, to: string): Requirement {
  const cur = getRequirementById(id);
  if (!cur) throw new Error(`requirement not found: ${id}`);
  if (cur.status === to) return cur;
  if (!canTransitionStatus(cur.status, to)) {
    throw new Error(`非法状态转换：${cur.status} → ${to}`);
  }
  const db = getDb();
  db.run("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?", [to, nowMs(), id]);
  emit({ type: "requirement:status-changed", payload: { id, from: cur.status, to } });
  return getRequirementById(id) as Requirement;
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
      resolveQuestion(req.active_question_id);
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
  // 同时扫 requirements 和 requirement_questions，防止需求被删后问题残留导致 ID 复用
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirements WHERE id LIKE 'req-%' " +
      "UNION SELECT requirement_id AS id FROM requirement_questions WHERE requirement_id LIKE 'req-%' " +
      "ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "req-001";
  const n = parseInt(rows[0].id.replace("req-", ""), 10) + 1;
  return `req-${String(n).padStart(3, "0")}`;
}
