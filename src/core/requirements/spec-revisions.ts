import { getDb } from "../db";

export interface SpecRevision {
  id: number;
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
  created_at: number;
}

export interface CreateSpecRevisionOpts {
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
}

/**
 * 创建一条 spec_revision 记录。返回自增 id。
 */
export function createSpecRevision(opts: CreateSpecRevisionOpts): number {
  const db = getDb();
  const r = db.run(
    "INSERT INTO spec_revisions " +
    "(requirement_id, before_md, after_md, summary, source, triggered_by_question_id, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      opts.requirement_id,
      opts.before_md,
      opts.after_md,
      opts.summary,
      opts.source,
      opts.triggered_by_question_id,
      Date.now(),
    ],
  );
  return Number(r.lastInsertRowid);
}

/**
 * 按 requirement_id 列出修订历史，最新的在前。
 */
export function listSpecRevisionsByRequirement(requirementId: string): SpecRevision[] {
  return getDb()
    .query<SpecRevision, [string]>(
      "SELECT * FROM spec_revisions WHERE requirement_id = ? ORDER BY created_at DESC, id DESC"
    )
    .all(requirementId);
}
