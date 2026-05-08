import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { _setDbForTest, initDb } from "../src/core/db";
import { createCodebase } from "../src/core/codebases";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  listRequirements,
  listRequirementsByProject,
  updateRequirement,
  setRequirementStatus,
  canTransitionStatus,
  nextRequirementId,
} from "../src/core/requirements";
import {
  appendFeedback,
  listFeedbacks,
  latestFeedback,
} from "../src/core/requirement-feedbacks";

describe("migration 005-requirements（pre-008 schema 验证）", () => {
  it("创建 requirements 表，含全部 spec 字段", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirements)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "chat_session_id",
      "created_at",
      "id",
      "last_reviewed_event_id",
      "pr_number",
      "pr_url",
      "repo_id",
      "spec_md",
      "status",
      "task_id",
      "title",
      "updated_at",
    ]);
  });

  it("创建 requirement_feedbacks 表", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_feedbacks)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "body",
      "created_at",
      "github_review_id",
      "id",
      "requirement_id",
      "source",
    ]);
  });

  it("requirements.repo_id 引用 repos.id（FK 启用时）", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    db.exec("PRAGMA foreign_keys = ON;");
    expect(() => {
      db.run(
        "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        ["req-001", "no-such-repo", "x", "drafting", "", 1, 1]
      );
    }).toThrow();
  });

  it("索引正确创建", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    const idxs = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('requirements','requirement_feedbacks')"
      )
      .all()
      .map(i => i.name)
      .sort();
    // 至少包含我们建的 4 个 index
    expect(idxs.some(n => n.includes("requirements_repo"))).toBe(true);
    expect(idxs.some(n => n.includes("requirements_status"))).toBe(true);
    expect(idxs.some(n => n.includes("requirements_repo_status"))).toBe(true);
    expect(idxs.some(n => n.includes("feedbacks_req"))).toBe(true);
  });
});

describe("requirements CRUD + 状态机", () => {
  let testDb: Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    _setDbForTest(testDb);
    // initDb 执行 PRAGMA + tasks/task_logs 表建立
    initDb();
    // 执行各迁移，确保 codebases / requirements 表存在
    migrate001(testDb);
    migrate002(testDb);
    migrate004(testDb);
    migrate005(testDb);
    migrate006(testDb);
    migrate007(testDb);
    migrate008(testDb);
    // 准备关联的 project + codebase 记录
    createProject({ id: "proj-001", name: "test-proj" });
    createCodebase({ id: "cb-001", project_id: "proj-001", alias: "test", path: "/tmp/x", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    testDb.close();
  });

  it("createRequirement + getById 默认 status=drafting + created_at 是 number", () => {
    createRequirement({ id: "req-001", project_id: "proj-001", codebase_id: "cb-001", title: "hello" });
    const r = getRequirementById("req-001");
    expect(r?.status).toBe("drafting");
    expect(typeof r?.created_at).toBe("number");
    expect(r?.spec_md).toBe("");
  });

  it("listRequirements 按 created_at 升序 + 过滤", () => {
    createRequirement({ id: "req-002", project_id: "proj-001", codebase_id: "cb-001", title: "second" });
    const all = listRequirements({ codebase_id: "cb-001" });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].id).toBe("req-001");
    const drafts = listRequirements({ codebase_id: "cb-001", status: "drafting" });
    expect(drafts.every(r => r.status === "drafting")).toBe(true);
  });

  it("setStatus 合法转换链：drafting → clarifying → ready → queued", () => {
    setRequirementStatus("req-001", "clarifying");
    expect(getRequirementById("req-001")?.status).toBe("clarifying");
    setRequirementStatus("req-001", "ready");
    setRequirementStatus("req-001", "queued");
    expect(getRequirementById("req-001")?.status).toBe("queued");
  });

  it("setStatus 非法转换 throw", () => {
    expect(() => setRequirementStatus("req-001", "drafting")).toThrow(/非法状态转换/);
  });

  it("queued → ready 合法（P2 enqueue 失败回滚需要）", () => {
    setRequirementStatus("req-001", "ready");
    expect(getRequirementById("req-001")?.status).toBe("ready");
  });

  it("canTransitionStatus 表对照", () => {
    expect(canTransitionStatus("drafting", "ready")).toBe(true);
    expect(canTransitionStatus("done", "running")).toBe(false);
    expect(canTransitionStatus("queued", "ready")).toBe(true);
    expect(canTransitionStatus("queued", "running")).toBe(true);
    expect(canTransitionStatus("failed", "queued")).toBe(true);
    expect(canTransitionStatus("done", "queued")).toBe(false);
  });

  it("updateRequirement 部分字段 + 不改 status", () => {
    const before = getRequirementById("req-001");
    updateRequirement("req-001", { spec_md: "## 标题\n内容" });
    const after = getRequirementById("req-001");
    expect(after?.spec_md).toContain("内容");
    expect(after?.status).toBe(before?.status);
    expect((after?.updated_at ?? 0)).toBeGreaterThanOrEqual(before?.updated_at ?? 0);
  });

  it("updateRequirement 空 opts no-op", () => {
    const before = getRequirementById("req-001");
    updateRequirement("req-001", {});
    const after = getRequirementById("req-001");
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("nextRequirementId 自增", () => {
    const next = nextRequirementId();
    expect(next).toMatch(/^req-\d{3}$/);
    const num = parseInt(next.replace("req-", ""), 10);
    expect(num).toBeGreaterThanOrEqual(3); // 已有 req-001, req-002
  });

  it("appendFeedback + listFeedbacks 升序", () => {
    appendFeedback({ requirement_id: "req-001", source: "manual", body: "first" });
    appendFeedback({ requirement_id: "req-001", source: "manual", body: "second" });
    const list = listFeedbacks("req-001");
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].body).toBe("first");
    expect(list[list.length - 1].body).toBe("second");
  });

  it("latestFeedback 取最新", () => {
    const latest = latestFeedback("req-001");
    expect(latest?.body).toBe("second");
  });

  it("不同 requirement 隔离", () => {
    const list = listFeedbacks("req-no-such");
    expect(list).toEqual([]);
  });

  it("github_review_id 可选，默认 null", () => {
    const f = appendFeedback({ requirement_id: "req-001", source: "manual", body: "no review id" });
    expect(f.github_review_id).toBeNull();
  });

  it("github_review_id 可填", () => {
    const f = appendFeedback({
      requirement_id: "req-001",
      source: "github_review",
      body: "请改 X",
      github_review_id: "PRR_kwDOMZkX1c5sample",
    });
    expect(f.github_review_id).toBe("PRR_kwDOMZkX1c5sample");
    expect(f.source).toBe("github_review");
  });
});

