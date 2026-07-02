/**
 * mirror-pusher 单元测试
 *
 * 验证：
 * 1. 事件 → mirror 事件类型映射正确
 * 2. mirror_seq 单调递增（per-link）
 * 3. 推送失败不抛（best-effort）
 * 4. 409 seq-gap 触发全量快照
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { enableBus, disableBus, emit } from "../../src/core/event-bus";
import { MirrorPusher } from "../../src/daemon/selfhosted-connector/mirror-pusher";
import type { MirrorEvent, MirrorSnapshot, ReqLink } from "../../src/daemon/selfhosted-connector/types";
import type { MirrorPusherDeps } from "../../src/daemon/selfhosted-connector/mirror-pusher";
import type { SelfhostedBackend } from "../../src/daemon/selfhosted-connector/backend";

// ── 测试工具 ─────────────────────────────────────────────────

interface MockBackend {
  backend: SelfhostedBackend;
  sentEvents: MirrorEvent[][];
  snapshots: MirrorSnapshot[];
  /** 设置 true 后下次 postMirrorEvents 返回 seqGap=true */
  seqGapOnNext: boolean;
  /** 设置 true 后下次 postMirrorEvents 抛出错误 */
  throwOnNext: boolean;
}

function makeMockBackend(): MockBackend {
  const state: MockBackend = {
    sentEvents: [],
    snapshots: [],
    seqGapOnNext: false,
    throwOnNext: false,
  } as Omit<MockBackend, "backend"> as MockBackend;

  const backend = {
    async postMirrorEvents(events: MirrorEvent[]) {
      if (state.throwOnNext) {
        state.throwOnNext = false;
        throw new Error("模拟网络错误");
      }
      const gap = state.seqGapOnNext;
      state.seqGapOnNext = false;
      state.sentEvents.push(events);
      return { seqGap: gap };
    },
    async postMirrorSnapshot(snapshot: MirrorSnapshot) {
      state.snapshots.push(snapshot);
    },
  } as unknown as SelfhostedBackend;

  state.backend = backend;
  return state;
}

function makeDeps(backend: SelfhostedBackend): MirrorPusherDeps {
  return {
    backend,
    getRequirement: (id) => ({
      id,
      title: "测试需求",
      status: "clarifying",
      spec_md: "spec",
      status_reason: null,
    }),
    listComments: () => [],
    listSubPrs: () => [],
    listPhaseEvents: () => [],
  };
}

// ── 测试 ─────────────────────────────────────────────────────

const REQ_ID = "req-test-001";
const REQGENIE_REQ_ID = "rg-uuid-001";
const ASSIGNMENT_ID = "assign-001";

function makeLink(): ReqLink {
  return {
    reqgenie_req_id: REQGENIE_REQ_ID,
    autopilot_req_id: REQ_ID,
    assignment_id: ASSIGNMENT_ID,
    mirror_seq: 0,
  };
}

