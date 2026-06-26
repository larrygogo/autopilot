/**
 * selfhosted-connector 分配流程 e2e 测试
 *
 * 覆盖三个缺口的调用序列断言：
 * (a) workspace 挂载：有 repo_urls 时 setWorkspaces 被调用
 * (b) 自动进澄清：setWorkspaces 后调 transitionClarifying
 * (c) 镜像填充：registerLink → ack → transitionClarifying → pushSnapshot 的顺序
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { AssignmentPoller } from "../src/daemon/selfhosted-connector/assignments-poller";
import type { AssignmentPollerDeps } from "../src/daemon/selfhosted-connector/assignments-poller";
import type { SelfhostedBackend } from "../src/daemon/selfhosted-connector/backend";
import type { PendingAssignment } from "../src/daemon/selfhosted-connector/types";

// ── 辅助：构造一个 mock backend ──────────────────────────────────────────────

function makeMockBackend(assignment: PendingAssignment | null): {
  backend: SelfhostedBackend;
  ackCalls: Array<{ assignmentId: string; autopilotReqId: string }>;
} {
  const ackCalls: Array<{ assignmentId: string; autopilotReqId: string }> = [];
  let callCount = 0;

  const backend = {
    claimAssignment: mock(async (_wait: number) => {
      // 第一次返回 assignment，后续返回 null（停止循环）
      callCount++;
      return callCount === 1 ? assignment : null;
    }),
    ackAssignment: mock(async (assignmentId: string, autopilotReqId: string) => {
      ackCalls.push({ assignmentId, autopilotReqId });
    }),
  } as unknown as SelfhostedBackend;

  return { backend, ackCalls };
}

// ── 辅助：构建 deps 并收集调用顺序 ──────────────────────────────────────────

type CallRecord =
  | { op: "setWorkspaces"; repoUrls: string[] }
  | { op: "onLinkCreated"; reqgenie_req_id: string; autopilot_req_id: string }
  | { op: "ack"; assignmentId: string }
  | { op: "transitionClarifying"; reqId: string }
  | { op: "triggerSnapshot"; reqId: string };

function makeDeps(
  assignment: PendingAssignment | null,
  opts: {
    setWorkspacesShouldThrow?: boolean;
    transitionClarifyingShouldThrow?: boolean;
  } = {},
): {
  deps: AssignmentPollerDeps;
  calls: CallRecord[];
  ackCalls: Array<{ assignmentId: string; autopilotReqId: string }>;
} {
  const calls: CallRecord[] = [];
  const { backend, ackCalls } = makeMockBackend(assignment);

  // Patch backend.ackAssignment to also record into calls
  const originalAck = backend.ackAssignment.bind(backend);
  (backend as Record<string, unknown>).ackAssignment = mock(
    async (assignmentId: string, autopilotReqId: string) => {
      await originalAck(assignmentId, autopilotReqId);
      calls.push({ op: "ack", assignmentId });
    },
  );

  const deps: AssignmentPollerDeps = {
    backend,
    pollWaitSeconds: 0,
    backoffBaseMs: 0,
    idleBackoffMs: 0,

    createRequirement: mock(async (_params) => "req-auto-001"),

    setWorkspaces: mock(async ({ repo_urls }) => {
      calls.push({ op: "setWorkspaces", repoUrls: repo_urls });
      if (opts.setWorkspacesShouldThrow) {
        throw new Error("workspace probe failed");
      }
    }),

    onLinkCreated: mock((link) => {
      calls.push({
        op: "onLinkCreated",
        reqgenie_req_id: link.reqgenie_req_id,
        autopilot_req_id: link.autopilot_req_id,
      });
    }),

    transitionClarifying: mock(async (reqId: string) => {
      calls.push({ op: "transitionClarifying", reqId });
      if (opts.transitionClarifyingShouldThrow) {
        throw new Error("illegal transition");
      }
    }),

    triggerSnapshot: mock((reqId: string) => {
      calls.push({ op: "triggerSnapshot", reqId });
    }),
  };

  return { deps, calls, ackCalls };
}

// ── 辅助：运行一轮轮询并等待稳定 ────────────────────────────────────────────

async function runOnePoll(
  deps: AssignmentPollerDeps,
  assignment: PendingAssignment | null,
): Promise<void> {
  const poller = new AssignmentPoller(deps);
  poller.start();
  // 等足够多的 microtask/macrotask 跑完（assignment 处理是 async）
  await new Promise<void>((r) => setTimeout(r, 50));
  poller.dispose();
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("selfhosted-connector 分配流程", () => {
  const baseAssignment: PendingAssignment = {
    assignment_id: "asgn-1",
    reqgenie_req_id: "rg-req-1",
    title: "测试需求",
    spec_md: "## 需求\n内容",
    repo_urls: ["https://github.com/org/repo.git"],
    project_hint: null,
  };

  // ── (a) workspace 挂载 ──────────────────────────────────────────────────

  it("(a) 有 repo_urls 时 setWorkspaces 被调用并传入 repo_urls", async () => {
    const { deps, calls } = makeDeps(baseAssignment);
    await runOnePoll(deps, baseAssignment);

    const wsCall = calls.find((c) => c.op === "setWorkspaces");
    expect(wsCall).toBeDefined();
    expect((wsCall as { op: "setWorkspaces"; repoUrls: string[] }).repoUrls).toEqual([
      "https://github.com/org/repo.git",
    ]);
  });

  it("(a) 无 repo_urls 时 setWorkspaces 不被调用", async () => {
    const noRepoAssignment: PendingAssignment = { ...baseAssignment, repo_urls: [] };
    const { deps, calls } = makeDeps(noRepoAssignment);
    await runOnePoll(deps, noRepoAssignment);

    const wsCall = calls.find((c) => c.op === "setWorkspaces");
    expect(wsCall).toBeUndefined();
  });

  // ── (b) 自动进澄清 ────────────────────────────────────────────────────

  it("(b) 分配成功后 transitionClarifying 被调用", async () => {
    const { deps, calls } = makeDeps(baseAssignment);
    await runOnePoll(deps, baseAssignment);

    const transCall = calls.find((c) => c.op === "transitionClarifying");
    expect(transCall).toBeDefined();
    expect(
      (transCall as { op: "transitionClarifying"; reqId: string }).reqId,
    ).toBe("req-auto-001");
  });

  it("(b) 无 repo_urls 时 transitionClarifying 也被调用", async () => {
    const noRepoAssignment: PendingAssignment = { ...baseAssignment, repo_urls: [] };
    const { deps, calls } = makeDeps(noRepoAssignment);
    await runOnePoll(deps, noRepoAssignment);

    const transCall = calls.find((c) => c.op === "transitionClarifying");
    expect(transCall).toBeDefined();
  });

  it("(b) transitionClarifying 失败不丢 ack（best-effort）", async () => {
    const { deps, calls, ackCalls } = makeDeps(baseAssignment, {
      transitionClarifyingShouldThrow: true,
    });
    await runOnePoll(deps, baseAssignment);

    // ack 已发出
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0].autopilotReqId).toBe("req-auto-001");

    // snapshot 仍触发（即使 transition 失败）
    const snapshotCall = calls.find((c) => c.op === "triggerSnapshot");
    expect(snapshotCall).toBeDefined();
  });

  // ── (c) 镜像填充：调用顺序 ───────────────────────────────────────────

  it("(c) 正常流程调用顺序：setWorkspaces → onLinkCreated → ack → transitionClarifying → triggerSnapshot", async () => {
    const { deps, calls } = makeDeps(baseAssignment);
    await runOnePoll(deps, baseAssignment);

    const opSeq = calls.map((c) => c.op);
    // 验证关键顺序（不要求中间没有其他 op）
    const wsIdx = opSeq.indexOf("setWorkspaces");
    const linkIdx = opSeq.indexOf("onLinkCreated");
    const ackIdx = opSeq.indexOf("ack");
    const transIdx = opSeq.indexOf("transitionClarifying");
    const snapIdx = opSeq.indexOf("triggerSnapshot");

    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(transIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeGreaterThanOrEqual(0);

    // setWorkspaces 在 onLinkCreated 前
    expect(wsIdx).toBeLessThan(linkIdx);
    // onLinkCreated 在 ack 前（link 注册先于 ack）
    expect(linkIdx).toBeLessThan(ackIdx);
    // ack 在 transitionClarifying 前（ack 不等 transition）
    expect(ackIdx).toBeLessThan(transIdx);
    // transitionClarifying 在 triggerSnapshot 前（snapshot 反映 clarifying 状态）
    expect(transIdx).toBeLessThan(snapIdx);
  });

  it("(c) ack 携带正确的 autopilot_req_id", async () => {
    const { deps, ackCalls } = makeDeps(baseAssignment);
    await runOnePoll(deps, baseAssignment);

    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0].assignmentId).toBe("asgn-1");
    expect(ackCalls[0].autopilotReqId).toBe("req-auto-001");
  });

  it("(c) setWorkspaces 失败时 ack 仍发出（best-effort）", async () => {
    const { deps, ackCalls } = makeDeps(baseAssignment, {
      setWorkspacesShouldThrow: true,
    });
    await runOnePoll(deps, baseAssignment);

    expect(ackCalls.length).toBe(1);
  });

  // ── 边界：createRequirement 失败 ──────────────────────────────────────

  it("createRequirement 失败时不 ack（不 onLinkCreated、不 triggerSnapshot）", async () => {
    const { deps, calls, ackCalls } = makeDeps(baseAssignment);
    // Override createRequirement to throw
    (deps as Record<string, unknown>).createRequirement = mock(async () => {
      throw new Error("DB write failed");
    });

    await runOnePoll(deps, baseAssignment);

    expect(ackCalls.length).toBe(0);
    expect(calls.find((c) => c.op === "onLinkCreated")).toBeUndefined();
    expect(calls.find((c) => c.op === "triggerSnapshot")).toBeUndefined();
  });
});
