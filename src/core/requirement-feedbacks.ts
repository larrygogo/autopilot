import { getDb } from "./db";

export interface RequirementFeedback {
  id: number;
  requirement_id: string;
  source: "github_review" | "manual";
  body: string;
  github_review_id: string | null;
  created_at: number;
}

export interface AppendFeedbackOpts {
  requirement_id: string;
  source: "github_review" | "manual";
  body: string;
  github_review_id?: string | null;
}

/**
 * 追加一条反馈（append-only），返回插入的完整记录。
 */
export function appendFeedback(opts: AppendFeedbackOpts): RequirementFeedback {
  const db = getDb();
  const ts = Date.now();
  db.run(
    "INSERT INTO requirement_feedbacks (requirement_id, source, body, github_review_id, created_at) VALUES (?,?,?,?,?)",
    [opts.requirement_id, opts.source, opts.body, opts.github_review_id ?? null, ts],
  );
  const id = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
  return db.query<RequirementFeedback, [number]>(
    "SELECT * FROM requirement_feedbacks WHERE id = ?",
  ).get(id) as RequirementFeedback;
}

/**
 * 列出某需求的全部反馈，按 created_at 升序。
 */
export function listFeedbacks(requirement_id: string): RequirementFeedback[] {
  const db = getDb();
  return db.query<RequirementFeedback, [string]>(
    "SELECT * FROM requirement_feedbacks WHERE requirement_id = ? ORDER BY created_at ASC, id ASC",
  ).all(requirement_id);
}

/**
 * 取最新一条反馈（fix_revision 阶段用作输入）。
 */
export function latestFeedback(requirement_id: string): RequirementFeedback | null {
  const db = getDb();
  return db.query<RequirementFeedback, [string]>(
    "SELECT * FROM requirement_feedbacks WHERE requirement_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(requirement_id) ?? null;
}