describe("mirror-pusher", () => {
  let pusher: MirrorPusher;
  let mockBe: ReturnType<typeof makeMockBackend>;

  beforeEach(() => {
    enableBus();
    mockBe = makeMockBackend();
    pusher = new MirrorPusher(makeDeps(mockBe.backend));
    pusher.start();
    pusher.registerLink(makeLink());
  });

  afterEach(() => {
    pusher.dispose();
    disableBus();
  });

  // ── 测试 1：事件类型映射 ─────────────────────────────────────

  it("requirement:status-changed 映射为 status_changed 事件（payload.status=to）", async () => {
    emit({ type: "requirement:status-changed", payload: { id: REQ_ID, from: "drafting", to: "clarifying" } });
    // 等待防抖刷新（200ms + 余量）
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBeGreaterThan(0);
    const batch = mockBe.sentEvents[0];
    expect(batch.length).toBeGreaterThan(0);
    expect(batch[0].type).toBe("status_changed");
    // reqgenie 读取 payload.status（非 payload.to）
    expect(batch[0].payload["status"]).toBe("clarifying");
    expect(batch[0].payload["to"]).toBeUndefined();
  });

  it("requirement:spec-revised 映射为 spec_revised 事件（payload.spec_md）", async () => {
    emit({ type: "requirement:spec-revised", payload: { id: REQ_ID, revision_id: 1 } });
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBeGreaterThan(0);
    const batch = mockBe.sentEvents.flat();
    const found = batch.find((e) => e.type === "spec_revised");
    expect(found).toBeDefined();
    // reqgenie 读取 payload.spec_md（非 payload.revision_id）
    expect(found?.payload["spec_md"]).toBe("spec"); // getRequirement mock 返回 spec_md: "spec"
    expect(found?.payload["revision_id"]).toBeUndefined();
  });

  it("requirement:questions-updated 映射为 clarify_updated 事件", async () => {
    emit({ type: "requirement:questions-updated", payload: { id: REQ_ID } });
    await new Promise((r) => setTimeout(r, 350));
    const batch = mockBe.sentEvents.flat();
    expect(batch.some((e) => e.type === "clarify_updated")).toBe(true);
  });

  it("phase:started 触发全量快照推送（postMirrorSnapshot 被调用）", async () => {
    // 注册 task → req 映射
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:started", payload: { taskId: "task-abc", phase: "develop", label: "开发" } });
    // 等待防抖快照触发（SNAPSHOT_DEBOUNCE_MS=300ms + 余量）
    await new Promise((r) => setTimeout(r, 500));
    expect(mockBe.snapshots.length).toBeGreaterThan(0);
    expect(mockBe.snapshots[0].autopilot_req_id).toBe(REQ_ID);
    // 不再以 phase_progress 增量事件形式推送
    const batch = mockBe.sentEvents.flat();
    expect(batch.find((e) => e.type === "phase_progress")).toBeUndefined();
  });

  it("phase:completed 触发全量快照推送（postMirrorSnapshot 被调用）", async () => {
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:completed", payload: { taskId: "task-abc", phase: "develop" } });
    await new Promise((r) => setTimeout(r, 500));
    expect(mockBe.snapshots.length).toBeGreaterThan(0);
    expect(mockBe.snapshots[0].autopilot_req_id).toBe(REQ_ID);
  });

  it("phase:error 触发全量快照推送（postMirrorSnapshot 被调用）", async () => {
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:error", payload: { taskId: "task-abc", phase: "develop", error: "LLM 失败" } });
    await new Promise((r) => setTimeout(r, 500));
    expect(mockBe.snapshots.length).toBeGreaterThan(0);
    expect(mockBe.snapshots[0].autopilot_req_id).toBe(REQ_ID);
  });

  // ── 测试 2：mirror_seq 单调递增 ─────────────────────────────

  it("mirror_seq 在多次事件中单调递增", async () => {
    emit({ type: "requirement:status-changed", payload: { id: REQ_ID, from: "drafting", to: "clarifying" } });
    emit({ type: "requirement:spec-revised", payload: { id: REQ_ID, revision_id: 1 } });
    emit({ type: "requirement:questions-updated", payload: { id: REQ_ID } });
    await new Promise((r) => setTimeout(r, 500));

    const allEvents = mockBe.sentEvents.flat();
    expect(allEvents.length).toBeGreaterThanOrEqual(3);

    // 验证单调递增（可能在同一批次 or 不同批次）
    for (let i = 1; i < allEvents.length; i++) {
      expect(allEvents[i].mirror_seq).toBeGreaterThan(allEvents[i - 1].mirror_seq);
    }
  });

  // ── 测试 3：best-effort，推送失败不抛 ────────────────────────

  it("postMirrorEvents 抛出时不影响调用方（best-effort）", async () => {
    // 强制下一次 postMirrorEvents 抛出
    mockBe.throwOnNext = true;

    // 触发事件——不应该让测试 Promise reject 或未 catch 的 rejection
    expect(() => {
      emit({ type: "requirement:status-changed", payload: { id: REQ_ID, from: "drafting", to: "clarifying" } });
    }).not.toThrow();

    // 等待防抖 + 异步
    await new Promise((r) => setTimeout(r, 500));
    // 不需要 assert 具体值，只要没有 unhandled rejection 就是测试通过
    expect(true).toBe(true);
  });

  // ── 测试 4：409 seq-gap 触发全量快照 ─────────────────────────

  it("postMirrorEvents 返回 seqGap=true 时触发 postMirrorSnapshot", async () => {
    mockBe.seqGapOnNext = true;

    emit({ type: "requirement:status-changed", payload: { id: REQ_ID, from: "drafting", to: "clarifying" } });
    // 等待防抖 + snapshot 异步（extra 200ms）
    await new Promise((r) => setTimeout(r, 700));

    expect(mockBe.snapshots.length).toBeGreaterThan(0);
    const snapshot = mockBe.snapshots[0];
    expect(snapshot.autopilot_req_id).toBe(REQ_ID);
    // reqgenie ingest_mirror_snapshot 读取 mirror_status（非 status）
    expect(snapshot.mirror_status).toBe("clarifying");
  });

  // ── 测试 5：未注册 link 的事件被忽略 ─────────────────────────

  it("未注册 link 的 req_id 事件不会推送", async () => {
    emit({ type: "requirement:status-changed", payload: { id: "unknown-req", from: "drafting", to: "clarifying" } });
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBe(0);
  });

  // ── 测试 6：clarify_updated 携带 questions 数组 ─────────────

  it("requirement:questions-updated 发出的 clarify_updated 含 questions 数组", async () => {
    // 构造带真实问题的 deps
    const beWithQ = makeMockBackend();
    const depsWithQ: MirrorPusherDeps = {
      backend: beWithQ.backend,
      getRequirement: (id) => ({
        id,
        title: "测试需求",
        status: "clarifying",
        spec_md: "spec",
        status_reason: null,
      }),
      listComments: () => [
        { id: "qst-1", parent_id: null, kind: "question", from_role: "agent", body: "请描述具体场景", status: "open", created_at: 1, suggestions: null },
        { id: "qst-2", parent_id: "qst-1", kind: "question", from_role: "user", body: "用于电商场景", status: "resolved", created_at: 2, suggestions: null },
      ],
      listSubPrs: () => [],
      listPhaseEvents: () => [],
    };
    const pusherQ = new MirrorPusher(depsWithQ);
    pusherQ.start();
    pusherQ.registerLink(makeLink());

    emit({ type: "requirement:questions-updated", payload: { id: REQ_ID } });
    await new Promise((r) => setTimeout(r, 350));

    pusherQ.dispose();

    const allEvents = beWithQ.sentEvents.flat();
    const cuEv = allEvents.find((e) => e.type === "clarify_updated");
    expect(cuEv).toBeDefined();
    const questions = cuEv?.payload["questions"] as Array<{ autopilot_question_id: string; status: string }>;
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBe(2);
    expect(questions[0].autopilot_question_id).toBe("qst-1");
    expect(questions[1].autopilot_question_id).toBe("qst-2");
    expect(questions[1].status).toBe("resolved");
  });

  // ── 测试 7：snapshot 字段名为 mirror_status ──────────────────

  it("pushSnapshot 发出的快照含 mirror_status 字段（无 status 字段）", async () => {
    await pusher.pushSnapshot(REQ_ID);
    expect(mockBe.snapshots.length).toBeGreaterThan(0);
    const snap = mockBe.snapshots[0] as unknown as Record<string, unknown>;
    expect(snap["mirror_status"]).toBe("clarifying");
    expect(snap["status"]).toBeUndefined();
  });

  // ── 测试 8：snapshot.phases 字段名对齐 reqgenie 接收端 ─────────

  it("pushSnapshot 的 phases 项使用 status+finished_at（不是 state/ended_at）", async () => {
    const beWithPhase = makeMockBackend();
    const depsWithPhase: MirrorPusherDeps = {
      backend: beWithPhase.backend,
      getRequirement: (id) => ({
        id,
        title: "测试需求",
        status: "running",
        spec_md: "spec",
        status_reason: null,
      }),
      listComments: () => [],
      listSubPrs: () => [],
      listPhaseEvents: () => [
        {
          run_seq: 1,
          phase: "develop",
          label: "开发",
          state: "completed",
          started_at: "2026-01-01T00:00:00.000Z",
          ended_at: "2026-01-01T01:00:00.000Z",
          seq: 0,
        },
      ],
    };
    const pusherP = new MirrorPusher(depsWithPhase);
    pusherP.start();
    pusherP.registerLink(makeLink());

    await pusherP.pushSnapshot(REQ_ID);
    pusherP.dispose();

    expect(beWithPhase.snapshots.length).toBeGreaterThan(0);
    const phases = beWithPhase.snapshots[0].phases;
    expect(phases.length).toBe(1);
    // reqgenie 接收端读取 status + finished_at
    expect(phases[0].status).toBe("completed");
    expect(phases[0].finished_at).toBe("2026-01-01T01:00:00.000Z");
    // 不得出现旧字段名
    expect((phases[0] as unknown as Record<string, unknown>)["state"]).toBeUndefined();
    expect((phases[0] as unknown as Record<string, unknown>)["ended_at"]).toBeUndefined();
  });

  // ── 测试 9：snapshot.prs 字段名对齐 reqgenie 接收端 ───────────

  it("pushSnapshot 的 prs 项使用 pr_status（不是 pr_state）", async () => {
    const beWithPr = makeMockBackend();
    const depsWithPr: MirrorPusherDeps = {
      backend: beWithPr.backend,
      getRequirement: (id) => ({
        id,
        title: "测试需求",
        status: "awaiting_review",
        spec_md: "spec",
        status_reason: null,
      }),
      listComments: () => [],
      listSubPrs: () => [
        {
          repo_alias: "main",
          pr_url: "https://github.com/org/repo/pull/42",
          pr_state: "open",
          last_reviewed_event_id: null,
        },
      ],
      listPhaseEvents: () => [],
    };
    const pusherPr = new MirrorPusher(depsWithPr);
    pusherPr.start();
    pusherPr.registerLink(makeLink());

    await pusherPr.pushSnapshot(REQ_ID);
    pusherPr.dispose();

    expect(beWithPr.snapshots.length).toBeGreaterThan(0);
    const prs = beWithPr.snapshots[0].prs;
    expect(prs.length).toBe(1);
    // reqgenie 接收端读取 pr_status
    expect(prs[0].pr_url).toBe("https://github.com/org/repo/pull/42");
    expect(prs[0].pr_status).toBe("open");
    // 不得出现旧字段名
    expect((prs[0] as unknown as Record<string, unknown>)["pr_state"]).toBeUndefined();
  });
});
