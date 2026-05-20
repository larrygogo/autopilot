/**
 * Phase 2 后兼容 shim：数据合并到 requirement_comments 表后，本模块改为
 * 在 comments 表上提供旧 Question / QuestionReply API，让既有调用方
 * 和测试不必同步重写。
 *
 * 等 UI / tests 全面用 Comment 直接渲染时，本文件可整体删除（spec follow-up）。
 *
 * 设计要点：
 * - Question = kind=question + parent_id=null 的 comment
 * - QuestionReply = kind=question + parent_id=<question.id> 的 comment
 * - createQuestion / addReply 仍生成 qst- / qst-r 前缀 id，避免破坏测试断言
 */

import { getDb } from "./db";
import {
  createComment,
  getCommentById,
  listComments,
  resolveComment,
  type Comment,
} from "./requirement-comments";

// ──────────────────────────────────────────────
// 旧类型（保留兼容）
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
// 适配器
// ──────────────────────────────────────────────

function commentToReply(c: Comment): QuestionReply {
  return {
    id: c.id,
    question_id: c.parent_id ?? "",
    author_role: c.from_role === "user" ? "user" : "agent",
    text: c.body,
    created_at: c.created_at,
  };
}

function commentToQuestion(c: Comment, replies: QuestionReply[]): Question {
  return {
    id: c.id,
    requirement_id: c.requirement_id,
    agent_text: c.body,
    suggestions: c.suggestions ?? [],
    status: c.status,
    created_at: c.created_at,
    resolved_at: c.resolved_at,
    replies,
  };
}

// ──────────────────────────────────────────────
// 旧 API（薄 shim）
// ──────────────────────────────────────────────

export function createQuestion(opts: CreateQuestionOpts): Question {
  const c = createComment({
    id: opts.id,
    requirement_id: opts.requirement_id,
    kind: "question",
    from_role: "agent",
    body: opts.agent_text,
    suggestions: opts.suggestions,
    status: "open",
  });
  return commentToQuestion(c, []);
}

export function getQuestionById(id: string): Question | null {
  const c = getCommentById(id);
  if (!c || c.kind !== "question" || c.parent_id !== null) return null;
  const replies = listComments(c.requirement_id, { kind: "question", parent_id: id }).map(commentToReply);
  return commentToQuestion(c, replies);
}

export function listQuestionsByRequirement(requirementId: string): Question[] {
  const tops = listComments(requirementId, { kind: "question", parent_id: null });
  return tops.map((t) => {
    const replies = listComments(requirementId, { kind: "question", parent_id: t.id }).map(commentToReply);
    return commentToQuestion(t, replies);
  });
}

export function addReply(opts: AddReplyOpts): QuestionReply {
  const c = createComment({
    id: opts.id,
    requirement_id: getCommentById(opts.question_id)?.requirement_id ?? "",
    kind: "question",
    from_role: opts.author_role,
    body: opts.text,
    parent_id: opts.question_id,
    status: "resolved",
  });
  return commentToReply(c);
}

export function resolveQuestion(id: string): void {
  resolveComment(id);
}

// ──────────────────────────────────────────────
// ID 生成（保持 qst- / qst-r 前缀以满足旧测试断言）
// ──────────────────────────────────────────────

export function nextQuestionId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_comments WHERE id LIKE 'qst-___' AND id NOT LIKE 'qst-r%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "qst-001";
  const last = rows[0].id.replace("qst-", "");
  const n = parseInt(last, 10) + 1;
  return `qst-${String(n).padStart(3, "0")}`;
}

export function nextReplyId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_comments WHERE id LIKE 'qst-r%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "qst-r001";
  const last = rows[0].id.replace("qst-r", "");
  const n = parseInt(last, 10) + 1;
  return `qst-r${String(n).padStart(3, "0")}`;
}
