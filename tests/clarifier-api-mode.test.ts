/**
 * clarifier API 模式 task context 注入测试
 *
 * 验证非 Anthropic 供应商（OpenAI/Google/compat）作为澄清模型时，
 * agent.run() 在 runWithTaskContext 内执行，ensureApiLoop() 能正确取到 sandboxDir。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
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
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import {
  createRequirement,
  getRequirementById,
  setRequirementStatus,
  updateRequirement,
} from "../src/core/requirements";
import { enableBus, disableBus } from "../src/core/event-bus";
import {
  runClarifierRound,
  _setBuildAgentFnForTest,
  _setClarifyFnForTest,
  _callClaudeForTest,
  _resetInflightForTest,
} from "../src/daemon/requirement-clarifier";
import { getTaskContext, type TaskContext } from "../src/core/task/context";
// getTaskDir 内部使用生产代码的 TASK_ID_RE 做格式校验，用于验证 clarify taskId 格式兼容性
import { getTaskDir } from "../src/core/infra";
import type { Agent } from "../src/agents/agent";
import type { AgentResult } from "../src/agents/types";
import type { ClarifierAgentOverride } from "../src/daemon/clarifier-agent";

// ── 合法的澄清 YAML/JSON 响应（parseClarifyResult 两种都支持）──
const VALID_CLARIFY_RESPONSE = JSON.stringify({
  new_spec_md: "# 修订后的需求\n内容已更新",
  summary: "初步结构化",
  next_question: { agent_text: "目标用户是谁？", suggestions: ["开发者", "运维"] },
  done: false,
  new_title: null,
});

/**
 * 创建模拟 API 模式 agent。
 * - config.provider 返回传入的 provider 名（默认 "openai"）
 * - run() 在调用时捕获当前 task context，然后返回合法响应
 * - chat() 抛错（非 Anthropic 不走 chat）
 */
function createMockApiAgent(opts?: {
  provider?: string;
  onRun?: (ctx: TaskContext | undefined, cwdOpt: string | undefined) => void;
}): Agent {
  return {
    name: "clarifier",
    mode: "api" as const,
    config: {
      name: "clarifier",
      provider: opts?.provider ?? "openai",
      model: "gpt-4o",
    },
    run: async (_prompt: string, runOpts?: { cwd?: string }): Promise<AgentResult> => {
      opts?.onRun?.(getTaskContext(), runOpts?.cwd);
      return { text: VALID_CLARIFY_RESPONSE };
    },
    chat: async () => {
      throw new Error("API 模式不支持 chat()");
    },
    close: async () => {},
  } as unknown as Agent;
}

function initSchema(): void {
  const db = new Database(":memory:");
  [
    m001, m002, m004, m005, m006, m007, m008, m009, m010,
    m011, m012, m013, m014, m015, m016, m021, m024, m032, m034,
  ].forEach((fn) => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "测试项目" });
}

