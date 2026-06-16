/**
 * Phase 2 — requirement_comments 合并 + CRUD 测试
 *
 * 覆盖：
 * - migration 021：question + reply + feedback → requirement_comments
 * - CRUD：createComment / getCommentById / listComments / latestComment / resolveComment / nextCommentId
 * - status / kind / from_role / parent_id 各路径
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createRequirement } from "../src/core/requirements";
import {
  createComment,
  getCommentById,
  listComments,
  latestComment,
  resolveComment,
  nextCommentId,
} from "../src/core/requirements/comments";

describe("requirement_comments CRUD", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    [m001, m004, m005, m006, m007, m008, m009, m010, m021, migrate024, migrate033].forEach((fn) => fn(db));
    _setDbForTest(db);
    createProject({ id: "proj-1", name: "P" });
    createWorkspace({ id: "cb-1", project_id: "proj-1", alias: "a", path: "/tmp/a", default_branch: "main" });
    createRequirement({ id: "req-1", project_id: "proj-1", title: "T", spec_md: "" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_comments WHERE requirement_id = 'req-1'");
  });

  it("createComment(kind=question) 默认 status=open", () => {
    const c = createComment({
      id: "cmt-q1",
      requirement_id: "req-1",
      kind: "question",
      from_role: "agent",
      body: "你想干嘛?",
      suggestions: ["A", "B"],
    });
    expect(c.kind).toBe("question");
    expect(c.status).toBe("open");
    expect(c.resolved_at).toBeNull();
    expect(c.suggestions).toEqual(["A", "B"]);
    expect(c.parent_id).toBeNull();
  });

  it("createComment(kind=feedback) 默认 status=resolved", () => {
    const c = createComment({
      id: "cmt-f1",
      requirement_id: "req-1",
      kind: "feedback",
      from_role: "user",
      body: "改这里",
    });
    expect(c.kind).toBe("feedback");
    expect(c.status).toBe("resolved");
    expect(c.resolved_at).not.toBeNull();
    expect(c.suggestions).toBeNull();
  });

  it("createComment(kind=handoff)", () => {
    const c = createComment({
      id: "cmt-h1",
      requirement_id: "req-1",
      kind: "handoff",
      from_role: "agent",
      body: "下一阶段注意 X",
    });
    expect(c.kind).toBe("handoff");
    expect(c.status).toBe("resolved");
  });

  it("createComment reply 走 parent_id", () => {
    createComment({ id: "cmt-q2", requirement_id: "req-1", kind: "question", from_role: "agent", body: "问题" });
    const reply = createComment({
      id: "cmt-q2r1",
      requirement_id: "req-1",
      kind: "question",
      from_role: "user",
      body: "答案",
      parent_id: "cmt-q2",
      status: "resolved",
    });
    expect(reply.parent_id).toBe("cmt-q2");
  });

  it("listComments 按 kind 过滤", () => {
    createComment({ id: "cmt-q3", requirement_id: "req-1", kind: "question", from_role: "agent", body: "q" });
    createComment({ id: "cmt-f2", requirement_id: "req-1", kind: "feedback", from_role: "user", body: "f" });
    const questions = listComments("req-1", { kind: "question" });
    const feedbacks = listComments("req-1", { kind: "feedback" });
    expect(questions.length).toBe(1);
    expect(feedbacks.length).toBe(1);
    expect(questions[0].kind).toBe("question");
  });

  it("listComments 按 status 过滤", () => {
    createComment({ id: "cmt-q4", requirement_id: "req-1", kind: "question", from_role: "agent", body: "open q" });
    createComment({ id: "cmt-q5", requirement_id: "req-1", kind: "question", from_role: "agent", body: "resolved q", status: "resolved" });
    const open = listComments("req-1", { status: "open" });
    expect(open.length).toBe(1);
    expect(open[0].body).toBe("open q");
  });

  it("listComments parent_id=null 只返回顶层", () => {
    createComment({ id: "cmt-q6", requirement_id: "req-1", kind: "question", from_role: "agent", body: "top" });
    createComment({ id: "cmt-q6r1", requirement_id: "req-1", kind: "question", from_role: "user", body: "reply", parent_id: "cmt-q6" });
    const tops = listComments("req-1", { kind: "question", parent_id: null });
    expect(tops.length).toBe(1);
    expect(tops[0].id).toBe("cmt-q6");
  });

  it("resolveComment 切到 resolved + 设 resolved_at", () => {
    createComment({ id: "cmt-q7", requirement_id: "req-1", kind: "question", from_role: "agent", body: "?" });
    resolveComment("cmt-q7");
    const c = getCommentById("cmt-q7");
    expect(c?.status).toBe("resolved");
    expect(c?.resolved_at).not.toBeNull();
  });

  it("resolveComment 对 resolved 是 no-op", () => {
    const before = createComment({ id: "cmt-f3", requirement_id: "req-1", kind: "feedback", from_role: "user", body: "x" });
    resolveComment("cmt-f3");
    const after = getCommentById("cmt-f3");
    expect(after?.resolved_at).toBe(before.resolved_at);
  });

  it("latestComment 取最新", () => {
    const first = createComment({ id: "cmt-f4", requirement_id: "req-1", kind: "feedback", from_role: "user", body: "old" });
    // 用 +1ms 强制 created_at 不同
    const second = { ...createComment({ id: "cmt-f5", requirement_id: "req-1", kind: "feedback", from_role: "user", body: "new" }) };
    // created_at 同 ms 时按 id 倒序拿（latestComment 用 created_at DESC, id DESC）
    const latest = latestComment("req-1", { kind: "feedback" });
    expect(latest?.body).toBe(second.body);
    expect(first.id).toBe("cmt-f4");
  });

  it("nextCommentId 生成 cmt-NNN 且递增", () => {
    expect(nextCommentId()).toBe("cmt-001");
    createComment({ id: "cmt-001", requirement_id: "req-1", kind: "question", from_role: "agent", body: "x" });
    createComment({ id: "cmt-002", requirement_id: "req-1", kind: "question", from_role: "agent", body: "y" });
    expect(nextCommentId()).toBe("cmt-003");
  });

  it("github_review_id 仅 from_role=github 用，可填可缺", () => {
    const c1 = createComment({
      id: "cmt-gh1",
      requirement_id: "req-1",
      kind: "feedback",
      from_role: "github",
      body: "PR review",
      github_review_id: "PRR_abc",
    });
    expect(c1.github_review_id).toBe("PRR_abc");

    const c2 = createComment({ id: "cmt-gh2", requirement_id: "req-1", kind: "feedback", from_role: "user", body: "no review id" });
    expect(c2.github_review_id).toBeNull();
  });
});

describe("requirement_comments migration 021 数据迁移", () => {
  it("旧 questions / replies / feedbacks 数据迁移到 requirement_comments", () => {
    const db = new Database(":memory:");
    [m001, m004, m005, m006, m007, m008, m009, m010].forEach((fn) => fn(db));
    migrate024(db);

    // 准备旧表数据
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb1', 'p1', 'a', '/tmp/a', 'main', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('req-m1', 'p1', 'T', 'drafting', '', 0, 0)");

    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at, resolved_at) VALUES ('qst-001', 'req-m1', '问？', '[\"A\"]', 'open', 100, NULL)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at, resolved_at) VALUES ('qst-002', 'req-m1', '问2', '[]', 'resolved', 200, 250)");
    db.run("INSERT INTO requirement_question_replies (id, question_id, author_role, text, created_at) VALUES ('qst-r001', 'qst-002', 'user', '答2', 240)");
    db.run("INSERT INTO requirement_feedbacks (requirement_id, source, body, github_review_id, created_at) VALUES ('req-m1', 'github_review', 'PR 改', 'PRR_x', 300)");
    db.run("INSERT INTO requirement_feedbacks (requirement_id, source, body, github_review_id, created_at) VALUES ('req-m1', 'manual', '手填', NULL, 400)");

    // 跑 m021
    m021(db);

    // 验证迁移
    const all = db.query<{ id: string; kind: string; from_role: string; body: string; status: string; parent_id: string | null }, []>(
      "SELECT id, kind, from_role, body, status, parent_id FROM requirement_comments ORDER BY created_at ASC, id ASC",
    ).all();
    expect(all.length).toBe(5);

    const q1 = all.find((c) => c.id === "qst-001")!;
    expect(q1.kind).toBe("question");
    expect(q1.from_role).toBe("agent");
    expect(q1.status).toBe("open");
    expect(q1.parent_id).toBeNull();

    const r = all.find((c) => c.id === "qst-r001")!;
    expect(r.kind).toBe("question");
    expect(r.from_role).toBe("user");
    expect(r.parent_id).toBe("qst-002");
    expect(r.status).toBe("resolved");

    const fb1 = all.find((c) => c.id === "fb-1")!;
    expect(fb1.kind).toBe("feedback");
    expect(fb1.from_role).toBe("github");

    const fb2 = all.find((c) => c.id === "fb-2")!;
    expect(fb2.from_role).toBe("user");

    // 旧表已 DROP
    expect(() => db.run("SELECT 1 FROM requirement_questions")).toThrow();
    expect(() => db.run("SELECT 1 FROM requirement_question_replies")).toThrow();
    expect(() => db.run("SELECT 1 FROM requirement_feedbacks")).toThrow();
  });

  it("suggestions 列不存在时（跳过 m010）回退到 NULL", () => {
    const db = new Database(":memory:");
    [m001, m004, m005, m006, m007, m008].forEach((fn) => fn(db));
    migrate024(db);
    migrate033(db);
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb1', 'p1', 'a', '/tmp/a', 'main', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, workspace_id, title, status, spec_md, created_at, updated_at) VALUES ('req-m2', 'p1', 'cb1', 'T', 'drafting', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, status, created_at, resolved_at) VALUES ('qst-100', 'req-m2', '?', 'open', 100, NULL)");

    m021(db);

    const c = db.query<{ id: string; suggestions: string | null }, []>(
      "SELECT id, suggestions FROM requirement_comments WHERE id = 'qst-100'",
    ).get();
    expect(c?.suggestions).toBeNull();
  });
});
