import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";

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
