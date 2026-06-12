/**
 * Phase 2 后兼容 shim：数据合并到 requirement_comments 表后，本模块改为
 * 在 comments 表上提供旧 RequirementFeedback API，让既有调用方
 * 和测试不必同步重写。
 *
 * 等代码全面用 Comment 直接渲染时，本文件可整体删除（spec follow-up）。
 */

import { getDb } from "./db";
import {
  createComment,
  nextCommentId,
  type Comment,
} from "./requirement-comments";

export interface RequirementFeedback {
  id: number;
  requirement_id: string;
  source: "github_review" | "manual";
  /** 原始评论角色（user/github/agent…）—— UI 区分「Agent 修复总结」与用户手动反馈 */
  from_role?: string;
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

interface CommentRow {
  id: string;
  requirement_id: string;
  from_role: string;
  body: string;
  github_review_id: string | null;
  created_at: number;
}

function commentRowToFeedback(row: CommentRow, fakeId: number): RequirementFeedback {
  return {
    id: fakeId,
    requirement_id: row.requirement_id,
    source: row.from_role === "github" ? "github_review" : "manual",
    from_role: row.from_role,
    body: row.body,
    github_review_id: row.github_review_id,
    created_at: row.created_at,
  };
}

function commentToFeedback(c: Comment, fakeId: number): RequirementFeedback {
  return {
    id: fakeId,
    requirement_id: c.requirement_id,
    source: c.from_role === "github" ? "github_review" : "manual",
    body: c.body,
    github_review_id: c.github_review_id,
    created_at: c.created_at,
  };
}

export function appendFeedback(opts: AppendFeedbackOpts): RequirementFeedback {
  const c = createComment({
    id: nextCommentId(),
    requirement_id: opts.requirement_id,
    kind: "feedback",
    from_role: opts.source === "github_review" ? "github" : "user",
    body: opts.body,
    github_review_id: opts.github_review_id ?? null,
  });
  return commentToFeedback(c, Date.now());
}

export function listFeedbacks(requirement_id: string): RequirementFeedback[] {
  const db = getDb();
  const rows = db
    .query<CommentRow, [string]>(
      "SELECT id, requirement_id, from_role, body, github_review_id, created_at FROM requirement_comments WHERE requirement_id = ? AND kind = 'feedback' ORDER BY created_at ASC, id ASC",
    )
    .all(requirement_id);
  return rows.map((row, i) => commentRowToFeedback(row, i + 1));
}

export function latestFeedback(requirement_id: string): RequirementFeedback | null {
  const db = getDb();
  const row = db
    .query<CommentRow, [string]>(
      "SELECT id, requirement_id, from_role, body, github_review_id, created_at FROM requirement_comments WHERE requirement_id = ? AND kind = 'feedback' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(requirement_id);
  return row ? commentRowToFeedback(row, 1) : null;
}
