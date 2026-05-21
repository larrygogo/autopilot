/**
 * Phase 5 — sendPromptToTask 三档分支测试（spec §3.8）
 *
 * 覆盖：
 *   - A 路径：running_* 排队进 task.extra.pending_prompts
 *   - B 路径：awaiting_* + 有 pending question → answerPending（mode=answered）
 *   - C 路径：终态拒绝（TASK_TERMINAL）
 *   - NO_PROMPT_TARGET：task 不存在
 *   - consumePendingPrompts 原子读 + 清
 *   - peekPendingPrompts 不清空
 *   - appendPendingPrompt 并发安全（多次 append 不丢条）
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
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { _setDbForTest, createTask, updateTask, appendPendingPrompt, getTask } from "../src/core/db";
import {
  sendPromptToTask,
  consumePendingPrompts,
  peekPendingPrompts,
} from "../src/core/task-send-prompt";
import { registerPending, answerPending, hasPending } from "../src/agents/pending-questions";

describe("sendPromptToTask 三档分支", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    [m001, m004, m005, m006, m007, m008, m009, m019].forEach((fn) => fn(db));
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM tasks");
  });

  it("A: running_* 排队到 pending_prompts", () => {
    createTask({
      id: "t-r1",
      title: "running",
      workflow: "dev",
      initialStatus: "running_design",
    });
    const r = sendPromptToTask("t-r1", "继续做 X", { source: "user" });
    expect(r.accepted).toBe(true);
    expect(r.mode).toBe("queued");

    const t = getTask("t-r1") as unknown as { pending_prompts?: Array<{ prompt: string; source: string }> };
    expect(t.pending_prompts?.length).toBe(1);
    expect(t.pending_prompts?.[0].prompt).toBe("继续做 X");
    expect(t.pending_prompts?.[0].source).toBe("user");
  });

  it("A: 多次 send 累积不丢条（appendPendingPrompt single-writer）", () => {
    createTask({ id: "t-r2", title: "x", workflow: "dev", initialStatus: "running_design" });
    sendPromptToTask("t-r2", "p1");
    sendPromptToTask("t-r2", "p2");
    sendPromptToTask("t-r2", "p3");

    const t = getTask("t-r2") as unknown as { pending_prompts?: Array<{ prompt: string }> };
    expect(t.pending_prompts?.map(x => x.prompt)).toEqual(["p1", "p2", "p3"]);
  });

  it("B: awaiting_* 有 pending question → answerPending（mode=answered）", async () => {
    createTask({ id: "t-aw", title: "x", workflow: "dev", initialStatus: "awaiting_review" });

    // mock 一个 pending question
    const captured: { value: string | null } = { value: null };
    registerPending("t-aw", {
      resolve: (a) => { captured.value = a; },
      reject: () => {},
      question: "你确认吗？",
      options: null,
      asked_at: "now",
      phase: "review",
    });
    expect(hasPending("t-aw")).toBe(true);

    const r = sendPromptToTask("t-aw", "确认", { source: "user" });
    expect(r.accepted).toBe(true);
    expect(r.mode).toBe("answered");
    expect(captured.value).toBe("确认");
    expect(hasPending("t-aw")).toBe(false);
  });

  it("B: awaiting_* 无 pending question → fall through 到 A 排队", () => {
    createTask({ id: "t-aw2", title: "x", workflow: "dev", initialStatus: "awaiting_review" });
    expect(hasPending("t-aw2")).toBe(false);

    const r = sendPromptToTask("t-aw2", "补一句");
    expect(r.accepted).toBe(true);
    expect(r.mode).toBe("queued");

    const t = getTask("t-aw2") as unknown as { pending_prompts?: Array<{ prompt: string }> };
    expect(t.pending_prompts?.length).toBe(1);
  });

  it("C: 终态 done 拒绝（TASK_TERMINAL）", () => {
    createTask({ id: "t-done", title: "x", workflow: "dev", initialStatus: "done" });
    const r = sendPromptToTask("t-done", "晚了");
    expect(r.accepted).toBe(false);
    expect(r.mode).toBe("rejected");
    expect(r.reason).toBe("TASK_TERMINAL");
  });

  it("C: 终态 failed / cancelled 同样拒绝", () => {
    createTask({ id: "t-fail", title: "x", workflow: "dev", initialStatus: "failed" });
    expect(sendPromptToTask("t-fail", "x").reason).toBe("TASK_TERMINAL");
    createTask({ id: "t-cancel", title: "x", workflow: "dev", initialStatus: "cancelled" });
    expect(sendPromptToTask("t-cancel", "x").reason).toBe("TASK_TERMINAL");
  });

  it("task 不存在 → NO_PROMPT_TARGET", () => {
    const r = sendPromptToTask("t-nope", "?");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("NO_PROMPT_TARGET");
  });

  it("空 prompt 拒绝（EMPTY_PROMPT）", () => {
    createTask({ id: "t-empty", title: "x", workflow: "dev", initialStatus: "running_design" });
    expect(sendPromptToTask("t-empty", "   ").reason).toBe("EMPTY_PROMPT");
    expect(sendPromptToTask("t-empty", "").reason).toBe("EMPTY_PROMPT");
  });
});

describe("consumePendingPrompts + peekPendingPrompts", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    [m001, m004, m005, m006, m007, m008, m009, m019].forEach((fn) => fn(db));
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM tasks");
  });

  it("consume 读 + 清，返回顺序与 append 一致", () => {
    createTask({ id: "t-c1", title: "x", workflow: "dev", initialStatus: "running_design" });
    appendPendingPrompt("t-c1", { prompt: "a", source: "user", queued_at: 1 });
    appendPendingPrompt("t-c1", { prompt: "b", source: "user", queued_at: 2 });

    const got = consumePendingPrompts("t-c1");
    expect(got).toEqual(["a", "b"]);

    // 第二次 consume 应返回空
    expect(consumePendingPrompts("t-c1")).toEqual([]);

    // peek 也是空
    expect(peekPendingPrompts("t-c1")).toEqual([]);
  });

  it("peek 不清空", () => {
    createTask({ id: "t-c2", title: "x", workflow: "dev", initialStatus: "running_design" });
    appendPendingPrompt("t-c2", { prompt: "p", source: "user", queued_at: 1 });

    expect(peekPendingPrompts("t-c2")).toEqual(["p"]);
    // 第二次 peek 仍能拿到（未消费）
    expect(peekPendingPrompts("t-c2")).toEqual(["p"]);
    // consume 才会清
    expect(consumePendingPrompts("t-c2")).toEqual(["p"]);
    expect(peekPendingPrompts("t-c2")).toEqual([]);
  });

  it("task 不存在 → consume/peek 返回 []", () => {
    expect(consumePendingPrompts("t-nope")).toEqual([]);
    expect(peekPendingPrompts("t-nope")).toEqual([]);
  });

  it("updateTask 覆盖 pending_prompts 也能清空（兜底）", () => {
    createTask({ id: "t-c3", title: "x", workflow: "dev", initialStatus: "running_design" });
    appendPendingPrompt("t-c3", { prompt: "x", source: "user", queued_at: 1 });
    updateTask("t-c3", { pending_prompts: [] });
    expect(peekPendingPrompts("t-c3")).toEqual([]);
  });
});