describe("requirements 适配 project + codebase（P1 Task 14）", () => {
  let testDb: Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    _setDbForTest(testDb);
    initDb();
    migrate001(testDb);
    migrate002(testDb);
    migrate004(testDb);
    migrate005(testDb);
    migrate006(testDb);
    migrate007(testDb);
    migrate008(testDb);
  });

  afterAll(() => {
    _setDbForTest(null);
    testDb.close();
  });

  it("Requirement 类型有 project_id 和 codebase_id（不再有 repo_id）", () => {
    const proj = createProject({ id: "proj-rt1", name: "rt" });
    const cb = createCodebase({ id: "cb-rt1", project_id: proj.id, alias: "rt", path: "/p" });
    const req = createRequirement({
      id: "req-rt1",
      project_id: proj.id,
      codebase_id: cb.id,
      title: "t",
    });
    expect(req.project_id).toBe(proj.id);
    expect(req.codebase_id).toBe(cb.id);
    expect((req as unknown as { repo_id?: unknown }).repo_id).toBeUndefined();
  });

  it("listRequirementsByProject 列出项目下所有需求", () => {
    const list = listRequirementsByProject("proj-rt1");
    expect(list.some((r) => r.id === "req-rt1")).toBe(true);
    expect(list.every((r) => r.project_id === "proj-rt1")).toBe(true);
  });

  it("createRequirement 自动写 requirement_codebases 关联", () => {
    const proj = createProject({ id: "proj-rt2", name: "rt2" });
    const cb = createCodebase({ id: "cb-rt2", project_id: proj.id, alias: "rt2", path: "/p2" });
    createRequirement({ id: "req-rt2", project_id: proj.id, codebase_id: cb.id, title: "t2" });

    const links = testDb
      .query<{ requirement_id: string; codebase_id: string }, []>(
        "SELECT requirement_id, codebase_id FROM requirement_codebases WHERE requirement_id = 'req-rt2'",
      )
      .all();
    expect(links).toEqual([{ requirement_id: "req-rt2", codebase_id: cb.id }]);
  });

  // P1 阶段 schema 仍保留 codebase_id NOT NULL（migration 008 §7 注释说明 P4 才表重建去掉 NOT NULL）；
  // 接口 TS 类型允许 null，但当前实际写入 null 会被 SQLite 拒绝。这里用接口校验代替 DB 写入。
  it("CreateRequirementOpts.codebase_id 可选（spec §5.1 NULLable，schema P4 落地）", () => {
    const opts: import("../src/core/requirements").CreateRequirementOpts = {
      id: "req-rt3",
      project_id: "proj-rt3",
      title: "t3",
    };
    expect(opts.codebase_id).toBeUndefined();
  });

  it("listRequirements 支持按 project_id 过滤", () => {
    const list = listRequirements({ project_id: "proj-rt2" });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("req-rt2");
  });
});
