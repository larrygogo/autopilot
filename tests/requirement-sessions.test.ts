import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m033 } from "../src/migrations/033-requirement-sessions";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createRequirement } from "../src/core/requirements";
import {
  getSession,
  upsertSession,
  deleteSession,
  SNAPSHOT_MAX_TURNS,
  type ConversationTurn,
} from "../src/core/requirement-sessions";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m024, m033].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
  createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "" });
  createRequirement({ id: "r2", project_id: "p1", title: "T2", spec_md: "" });
}

describe("requirement-sessions CRUD", () => {
  beforeEach(() => {
    initSchema();
  });

  it("getSession 不存在时返回 null", () => {
    expect(getSession("r1")).toBeNull();
    expect(getSession("r1", "clarifying")).toBeNull();
  });

  it("upsertSession 首次创建", () => {
    const s = upsertSession("r1", "clarifying", {
      agent_session_ref: "session-abc",
      messages_snapshot: [],
    });
    expect(s.id).toMatch(/^sess-\d{3}$/);
    expect(s.requirement_id).toBe("r1");
    expect(s.session_type).toBe("clarifying");
    expect(s.agent_session_ref).toBe("session-abc");
    expect(s.messages_snapshot).toEqual([]);
    expect(s.created_at).toBeTruthy();
    expect(s.updated_at).toBeTruthy();
  });

  it("upsertSession 更新已有 session", () => {
    upsertSession("r1", "clarifying", { agent_session_ref: "session-1" });
    const s = upsertSession("r1", "clarifying", { agent_session_ref: "session-2" });
    expect(s.agent_session_ref).toBe("session-2");
  });

  it("upsertSession 只传 agent_session_ref 时 messages_snapshot 保持原值", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    upsertSession("r1", "clarifying", { messages_snapshot: turns });
    const s = upsertSession("r1", "clarifying", { agent_session_ref: "new-ref" });
    expect(s.messages_snapshot).toEqual(turns);
    expect(s.agent_session_ref).toBe("new-ref");
  });

  it("upsertSession snapshot 超出 SNAPSHOT_MAX_TURNS 时截断", () => {
    // 创建 24 条（12 轮），超出 SNAPSHOT_MAX_TURNS=20
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push({ role: "user", content: `q${i}` });
      turns.push({ role: "assistant", content: `a${i}` });
    }
    expect(turns.length).toBe(24);

    const s = upsertSession("r1", "clarifying", { messages_snapshot: turns });
    expect(s.messages_snapshot.length).toBeLessThanOrEqual(SNAPSHOT_MAX_TURNS);
    // 截断后首条应为 user turn
    expect(s.messages_snapshot[0].role).toBe("user");
  });

  it("deleteSession 删除后 getSession 返回 null", () => {
    upsertSession("r1", "clarifying", { agent_session_ref: "x" });
    expect(getSession("r1")).not.toBeNull();
    deleteSession("r1");
    expect(getSession("r1")).toBeNull();
  });

  it("deleteSession 不存在的 session 不抛错", () => {
    expect(() => deleteSession("r1")).not.toThrow();
  });

  it("UNIQUE 约束：同 reqId + type 只保留一条", () => {
    upsertSession("r1", "clarifying", { agent_session_ref: "v1" });
    upsertSession("r1", "clarifying", { agent_session_ref: "v2" });
    // 读回应该只有一条记录
    const s = getSession("r1", "clarifying");
    expect(s?.agent_session_ref).toBe("v2");
  });

  it("不同 reqId 的 session 互不影响", () => {
    upsertSession("r1", "clarifying", { agent_session_ref: "s1" });
    upsertSession("r2", "clarifying", { agent_session_ref: "s2" });
    expect(getSession("r1")?.agent_session_ref).toBe("s1");
    expect(getSession("r2")?.agent_session_ref).toBe("s2");
    deleteSession("r1");
    expect(getSession("r1")).toBeNull();
    expect(getSession("r2")).not.toBeNull();
  });

  it("ID 自增：sess-001, sess-002, ...", () => {
    const s1 = upsertSession("r1", "clarifying", {});
    const s2 = upsertSession("r2", "clarifying", {});
    expect(s1.id).toBe("sess-001");
    expect(s2.id).toBe("sess-002");
  });

  it("snapshot 截断确保首条为 user turn（奇数开头去掉）", () => {
    // 制造一个 SNAPSHOT_MAX_TURNS + 1 条的数据，首条为 assistant
    const turns: ConversationTurn[] = [{ role: "assistant", content: "orphan" }];
    for (let i = 0; i < SNAPSHOT_MAX_TURNS; i++) {
      turns.push({ role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` });
    }
    // 总共 21 条，取最后 20 条后首条是 assistant（orphan 被裁），再找下一个 user
    const s = upsertSession("r1", "clarifying", { messages_snapshot: turns });
    expect(s.messages_snapshot[0].role).toBe("user");
  });
});
