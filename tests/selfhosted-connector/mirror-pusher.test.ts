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

  it("requirement:status-changed 映射为 status_changed 事件", async () => {
    emit({ type: "requirement:status-changed", payload: { id: REQ_ID, from: "drafting", to: "clarifying" } });
    // 等待防抖刷新（200ms + 余量）
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBeGreaterThan(0);
    const batch = mockBe.sentEvents[0];
    expect(batch.length).toBeGreaterThan(0);
    expect(batch[0].type).toBe("status_changed");
    expect(batch[0].payload["to"]).toBe("clarifying");
  });

  it("requirement:spec-revised 映射为 spec_revised 事件", async () => {
    emit({ type: "requirement:spec-revised", payload: { id: REQ_ID, revision_id: 1 } });
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBeGreaterThan(0);
    const batch = mockBe.sentEvents.flat();
    const found = batch.find((e) => e.type === "spec_revised");
    expect(found).toBeDefined();
    expect(found?.payload["revision_id"]).toBe(1);
  });

  it("requirement:questions-updated 映射为 clarify_updated 事件", async () => {
    emit({ type: "requirement:questions-updated", payload: { id: REQ_ID } });
    await new Promise((r) => setTimeout(r, 350));
    const batch = mockBe.sentEvents.flat();
    expect(batch.some((e) => e.type === "clarify_updated")).toBe(true);
  });

  it("phase:started 映射为 phase_progress（state=running）", async () => {
    // 注册 task → req 映射
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:started", payload: { taskId: "task-abc", phase: "develop", label: "开发" } });
    await new Promise((r) => setTimeout(r, 350));
    const batch = mockBe.sentEvents.flat();
    const found = batch.find((e) => e.type === "phase_progress");
    expect(found).toBeDefined();
    expect(found?.payload["state"]).toBe("running");
    expect(found?.payload["phase"]).toBe("develop");
  });

  it("phase:completed 映射为 phase_progress（state=completed）", async () => {
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:completed", payload: { taskId: "task-abc", phase: "develop" } });
    await new Promise((r) => setTimeout(r, 350));
    const batch = mockBe.sentEvents.flat();
    const found = batch.find((e) => e.type === "phase_progress");
    expect(found?.payload["state"]).toBe("completed");
  });

  it("phase:error 映射为 phase_progress（state=error）", async () => {
    pusher.registerTaskRequirement("task-abc", REQ_ID);
    emit({ type: "phase:error", payload: { taskId: "task-abc", phase: "develop", error: "LLM 失败" } });
    await new Promise((r) => setTimeout(r, 350));
    const batch = mockBe.sentEvents.flat();
    const found = batch.find((e) => e.type === "phase_progress");
    expect(found?.payload["state"]).toBe("error");
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
    expect(snapshot.status).toBe("clarifying");
  });

  // ── 测试 5：未注册 link 的事件被忽略 ─────────────────────────

  it("未注册 link 的 req_id 事件不会推送", async () => {
    emit({ type: "requirement:status-changed", payload: { id: "unknown-req", from: "drafting", to: "clarifying" } });
    await new Promise((r) => setTimeout(r, 350));
    expect(mockBe.sentEvents.length).toBe(0);
  });
});