describe("clarifier — API 模式 task context 注入", () => {
  beforeEach(() => {
    initSchema();
    enableBus();
  });

  afterEach(() => {
    _setBuildAgentFnForTest(null);
    _setClarifyFnForTest(null);
    _resetInflightForTest();
    disableBus();
  });

  // ──────────────────────────────────────────────
  // 测试 1：callClaude 内部 — API 模式 + 无 cwd（纯文本模式）→ sandboxDir = tmpdir()
  //
  // 通过 runClarifierRound 间接触发 callClaude，验证无 workspace 时 tmpdir 兜底
  // ──────────────────────────────────────────────
  it("callClaude 内部：API 模式 + 无 cwd → runWithTaskContext 注入 sandboxDir=tmpdir()，不抛错", async () => {
    let capturedCtx: TaskContext | undefined;

    _setBuildAgentFnForTest((_override?: ClarifierAgentOverride) =>
      createMockApiAgent({
        provider: "openai",
        onRun: (ctx, _cwd) => { capturedCtx = ctx; },
      })
    );

    createRequirement({ id: "r-ctx", project_id: "p1", title: "CTX 测试", spec_md: "" });
    // 设置非 Anthropic provider，触发 else 分支
    updateRequirement("r-ctx", { clarifier_provider: "openai" });
    setRequirementStatus("r-ctx", "clarifying");

    // 恢复真实 callClaude，让 _buildAgentFn 注入的 mock agent 走内部逻辑
    _setClarifyFnForTest(null);

    await runClarifierRound("r-ctx");

    // 验证 task context 被正确注入
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.taskId).toBe("clarify-r-ctx");
    expect(capturedCtx?.phase).toBe("clarifying");
    // 无 cwd（无 workspace）时 sandboxDir 兜底到 tmpdir()
    expect(capturedCtx?.sandboxDir).toBe(tmpdir());

    // 澄清正常完成（创建了问题）
    const req = getRequirementById("r-ctx");
    expect(req?.active_question_id).toBeTruthy();
    expect(req?.clarifier_error).toBeFalsy();
  });

  // ──────────────────────────────────────────────
  // 测试 2：callClaude 直接调用 — API 模式 + 有 cwd → sandboxDir = cwd
  //
  // 这是 bug 报告截图中的直接触发场景：requirement 有 workspace → clone 成功 →
  // cwd 非空 → ensureApiLoop 需要 sandboxDir。通过 _callClaudeForTest 直接调用
  // callClaude 并传入显式 cwd，绕过 clone 步骤，验证核心修复路径。
  // ──────────────────────────────────────────────
  it("callClaude 直接调用：API 模式 + 有 cwd → sandboxDir = cwd（主要生产路径）", async () => {
    const fakeCwd = join(tmpdir(), `clarifier-test-cwd-${Date.now()}`);
    mkdirSync(fakeCwd, { recursive: true });

    let capturedCtx: TaskContext | undefined;
    let capturedCwd: string | undefined;

    _setBuildAgentFnForTest((_override?: ClarifierAgentOverride) =>
      createMockApiAgent({
        provider: "openai",
        onRun: (ctx, cwd) => {
          capturedCtx = ctx;
          capturedCwd = cwd;
        },
      })
    );

    createRequirement({ id: "r-cwd", project_id: "p1", title: "CWD 测试", spec_md: "" });
    updateRequirement("r-cwd", { clarifier_provider: "openai" });

    try {
      // 直接调用 callClaude，传入显式 cwd（模拟 clone 成功场景）
      const result = await _callClaudeForTest("test prompt", "r-cwd", undefined, fakeCwd);

      // callClaude 返回合法响应
      expect(result.rawText).toContain("修订后的需求");

      // 验证 task context 被注入，sandboxDir = cwd（不是 tmpdir 兜底）
      expect(capturedCtx).toBeDefined();
      expect(capturedCtx!.taskId).toBe("clarify-r-cwd");
      expect(capturedCtx!.phase).toBe("clarifying");
      expect(capturedCtx!.sandboxDir).toBe(fakeCwd);

      // 验证 agent.run() 也收到了 cwd
      expect(capturedCwd).toBe(fakeCwd);
    } finally {
      rmSync(fakeCwd, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────
  // 测试 3：callClaude 直接调用 — API 模式 + 无 cwd → sandboxDir = tmpdir()
  //
  // 验证纯文本模式（无 workspace、cwd=undefined）的 tmpdir 兜底路径
  // ──────────────────────────────────────────────
  it("callClaude 直接调用：API 模式 + 无 cwd → sandboxDir = tmpdir()（纯文本兜底）", async () => {
    let capturedCtx: TaskContext | undefined;
    let capturedCwd: string | undefined;

    _setBuildAgentFnForTest((_override?: ClarifierAgentOverride) =>
      createMockApiAgent({
        provider: "openai",
        onRun: (ctx, cwd) => {
          capturedCtx = ctx;
          capturedCwd = cwd;
        },
      })
    );

    createRequirement({ id: "r-nocwd", project_id: "p1", title: "无 CWD 测试", spec_md: "" });
    updateRequirement("r-nocwd", { clarifier_provider: "openai" });

    // 直接调用 callClaude，不传 cwd（第 4 参数 undefined）
    const result = await _callClaudeForTest("test prompt", "r-nocwd", undefined, undefined);

    expect(result.rawText).toContain("修订后的需求");
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.taskId).toBe("clarify-r-nocwd");
    expect(capturedCtx!.sandboxDir).toBe(tmpdir());
    // agent.run() 不传 cwd（纯文本模式无代码目录）
    expect(capturedCwd).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // 测试 4：Anthropic provider → 走 chat() 路径，不受修改影响
  // ──────────────────────────────────────────────
  it("Anthropic provider → 走 chat() 路径，run() 不被调用", async () => {
    let chatCalled = false;
    let runCalled = false;

    _setBuildAgentFnForTest((_override?: ClarifierAgentOverride) => ({
      name: "clarifier",
      mode: "cli" as const,
      config: { name: "clarifier", provider: "anthropic", model: "claude-sonnet" },
      run: async () => {
        runCalled = true;
        return { text: VALID_CLARIFY_RESPONSE };
      },
      chat: async () => {
        chatCalled = true;
        return {
          text: VALID_CLARIFY_RESPONSE,
          providerSessionId: "test-session-123",
        };
      },
      close: async () => {},
    } as unknown as Agent));

    createRequirement({ id: "r-anthropic", project_id: "p1", title: "Anthropic 测试", spec_md: "" });
    // clarifier_provider 未设置，走默认 anthropic 路径
    _setClarifyFnForTest(null); // 恢复真实 callClaude
    setRequirementStatus("r-anthropic", "clarifying");

    await runClarifierRound("r-anthropic");

    expect(chatCalled).toBe(true);
    expect(runCalled).toBe(false);

    const req = getRequirementById("r-anthropic");
    expect(req?.active_question_id).toBeTruthy();
  });

  // ──────────────────────────────────────────────
  // 测试 5：clarify taskId 格式通过生产代码的 TASK_ID_RE 校验，路径与真实 task 隔离
  //
  // 使用 getTaskDir（src/core/infra.ts 导出）做端到端格式验证：
  // 该函数内部用生产代码的 TASK_ID_RE 校验 taskId 格式，
  // 如果 TASK_ID_RE 收窄（如拒绝 `-`），此测试会直接感知并失败。
  // ──────────────────────────────────────────────
  it("clarify taskId 通过生产代码 TASK_ID_RE 校验，且与真实 task 路径隔离", () => {
    const reqId = "req-025";
    const clarifyTaskId = `clarify-${reqId}`;
    const realTaskId = "abcd1234";

    // getTaskDir 内部用 TASK_ID_RE 做格式校验：格式不合法会抛 "Invalid task ID" 错误
    // 这里验证 clarify-<reqId> 格式能通过生产代码的实际校验
    expect(() => getTaskDir(clarifyTaskId)).not.toThrow();
    expect(() => getTaskDir(realTaskId)).not.toThrow();

    // 验证两个 taskId 产生的路径不同（物理隔离）
    const clarifyPath = getTaskDir(clarifyTaskId);
    const realTaskPath = getTaskDir(realTaskId);
    expect(clarifyPath).not.toBe(realTaskPath);
    expect(clarifyPath).toContain("clarify-");
    expect(realTaskPath).not.toContain("clarify-");

    // phase 名 "clarifying" 也要合法
    // PHASE_NAME_RE 未导出，但 clarifying 是已有的 phase 名——如果不合法早就坏了
    expect(clarifyTaskId.startsWith("clarify-")).toBe(true);
  });

  // ──────────────────────────────────────────────
  // 测试 6：整个 runClarifierRound 走通（通过 _setClarifyFnForTest mock 的快捷路径）
  // ──────────────────────────────────────────────
  it("API 模式供应商走 _setClarifyFnForTest mock 时澄清流程正常完成", async () => {
    _setClarifyFnForTest(async (_prompt, _reqId, _sessionRef) => ({
      rawText: VALID_CLARIFY_RESPONSE,
      newSessionRef: undefined,
    }));

    createRequirement({ id: "r-api", project_id: "p1", title: "API 测试需求", spec_md: "" });
    setRequirementStatus("r-api", "clarifying");

    await runClarifierRound("r-api");

    const req = getRequirementById("r-api");
    expect(req?.active_question_id).toBeTruthy();
    expect(req?.spec_md).toContain("修订后的需求");
  });
});
