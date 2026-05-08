import { getDb } from "./db";

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
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
  replies?: QuestionReply[];
}

export interface CreateQuestionOpts {
  id: string;
  requirement_id: string;
  agent_text: string;
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
  db.run(
    "INSERT INTO requirement_questions (id, requirement_id, agent_text, status, created_at) VALUES (?, ?, ?, 'open', ?)",
    [opts.id, opts.requirement_id, opts.agent_text, ts]
  );
  return getQuestionById(opts.id) as Question;
}

export function getQuestionById(id: string): Question | null {
  const db = getDb();
  const row = db
    .query<Omit<Question, "replies">, [string]>(
      "SELECT * FROM requirement_questions WHERE id = ?"
    )
    .get(id);
  if (!row) return null;
  const replies = db
    .query<QuestionReply, [string]>(
      "SELECT * FROM requirement_question_replies WHERE question_id = ? ORDER BY created_at ASC"
    )
    .all(id);
  return { ...row, replies };
}

export function listQuestionsByRequirement(requirementId: string): Question[] {
  const db = getDb();
  const questions = db
    .query<Omit<Question, "replies">, [string]>(
      "SELECT * FROM requirement_questions WHERE requirement_id = ? ORDER BY created_at ASC"
    )
    .all(requirementId);

  return questions.map(q => {
    const replies = db
      .query<QuestionReply, [string]>(
        "SELECT * FROM requirement_question_replies WHERE question_id = ? ORDER BY created_at ASC"
      )
      .all(q.id);
    return { ...q, replies };
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
  db.run(
    "UPDATE requirement_questions SET status = 'resolved', resolved_at = ? WHERE id = ?",
    [nowMs(), id]
  );
}

/**
 * 生成下一个 question id，格式 "qst-NNN"。
 * 简化方案：扫现有最大编号 +1，靠 PK 兜底并发冲突。
 *
 * TODO: 当问题数 > 999 时，3 位 padding 会让 lex 排序出错（"qst-1000" < "qst-999"），
 * 需要改成更宽 padding 或用 CAST(SUBSTR(id,5) AS INTEGER) 数字排序。Phase 1 不会触发。
 */
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
