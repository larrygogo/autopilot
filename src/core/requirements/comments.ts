import { getDb } from "../db";
import { emit } from "../event-bus";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export type CommentKind = "question" | "feedback" | "handoff";
export type CommentFromRole = "agent" | "user" | "github";
export type CommentStatus = "open" | "resolved";

export interface Comment {
  id: string;
  requirement_id: string;
  parent_id: string | null;
  kind: CommentKind;
  from_role: CommentFromRole;
  body: string;
  suggestions: string[] | null;
  status: CommentStatus;
  github_review_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface CreateCommentOpts {
  id: string;
  requirement_id: string;
  kind: CommentKind;
  from_role: CommentFromRole;
  body: string;
  parent_id?: string | null;
  suggestions?: string[];
  github_review_id?: string | null;
  status?: CommentStatus;
}

interface CommentRow {
  id: string;
  requirement_id: string;
  parent_id: string | null;
  kind: CommentKind;
  from_role: CommentFromRole;
  body: string;
  suggestions: string | null;
  status: CommentStatus;
  github_review_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

function rowToComment(row: CommentRow): Comment {
  let suggestions: string[] | null = null;
  if (row.suggestions) {
    try {
      const parsed = JSON.parse(row.suggestions);
      if (Array.isArray(parsed)) suggestions = parsed as string[];
    } catch { /* 容错：旧数据非 JSON → null */ }
  }
  return { ...row, suggestions };
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function createComment(opts: CreateCommentOpts): Comment {
  const db = getDb();
  const ts = Date.now();
  const status = opts.status ?? (opts.kind === "question" ? "open" : "resolved");
  const suggestions = opts.suggestions ? JSON.stringify(opts.suggestions) : null;
  db.run(
    `INSERT INTO requirement_comments
       (id, requirement_id, parent_id, kind, from_role, body, suggestions, status, github_review_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.requirement_id,
      opts.parent_id ?? null,
      opts.kind,
      opts.from_role,
      opts.body,
      suggestions,
      status,
      opts.github_review_id ?? null,
      ts,
      status === "resolved" ? ts : null,
    ],
  );
  return getCommentById(opts.id) as Comment;
}

export function getCommentById(id: string): Comment | null {
  const db = getDb();
  const row = db
    .query<CommentRow, [string]>("SELECT * FROM requirement_comments WHERE id = ?")
    .get(id);
  return row ? rowToComment(row) : null;
}

export interface ListCommentsFilter {
  kind?: CommentKind;
  status?: CommentStatus;
  parent_id?: string | null;
}

export function listComments(requirement_id: string, filter: ListCommentsFilter = {}): Comment[] {
  const db = getDb();
  const clauses: string[] = ["requirement_id = ?"];
  const params: (string | null)[] = [requirement_id];
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.parent_id !== undefined) {
    if (filter.parent_id === null) {
      clauses.push("parent_id IS NULL");
    } else {
      clauses.push("parent_id = ?");
      params.push(filter.parent_id);
    }
  }
  const sql = `SELECT * FROM requirement_comments WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC`;
  return db
    .query<CommentRow, (string | null)[]>(sql)
    .all(...params)
    .map(rowToComment);
}

/**
 * 取最新一条 comment（fix_revision 阶段用来读最近一次 feedback）。
 */
export function latestComment(requirement_id: string, filter: ListCommentsFilter = {}): Comment | null {
  const db = getDb();
  const clauses: string[] = ["requirement_id = ?"];
  const params: (string | null)[] = [requirement_id];
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.parent_id !== undefined) {
    if (filter.parent_id === null) {
      clauses.push("parent_id IS NULL");
    } else {
      clauses.push("parent_id = ?");
      params.push(filter.parent_id);
    }
  }
  const sql = `SELECT * FROM requirement_comments WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = db.query<CommentRow, (string | null)[]>(sql).get(...params);
  return row ? rowToComment(row) : null;
}

export function resolveComment(id: string): void {
  const db = getDb();
  const row = db
    .query<{ requirement_id: string; status: string; kind: string }, [string]>(
      "SELECT requirement_id, status, kind FROM requirement_comments WHERE id = ?",
    )
    .get(id);
  if (!row || row.status === "resolved") return;

  db.run(
    "UPDATE requirement_comments SET status = 'resolved', resolved_at = ? WHERE id = ?",
    [Date.now(), id],
  );

  // question 的 resolve 是业务事件（clarifier 流程），保留旧事件名供 UI / now-aggregator 订阅
  if (row.kind === "question") {
    emit({
      type: "requirement:question-resolved",
      payload: { id: row.requirement_id, question_id: id },
    });
  }
}

// ──────────────────────────────────────────────
// ID 生成
// ──────────────────────────────────────────────

/**
 * 生成下一个 comment id：cmt-NNN。
 *
 * 注意：迁移后旧 question 仍用 qst-NNN id，reply 用 qst-rNNN，feedback 用 fb-NNN。
 * 新创建的 comment 一律走 cmt-NNN。
 * 字典序限制：>999 时排序错乱，与旧 nextQuestionId 同等已知限制。
 */
export function nextCommentId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_comments WHERE id LIKE 'cmt-%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "cmt-001";
  const last = rows[0].id.replace("cmt-", "");
  const n = parseInt(last, 10) + 1;
  return `cmt-${String(n).padStart(3, "0")}`;
}
