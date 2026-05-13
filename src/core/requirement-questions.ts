import { getDb } from "./db";
import { emit } from "./event-bus";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface QuestionReply {
  id: string;
  question_id: string;
  author_role: "agent" | "user";
  text: string;
  created_at: number;
}

export interface Question {
  id: string;
  requirement_id: string;
  agent_text: string;
  suggestions: string[];
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
  replies?: QuestionReply[];
}

export interface CreateQuestionOpts {
  id: string;
  requirement_id: string;
  agent_text: string;
  suggestions?: string[];
}

export interface AddReplyOpts {
  id: string;
  question_id: string;
  author_role: "agent" | "user";
  text: string;
}

// ──────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// Question CRUD
// ──────────────────────────────────────────────

export function createQuestion(opts: CreateQuestionOpts): Question {
  const db = getDb();
  const ts = nowMs();
  const suggestions = JSON.stringify(opts.suggestions ?? []);
  db.run(
    "INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
    [opts.id, opts.requirement_id, opts.agent_text, suggestions, ts]
  );
  return getQuestionById(opts.id) as Question;
}

function parseQuestion(row: Omit<Question, "replies" | "suggestions"> & { suggestions: string }, replies: QuestionReply[]): Question {
  let suggestions: string[] = [];
  try { suggestions = JSON.parse(row.suggestions) as string[]; } catch { /* empty */ }
  return { ...row, suggestions, replies };
}

export function getQuestionById(id: string): Question | null {
  const db = getDb();
  const row = db
    .query<Omit<Question, "replies" | "suggestions"> & { suggestions: string }, [string]>(
      "SELECT * FROM requirement_questions WHERE id = ?"
    )
    .get(id);
  if (!row) return null;
  const replies = db
    .query<QuestionReply, [string]>(
      "SELECT * FROM requirement_question_replies WHERE question_id = ? ORDER BY created_at ASC"
    )
    .all(id);
  return parseQuestion(row, replies);
}

export function listQuestionsByRequirement(requirementId: string): Question[] {
  const db = getDb();
  const rows = db
    .query<Omit<Question, "replies" | "suggestions"> & { suggestions: string }, [string]>(
      "SELECT * FROM requirement_questions WHERE requirement_id = ? ORDER BY created_at ASC"
    )
    .all(requirementId);

  return rows.map(row => {
    const replies = db
      .query<QuestionReply, [string]>(
        "SELECT * FROM requirement_question_replies WHERE question_id = ? ORDER BY created_at ASC"
      )
      .all(row.id);
    return parseQuestion(row, replies);
  });
}

export function addReply(opts: AddReplyOpts): QuestionReply {
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO requirement_question_replies (id, question_id, author_role, text, created_at) VALUES (?, ?, ?, ?, ?)",
    [opts.id, opts.question_id, opts.author_role, opts.text, ts]
  );
  const row = db
    .query<QuestionReply, [string]>(
      "SELECT * FROM requirement_question_replies WHERE id = ?"
    )
    .get(opts.id);
  return row as QuestionReply;
}

export function resolveQuestion(id: string): void {
  const db = getDb();
  const row = db
    .query<{ requirement_id: string; status: string }, [string]>(
      "SELECT requirement_id, status FROM requirement_questions WHERE id = ?"
    )
    .get(id);
  if (!row || row.status === "resolved") return;

  db.run(
    "UPDATE requirement_questions SET status = 'resolved', resolved_at = ? WHERE id = ?",
    [nowMs(), id],
  );
  emit({
    type: "requirement:question-resolved",
    payload: { id: row.requirement_id, question_id: id },
  });
}

export function nextQuestionId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_questions WHERE id LIKE 'qst-%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "qst-001";
  const last = rows[0].id.replace("qst-", "");
  const n = parseInt(last, 10) + 1;
  return `qst-${String(n).padStart(3, "0")}`;
}

// 超过 999 条时字典序排序出错，与 nextQuestionId 同等已知限制，P1 阶段不会触发。
export function nextReplyId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_question_replies WHERE id LIKE 'qst-r%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "qst-r001";
  const last = rows[0].id.replace("qst-r", "");
  const n = parseInt(last, 10) + 1;
  return `qst-r${String(n).padStart(3, "0")}`;
}
