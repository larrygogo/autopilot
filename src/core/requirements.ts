import { getDb } from "./db";
import { emit } from "../daemon/event-bus";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Requirement {
  id: string;
  repo_id: string;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateRequirementOpts {
  id: string;
  repo_id: string;
  title: string;
  spec_md?: string;
  chat_session_id?: string | null;
}

export interface UpdateRequirementOpts {
  title?: string;
  spec_md?: string;
  chat_session_id?: string | null;
  task_id?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  last_reviewed_event_id?: string | null;
}

// ──────────────────────────────────────────────
// 状态机
// ──────────────────────────────────────────────

/**
 * 状态转换表（spec §3.2）
 *
 * 注意：queued → ready 也是合法的（P2 enqueue 失败时回滚需要）。
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  drafting: ["clarifying", "ready", "cancelled"],
  clarifying: ["drafting", "ready", "cancelled"],
  ready: ["queued", "drafting", "cancelled"],
  queued: ["running", "ready", "cancelled"],
  running: ["awaiting_review", "failed", "cancelled"],
  awaiting_review: ["fix_revision", "done", "cancelled"],
  fix_revision: ["awaiting_review", "failed", "cancelled"],
  done: [],
  cancelled: [],
  failed: ["queued"],
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
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO requirements (id, repo_id, title, status, spec_md, chat_session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [opts.id, opts.repo_id, opts.title, "drafting", opts.spec_md ?? "", opts.chat_session_id ?? null, ts, ts],
  );
  return getRequirementById(opts.id) as Requirement;
}

export function getRequirementById(id: string): Requirement | null {
  const db = getDb();
  return db.query<Requirement, [string]>("SELECT * FROM requirements WHERE id = ?").get(id) ?? null;
}

export function listRequirements(filters: { repo_id?: string; status?: string } = {}): Requirement[] {
  const db = getDb();
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (filters.repo_id) {
    where.push("repo_id = ?");
    vals.push(filters.repo_id);
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

export function updateRequirement(id: string, opts: UpdateRequirementOpts): Requirement | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];
  const updatable = [
    "title",
    "spec_md",
    "chat_session_id",
    "task_id",
    "pr_url",
    "pr_number",
    "last_reviewed_event_id",
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
 * 删除需求 + 级联删反馈和 sub_prs。仅供调用方自己保证 id 处于终态（cancelled / done / failed）。
 *
 * 抽出此函数是为了让 REST handler / chat tools 不直接写 SQL，集中数据库写入到 core 层。
 */
export function deleteRequirement(id: string): void {
  const db = getDb();
  db.run("DELETE FROM requirement_feedbacks WHERE requirement_id = ?", [id]);
  db.run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [id]);
  db.run("DELETE FROM requirements WHERE id = ?", [id]);
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
 * 生成下一个 requirement id，格式 "req-NNN"。
 *
 * TODO: 当 requirements 数 > 999 时，3 位 padding 会让 lex 排序出错
 * （"req-1000" < "req-999"），需要改成更宽 padding 或用 CAST 数字排序。
 * 跟 nextRepoId 的同名 TODO 一致。
 */
export function nextRequirementId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirements WHERE id LIKE 'req-%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "req-001";
  const n = parseInt(rows[0].id.replace("req-", ""), 10) + 1;
  return `req-${String(n).padStart(3, "0")}`;
}
