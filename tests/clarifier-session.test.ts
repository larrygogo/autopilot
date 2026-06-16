/**
 * clarifier session 路径单测 — 验证 session 复用逻辑的各种场景
 * 对应规格 §5.2
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { up as m015 } from "../src/migrations/015-clarifier-error";
import { up as m016 } from "../src/migrations/016-requirement-clarifier-override";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m032 } from "../src/migrations/032-requirement-attachments";
import { up as m034 } from "../src/migrations/034-requirement-sessions";
import { _setDbForTest, getDb } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  setRequirementStatus,
  getRequirementById,
  setActiveQuestionId,
} from "../src/core/requirements";
import { createComment, listComments } from "../src/core/requirements/comments";
import { enableBus, disableBus, emit } from "../src/core/event-bus";
import {
  runClarifierRound,
  _setClarifyFnForTest,
  _resetInflightForTest,
  initRequirementClarifier,
  disposeRequirementClarifier,
} from "../src/daemon/requirement-clarifier";
import { getSession, upsertSession } from "../src/core/requirements/sessions";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m021, m024, m032, m034].forEach(fn => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
}

describe("clarifier session 路径", () => {
  beforeEach(() => {
    initSchema();
    _resetInflightForTest();
    enableBus();
  });

  afterEach(() => {
    _setClarifyFnForTest(null);
    _resetInflightForTest();
    disableBus();
  });

  it("首轮（无 session，Anthropic）→ session 被创建", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    _setClarifyFnForTest(async (_prompt, _reqId, sessionRef) => {
      // 首轮 sessionRef 应为 undefined
      expect(sessionRef).toBeUndefined();
      return {
        rawText: JSON.stringify({
          new_spec_md: "改造后",
          summary: "结构化",
          next_question: { agent_text: "目标用户?", suggestions: [] },
          done: false,
        }),
        newSessionRef: "sess-abc",
      };
    });

    await runClarifierRound("r1");

    const session = getSession("r1", "clarifying");
    expect(session).not.toBeNull();
    expect(session!.agent_session_ref).toBe("sess-abc");
    expect(session!.messages_snapshot.length).toBe(2); // 1 user + 1 assistant
  });

  it("第 2 轮（session 有效，Anthropic）→ 增量 prompt + session 更新", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    // 模拟第 1 轮已完成：创建 resolved question + session
    createComment({
      id: "cmt-001",
      requirement_id: "r1",
      kind: "question",
      from_role: "agent",
      body: "目标用户是谁？",
      status: "resolved",
    });
    createComment({
      id: "cmt-002",
      requirement_id: "r1",
      kind: "question",
      from_role: "user",
      body: "开发者",
      parent_id: "cmt-001",
      status: "resolved",
    });
    upsertSession("r1", "clarifying", {
      agent_session_ref: "sess-abc",
      messages_snapshot: [
        { role: "user", content: "全量 prompt..." },
        { role: "assistant", content: "yaml output..." },
      ],
    });

    let capturedSessionRef: string | undefined;
    let capturedPrompt = "";
    _setClarifyFnForTest(async (prompt, _reqId, sessionRef) => {
      capturedSessionRef = sessionRef;
      capturedPrompt = prompt;
      return {
        rawText: JSON.stringify({
          new_spec_md: "更新后",
          summary: "补充目标用户",
          next_question: { agent_text: "范围?", suggestions: [] },
          done: false,
        }),
        newSessionRef: "sess-abc2",
      };
    });

    await runClarifierRound("r1");

    // 增量路径：sessionRef 非 undefined
    expect(capturedSessionRef).toBe("sess-abc");
    // 增量 prompt 不含首轮完整段落
    expect(capturedPrompt).not.toContain("# 任务");
    expect(capturedPrompt).toContain("用户已回答");

    // session 被更新
    const session = getSession("r1", "clarifying");
    expect(session!.agent_session_ref).toBe("sess-abc2");
    expect(session!.messages_snapshot.length).toBe(4); // 2 旧 + 2 新
  });

  it("session 失效（第一次抛异常，Anthropic）→ 清空 ref + 全量重建", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    // 模拟第 1 轮已完成
    createComment({
      id: "cmt-001",
      requirement_id: "r1",
      kind: "question",
      from_role: "agent",
      body: "Q1?",
      status: "resolved",
    });
    createComment({
      id: "cmt-002",
      requirement_id: "r1",
      kind: "question",
      from_role: "user",
      body: "A1",
      parent_id: "cmt-001",
      status: "resolved",
    });
    upsertSession("r1", "clarifying", {
      agent_session_ref: "sess-expired",
      messages_snapshot: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old response" },
      ],
    });

    let callCount = 0;
    const capturedRefs: (string | undefined)[] = [];
    _setClarifyFnForTest(async (_prompt, _reqId, sessionRef) => {
      callCount++;
      capturedRefs.push(sessionRef);
      if (callCount === 1) {
        throw new Error("session expired");
      }
      return {
        rawText: JSON.stringify({
          new_spec_md: "恢复后的 spec",
          summary: "重建",
          next_question: { agent_text: "Q2?", suggestions: [] },
          done: false,
        }),
        newSessionRef: "sess-new",
      };
    });

    await runClarifierRound("r1");

    // 第一次带 session，第二次不带
    expect(capturedRefs[0]).toBe("sess-expired");
    expect(capturedRefs[1]).toBeUndefined();
    // session 被更新为新的
    const session = getSession("r1", "clarifying");
    expect(session!.agent_session_ref).toBe("sess-new");
  });

  it("非 Anthropic provider 第 1 轮（OpenAI）→ session 创建但 ref=null", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    // 设置 clarifier_provider = openai
    getDb().run("UPDATE requirements SET clarifier_provider = 'openai' WHERE id = 'r1'");
    setRequirementStatus("r1", "clarifying");

    let capturedSessionRef: string | undefined = "should-be-undefined";
    _setClarifyFnForTest(async (_prompt, _reqId, sessionRef) => {
      capturedSessionRef = sessionRef;
      return {
        rawText: JSON.stringify({
          new_spec_md: "spec",
          summary: "ok",
          next_question: { agent_text: "Q?", suggestions: [] },
          done: false,
        }),
        newSessionRef: undefined,
      };
    });

    await runClarifierRound("r1");

    // 非 Anthropic 不传 sessionRef
    expect(capturedSessionRef).toBeUndefined();
    // session 被创建但 ref 为 null
    const session = getSession("r1", "clarifying");
    expect(session).not.toBeNull();
    expect(session!.agent_session_ref).toBeNull();
  });

  it("非 Anthropic 第 2 轮+ prompt 结构不变（N-1 回归检验）", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    getDb().run("UPDATE requirements SET clarifier_provider = 'openai' WHERE id = 'r1'");
    setRequirementStatus("r1", "clarifying");

    // 模拟第 1 轮已完成 + snapshot 已存在
    createComment({
      id: "cmt-001",
      requirement_id: "r1",
      kind: "question",
      from_role: "agent",
      body: "Q1?",
      status: "resolved",
    });
    createComment({
      id: "cmt-002",
      requirement_id: "r1",
      kind: "question",
      from_role: "user",
      body: "A1",
      parent_id: "cmt-001",
      status: "resolved",
    });
    upsertSession("r1", "clarifying", {
      agent_session_ref: null,
      messages_snapshot: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old response" },
      ],
    });

    let capturedPrompt = "";
    let capturedSessionRef: string | undefined = "should-be-undefined";
    _setClarifyFnForTest(async (prompt, _reqId, sessionRef) => {
      capturedPrompt = prompt;
      capturedSessionRef = sessionRef;
      return {
        rawText: JSON.stringify({
          new_spec_md: "更新后",
          summary: "x",
          next_question: { agent_text: "Q2?", suggestions: [] },
          done: false,
        }),
        newSessionRef: undefined,
      };
    });

    await runClarifierRound("r1");

    // N-1 核心验证：非 Anthropic 第 2 轮
    // 1. prompt 应含 qaHistory 段（原路径）
    expect(capturedPrompt).toContain("# 已完成的 Q&A 历史");
    expect(capturedPrompt).toContain("Q1：Q1?");
    // 2. prompt 不含 messagesReplay 段
    expect(capturedPrompt).not.toContain("# 上一次澄清会话记录");
    // 3. sessionRef 为 undefined
    expect(capturedSessionRef).toBeUndefined();
  });

  it("replay 无重叠（Anthropic session 失效 + snapshot 存在）", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");

    // 有历史 Q&A
    createComment({
      id: "cmt-001",
      requirement_id: "r1",
      kind: "question",
      from_role: "agent",
      body: "Q1?",
      status: "resolved",
    });
    createComment({
      id: "cmt-002",
      requirement_id: "r1",
      kind: "question",
      from_role: "user",
      body: "A1",
      parent_id: "cmt-001",
      status: "resolved",
    });
    // session 存在但 ref 为 null（模拟过期）
    upsertSession("r1", "clarifying", {
      agent_session_ref: null,
      messages_snapshot: [
        { role: "user", content: "历史 prompt" },
        { role: "assistant", content: "历史回复" },
      ],
    });

    let capturedPrompt = "";
    _setClarifyFnForTest(async (prompt, _reqId, _sessionRef) => {
      capturedPrompt = prompt;
      return {
        rawText: JSON.stringify({
          new_spec_md: "replay后",
          summary: "ok",
          next_question: { agent_text: "Q2?", suggestions: [] },
          done: false,
        }),
        newSessionRef: "sess-new",
      };
    });

    await runClarifierRound("r1");

    // qaHistory 段应为空（(暂无)）
    expect(capturedPrompt).toContain("# 已完成的 Q&A 历史\n\n(暂无)");
    // messagesReplay 段应存在
    expect(capturedPrompt).toContain("# 上一次澄清会话记录");
    expect(capturedPrompt).toContain("历史 prompt");
    expect(capturedPrompt).toContain("历史回复");
  });

  it("终态清理 done → deleteSession 被调用", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "ok" });
    setRequirementStatus("r1", "clarifying");

    // 写入一个 session
    upsertSession("r1", "clarifying", { agent_session_ref: "sess-x" });
    expect(getSession("r1")).not.toBeNull();

    // 初始化 clarifier（注册 statusHandler）
    initRequirementClarifier();

    // 模拟状态切换到终态
    _setClarifyFnForTest(async () => ({
      rawText: JSON.stringify({ new_spec_md: "ok", summary: null, next_question: null, done: true }),
      newSessionRef: undefined,
    }));

    // 发送终态事件
    emit({ type: "requirement:status-changed", payload: { id: "r1", from: "clarifying", to: "done" } });

    // session 应该被清理
    expect(getSession("r1")).toBeNull();

    disposeRequirementClarifier();
  });

  it("终态清理 cancelled → deleteSession 被调用", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "ok" });
    upsertSession("r1", "clarifying", { agent_session_ref: "sess-x" });

    initRequirementClarifier();
    emit({ type: "requirement:status-changed", payload: { id: "r1", from: "clarifying", to: "cancelled" } });
    expect(getSession("r1")).toBeNull();
    disposeRequirementClarifier();
  });

  it("终态清理 failed → deleteSession 被调用", async () => {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "ok" });
    upsertSession("r1", "clarifying", { agent_session_ref: "sess-x" });

    initRequirementClarifier();
    emit({ type: "requirement:status-changed", payload: { id: "r1", from: "clarifying", to: "failed" } });
    expect(getSession("r1")).toBeNull();
    disposeRequirementClarifier();
  });

  // 增量路径（Anthropic + 有效 session + 已解答 Q&A）的前置夹具
  function seedIncremental(ref = "sess-valid"): void {
    createRequirement({ id: "r1", project_id: "p1", title: "T", spec_md: "初稿" });
    setRequirementStatus("r1", "clarifying");
    createComment({ id: "cmt-001", requirement_id: "r1", kind: "question", from_role: "agent", body: "Q1?", status: "resolved" });
    createComment({ id: "cmt-002", requirement_id: "r1", kind: "question", from_role: "user", body: "A1", parent_id: "cmt-001", status: "resolved" });
    upsertSession("r1", "clarifying", {
      agent_session_ref: ref,
      messages_snapshot: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old response" },
      ],
    });
  }

  it("解析失败 → 下一轮 attempt 注入纠错前言（#15）", async () => {
    seedIncremental();

    const capturedPrompts: string[] = [];
    let call = 0;
    _setClarifyFnForTest(async (prompt) => {
      capturedPrompts.push(prompt);
      call++;
      if (call === 1) {
        // 解析失败：返回非对象纯文本，parseLlmYamlWrapper 抛 /不是对象/（确定性格式错）
        return { rawText: "这不是 YAML 对象只是一段普通说明文字", newSessionRef: "sess-x" };
      }
      return {
        rawText: JSON.stringify({
          new_spec_md: "恢复后",
          summary: "ok",
          next_question: { agent_text: "Q2?", suggestions: [] },
          done: false,
        }),
        newSessionRef: "sess-new",
      };
    });

    await runClarifierRound("r1");

    expect(capturedPrompts.length).toBe(2);
    // 首轮走增量 prompt（含「用户已回答」），不含纠错前言
    expect(capturedPrompts[0]).toContain("用户已回答");
    expect(capturedPrompts[0]).not.toContain("你上一次的输出无法解析");
    // 次轮 = 纠错前言 + 全量 prompt 主体（fallback 用全量，故含 Q&A 历史段）。断言锁固定的前言
    // 文案，不依赖被插值进来的下游 llm-yaml 错误文案（否则改 llm-yaml 文案会让本 test 假红）。
    expect(capturedPrompts[1]).toContain("你上一次的输出无法解析");
    expect(capturedPrompts[1]).toContain("请严格只输出");
    expect(capturedPrompts[1]).toContain("已完成的 Q&A 历史");
  });

  it("两轮均解析失败（确定性格式错）→ 不清 session_ref（#18）", async () => {
    seedIncremental("sess-valid");

    // 两次都返回可调用但无法解析的输出 → isParseFailure，session 仍有效不该清
    _setClarifyFnForTest(async () => ({ rawText: "纯文本不是对象", newSessionRef: "sess-x" }));

    await runClarifierRound("r1");

    expect(getSession("r1", "clarifying")!.agent_session_ref).toBe("sess-valid");
    // 失败仍如实落库 clarifier_error（错误可见性不受影响）
    expect(getRequirementById("r1")!.clarifier_error).toBeTruthy();
  });

  it("两轮均调用失败（疑似 session 失效）→ 清空 session_ref（#18 对照）", async () => {
    seedIncremental("sess-valid");

    // 调用直接抛（attemptRaw 始终空）→ 非解析失败 → 首轮清 session_ref 走全量
    _setClarifyFnForTest(async () => {
      throw new Error("session expired");
    });

    await runClarifierRound("r1");

    expect(getSession("r1", "clarifying")!.agent_session_ref).toBeNull();
  });
});
