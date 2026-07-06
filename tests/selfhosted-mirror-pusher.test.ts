/**
 * MirrorPusher 单元测试
 *
 * 覆盖：
 * ① snapshot phases 字段名：status + finished_at（非 state/ended_at）
 * ② snapshot prs 字段名：pr_status（非 pr_state）
 * ③ phase:completed 事件触发 pushSnapshot（postMirrorSnapshot 被调用，phases 字段名正确）
 * ④ task:transition 事件触发 pushSnapshot
 * ⑤ 多个 phase 事件在防抖窗口内合并为一次 snapshot
 * ⑥ 未注册 link 的 task 事件不触发 snapshot
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { MirrorPusher } from "../src/daemon/selfhosted-connector/mirror-pusher";
import type { MirrorPusherDeps, RequirementSnapshot, CommentSnapshot, SubPrSnapshot, PhaseEventSnapshot } from "../src/daemon/selfhosted-connector/mirror-pusher";
import type { SelfhostedBackend } from "../src/daemon/selfhosted-connector/backend";
import type { ReqLink } from "../src/daemon/selfhosted-connector/types";
import { enableBus, disableBus, emit } from "../src/core/event-bus";

// ── 辅助夹具 ────────────────────────────────────────────────────────────────

const AUTOPILOT_REQ_ID = "req-001";
const REQGENIE_REQ_ID = "rg-req-001";
const TASK_ID = "task-abc123";

const baseLink: ReqLink = {
  reqgenie_req_id: REQGENIE_REQ_ID,
  autopilot_req_id: AUTOPILOT_REQ_ID,
  assignment_id: "asgn-1",
  mirror_seq: 0,
};

const baseReq: RequirementSnapshot = {
  id: AUTOPILOT_REQ_ID,
  title: "测试需求",
  status: "running",
  spec_md: "## 需求描述",
  status_reason: null,
};

const basePhase: PhaseEventSnapshot = {
  run_seq: 1,
  phase: "develop",
  label: "开发",
  state: "completed",
  started_at: "2026-06-23T10:00:00.000Z",
  ended_at: "2026-06-23T11:00:00.000Z",
  seq: 0,
};

const basePr: SubPrSnapshot = {
  repo_alias: "main-repo",
  pr_url: "https://github.com/org/repo/pull/1",
  pr_state: "open",
  last_reviewed_event_id: null,
};

function makeDeps(overrides: Partial<MirrorPusherDeps> = {}): {
  deps: MirrorPusherDeps;
  snapshotCalls: Array<{ snapshot: Record<string, unknown> }>;
  eventCalls: Array<unknown>;
} {
  const snapshotCalls: Array<{ snapshot: Record<string, unknown> }> = [];
  const eventCalls: Array<unknown> = [];

  const backend = {
    postMirrorSnapshot: mock(async (snapshot: Record<string, unknown>) => {
      snapshotCalls.push({ snapshot });
    }),
    postMirrorEvents: mock(async (events: unknown[]) => {
      eventCalls.push(...events);
      return { seqGap: false };
    }),
  } as unknown as SelfhostedBackend;

  const deps: MirrorPusherDeps = {
    backend,
    getRequirement: mock((_id: string) => baseReq),
    listComments: mock((_id: string): CommentSnapshot[] => []),
    listSubPrs: mock((_id: string): SubPrSnapshot[] => [basePr]),
    listPhaseEvents: mock((_id: string): PhaseEventSnapshot[] => [basePhase]),
    ...overrides,
  };

  return { deps, snapshotCalls, eventCalls };
}

// 等待防抖定时器触发（>SNAPSHOT_DEBOUNCE_MS=300ms）
const flushSnapshot = () => new Promise<void>((r) => setTimeout(r, 400));
// 短暂等待，不足以触发防抖
const flushMicro = () => new Promise<void>((r) => setTimeout(r, 10));

// ── 测试套件 ─────────────────────────────────────────────────────────────────

describe("MirrorPusher", () => {
  let pusher: MirrorPusher;

  beforeEach(() => {
    enableBus();
  });

  afterEach(() => {
    pusher?.dispose();
    disableBus();
  });

  // ── ① snapshot phases 字段名 ─────────────────────────────────────────────

  it("① pushSnapshot 构建的 phases 包含 status 和 finished_at（不含 state/ended_at）", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    pusher.registerLink(baseLink);

    await pusher.pushSnapshot(AUTOPILOT_REQ_ID);

    expect(snapshotCalls.length).toBe(1);
    const snapshot = snapshotCalls[0].snapshot;
    const phases = snapshot.phases as Array<Record<string, unknown>>;
    expect(phases.length).toBe(1);

    const phase = phases[0];
    // 正确字段
    expect(phase.status).toBe("completed");
    expect(phase.finished_at).toBe("2026-06-23T11:00:00.000Z");
    // 旧字段不应存在
    expect(phase.state).toBeUndefined();
    expect(phase.ended_at).toBeUndefined();
  });

  // ── ② snapshot prs 字段名 ────────────────────────────────────────────────

  it("② pushSnapshot 构建的 prs 包含 pr_status（不含 pr_state）", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    pusher.registerLink(baseLink);

    await pusher.pushSnapshot(AUTOPILOT_REQ_ID);

    expect(snapshotCalls.length).toBe(1);
    const prs = snapshotCalls[0].snapshot.prs as Array<Record<string, unknown>>;
    expect(prs.length).toBe(1);

    const pr = prs[0];
    expect(pr.pr_status).toBe("open");
    expect(pr.pr_state).toBeUndefined();
  });

  // ── ③ phase:completed 触发 pushSnapshot ──────────────────────────────────

  it("③ phase:completed 事件触发 pushSnapshot（backend.postMirrorSnapshot 被调用）", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    pusher.registerLink(baseLink);
    pusher.registerTaskRequirement(TASK_ID, AUTOPILOT_REQ_ID);
    pusher.start();

    emit({ type: "phase:completed", payload: { taskId: TASK_ID, phase: "develop" } });
    await flushSnapshot();

    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
    // 最新快照应含正确字段
    const phases = snapshotCalls[snapshotCalls.length - 1].snapshot.phases as Array<Record<string, unknown>>;
    expect(phases[0].status).toBe("completed");
    expect(phases[0].finished_at).toBeDefined();
  });

  // ── ④ task:transition 触发 pushSnapshot ──────────────────────────────────

  it("④ task:transition 事件触发 pushSnapshot", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    pusher.registerLink(baseLink);
    pusher.registerTaskRequirement(TASK_ID, AUTOPILOT_REQ_ID);
    pusher.start();

    emit({ type: "task:transition", payload: { taskId: TASK_ID, from: "running_develop", to: "running_review", trigger: "phase_done", note: null } });
    await flushSnapshot();

    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── ⑤ 防抖：多个 phase 事件合并为一次 snapshot ───────────────────────────

  it("⑤ 短时间内多个 phase 事件合并为一次 pushSnapshot（防抖）", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    pusher.registerLink(baseLink);
    pusher.registerTaskRequirement(TASK_ID, AUTOPILOT_REQ_ID);
    pusher.start();

    // 连续发出 3 个 phase 事件
    emit({ type: "phase:started", payload: { taskId: TASK_ID, phase: "develop", label: "开发" } });
    emit({ type: "phase:completed", payload: { taskId: TASK_ID, phase: "develop" } });
    emit({ type: "task:transition", payload: { taskId: TASK_ID, from: "running_develop", to: "running_review", trigger: "phase_done", note: null } });

    // 防抖窗口未到，应该还没触发
    await flushMicro();
    expect(snapshotCalls.length).toBe(0);

    // 等防抖过期
    await flushSnapshot();
    // 合并成一次（或极少次，取决于计时精度）
    expect(snapshotCalls.length).toBe(1);
  });

  // ── ⑥ 未注册 link 的 task 不触发 snapshot ──────────────────────────────

  it("⑥ 未注册 link 的 task 事件不触发 pushSnapshot", async () => {
    const { deps, snapshotCalls } = makeDeps();
    pusher = new MirrorPusher(deps);
    // 不 registerLink，不 registerTaskRequirement
    pusher.start();

    emit({ type: "phase:completed", payload: { taskId: "unknown-task", phase: "develop" } });
    await flushSnapshot();

    expect(snapshotCalls.length).toBe(0);
  });
});
