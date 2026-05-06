import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { _setDbForTest, initDb } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import {
  createRequirement,
  getRequirementById,
  listRequirements,
  updateRequirement,
  setRequirementStatus,
  canTransitionStatus,
  nextRequirementId,
} from "../src/core/requirements";

describe("migration 005-requirements", () => {
  it("创建 requirements 表，含全部 spec 字段", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);

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
    // 执行各迁移，确保 repos / requirements 表存在
    migrate001(testDb);
    migrate002(testDb);
    migrate004(testDb);
    migrate005(testDb);
    // 准备关联的 repo 记录
    createRepo({ id: "repo-001", alias: "test", path: "/tmp/x", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    testDb.close();
  });

  it("createRequirement + getById 默认 status=drafting + created_at 是 number", () => {
    createRequirement({ id: "req-001", repo_id: "repo-001", title: "hello" });
    const r = getRequirementById("req-001");
    expect(r?.status).toBe("drafting");
    expect(typeof r?.created_at).toBe("number");
    expect(r?.spec_md).toBe("");
  });

  it("listRequirements 按 created_at 升序 + 过滤", () => {
    createRequirement({ id: "req-002", repo_id: "repo-001", title: "second" });
    const all = listRequirements({ repo_id: "repo-001" });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].id).toBe("req-001");
    const drafts = listRequirements({ repo_id: "repo-001", status: "drafting" });
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
});
