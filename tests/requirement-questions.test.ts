import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate010 } from "../src/migrations/010-question-suggestions";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import { createRequirement } from "../src/core/requirements";
import {
  createQuestion, addReply, resolveQuestion,
  listQuestionsByRequirement, getQuestionById, nextQuestionId,
} from "../src/core/requirements/questions";

describe("requirement-questions 评论线程", () => {
  let sqlite: Database;
  let reqId: string;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate001(sqlite); migrate002(sqlite); migrate004(sqlite);
    migrate005(sqlite); migrate006(sqlite); migrate007(sqlite); migrate008(sqlite);
    migrate009(sqlite); migrate010(sqlite);
    migrate021(sqlite);
    migrate024(sqlite);
    migrate033(sqlite);

    const p = createProject({ id: "proj-q", name: "q" });
    const c = createWorkspace({ id: "cb-q", project_id: p.id, alias: "q", path: "/q" });
    const r = createRequirement({ id: "req-q", project_id: p.id, workspace_id: c.id, title: "qt" });
    reqId = r.id;
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("createQuestion 默认 status=open", () => {
    const q = createQuestion({ id: "qst-001", requirement_id: reqId, agent_text: "保留多少天?" });
    expect(q.status).toBe("open");
    expect(q.requirement_id).toBe(reqId);
    expect(q.resolved_at).toBeNull();
  });

  it("addReply 追加回复，按 created_at 顺序", () => {
    addReply({ id: "rpl-001", question_id: "qst-001", author_role: "user", text: "30 天" });
    addReply({ id: "rpl-002", question_id: "qst-001", author_role: "agent", text: "收到" });
    const q = getQuestionById("qst-001")!;
    expect(q.replies?.length).toBe(2);
    expect(q.replies?.[0].text).toBe("30 天");
    expect(q.replies?.[1].text).toBe("收到");
  });

  it("resolveQuestion 把 status 置为 resolved + 设 resolved_at", () => {
    resolveQuestion("qst-001");
    const q = getQuestionById("qst-001")!;
    expect(q.status).toBe("resolved");
    expect(q.resolved_at).toBeGreaterThan(0);
  });

  it("listQuestionsByRequirement 返回此需求所有问题（含 replies）", () => {
    createQuestion({ id: "qst-002", requirement_id: reqId, agent_text: "Q2?" });
    const list = listQuestionsByRequirement(reqId);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("qst-001");
    expect(list[1].id).toBe("qst-002");
  });

  it("nextQuestionId 生成 qst-NNN 递增", () => {
    const id = nextQuestionId();
    expect(id.startsWith("qst-")).toBe(true);
  });
});
