// tests/runner-rounds.test.ts
import { test, expect } from "bun:test";
import { runStageRound, deliveryBranchFor } from "../src/daemon/runner/rounds";
import type { SessionState } from "../src/daemon/runner/types";

const baseSession = (stage: SessionState["current_stage"]): SessionState => ({
  id: "sess-77",
  status: "running",
  current_stage: stage,
  repos: [{ repo_id: "r1", alias: "app", remote_url: "https://x/app.git", default_branch: "main", primary: true }],
});

function stubDeps(overrides: Partial<Parameters<typeof runStageRound>[1]> = {}) {
  return {
    buildAgent: () => ({ name: "stub" } as any),
    runRoundAgent: async () => ({ text: "round done", usage: undefined }),
    ensureCodebase: async () => ({
      root: "/tmp/cb",
      repos: [{ ws: baseSession("dev").repos[0] as any, alias: "app", dir: "app", path: "/tmp/cb/app", fidelity: "full" as const, branch: "reqgenie/sess-77", base: "main", reused: false }],
      failed: [],
    }),
    produceDiff: () => "diff --git a/x b/x\n+line",
    submitPrPure: async () => ({ results: [{ repo: { label: "app", base: "main" } as any, prUrl: "https://x/pull/3", prNumber: 3 }], failures: [] }),
    getGitToken: async () => "ghs_vend",
    resetToBase: () => {},
    accumulated: "",
    ...overrides,
  };
}

test("deliveryBranchFor：交付分支命名恒定 reqgenie/<session_id>", () => {
  expect(deliveryBranchFor("sess-77")).toBe("reqgenie/sess-77");
});

test("clarify：产 assistant_message（无 gate）", async () => {
  const evs = await runStageRound(baseSession("clarify"), stubDeps());
  expect(evs.map((e) => e.type)).toContain("assistant_message");
  expect(evs.some((e) => e.type === "gate_opened")).toBe(false);
});

test("spec：产 assistant_message + stage_artifact + gate_opened", async () => {
  const evs = await runStageRound(baseSession("spec"), stubDeps());
  expect(evs.map((e) => e.type)).toEqual(["assistant_message", "stage_artifact", "gate_opened"]);
});

test("dev：ensureCodebase(full, deliverBranch=reqgenie/<sid>, gitToken)，产 diff stage_artifact + gate_opened，无 push", async () => {
  let ensureOpts: any = null;
  let pushed = false;
  const evs = await runStageRound(baseSession("dev"), stubDeps({
    ensureCodebase: async (_sid, _ws, opts) => { ensureOpts = opts; return {
      root: "/tmp/cb", repos: [{ ws: {} as any, alias: "app", dir: "app", path: "/tmp/cb/app", fidelity: "full", branch: "reqgenie/sess-77", base: "main", reused: false }], failed: [],
    }; },
    submitPrPure: async () => { pushed = true; return { results: [], failures: [] }; },
  }));
  expect(ensureOpts.fidelity).toBe("full");
  expect(ensureOpts.deliverBranch).toBe("reqgenie/sess-77");
  expect(ensureOpts.gitToken).toBe("ghs_vend");
  expect(pushed).toBe(false); // dev 不 push
  const stageArtifact = evs.find((e) => e.type === "stage_artifact");
  expect(stageArtifact?.artifact?.kind).toBe("dev");
  expect(evs.some((e) => e.type === "gate_opened")).toBe(true);
});

test("dev rework（accumulated 有驳回评论）：reused 命中既有脏树，不 reset 基线", async () => {
  let didReset = false;
  await runStageRound(baseSession("dev"), stubDeps({
    accumulated: "驳回：请补单测",
    ensureCodebase: async () => ({ root: "/tmp/cb", repos: [{ ws: {} as any, alias: "app", dir: "app", path: "/tmp/cb/app", fidelity: "full", branch: "reqgenie/sess-77", base: "main", reused: true }], failed: [] }),
    resetToBase: () => { didReset = true; },
  }));
  expect(didReset).toBe(false); // rework 增量，不丢半成品
});

test("dev 重入（无 rework，reused 命中）：先 reset 基线丢半成品", async () => {
  let didReset = false;
  await runStageRound(baseSession("dev"), stubDeps({
    accumulated: "",
    ensureCodebase: async () => ({ root: "/tmp/cb", repos: [{ ws: {} as any, alias: "app", dir: "app", path: "/tmp/cb/app", fidelity: "full", branch: "reqgenie/sess-77", base: "main", reused: true }], failed: [] }),
    resetToBase: () => { didReset = true; },
  }));
  expect(didReset).toBe(true);
});

test("pr：submitPrPure 推送并产 pr_created（branch_name/pr_url）", async () => {
  const evs = await runStageRound(baseSession("pr"), stubDeps());
  const pr = evs.find((e) => e.type === "pr_created");
  expect(pr?.pr?.pr_url).toBe("https://x/pull/3");
  expect(pr?.pr?.branch_name).toBe("reqgenie/sess-77");
});
