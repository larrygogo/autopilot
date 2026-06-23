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

// ── I3：多库场景逐库取 token ─────────────────────────────────────────────────────

const multiRepoSession = (stage: SessionState["current_stage"]): SessionState => ({
  id: "sess-multi",
  status: "running",
  current_stage: stage,
  repos: [
    { repo_id: "r-main", alias: "main-app", remote_url: "https://x/main.git", default_branch: "main", primary: true },
    { repo_id: "r-sub",  alias: "sub-lib",  remote_url: "https://x/sub.git",  default_branch: "main", primary: false },
  ],
});

test("I3（dev）：多库 session 用主库 repo_id 取 token（非无脑 repos[0]，即主库）", async () => {
  const tokenRequests: string[] = [];
  const evs = await runStageRound(multiRepoSession("dev"), stubDeps({
    getGitToken: async (_sid, repoId) => { tokenRequests.push(repoId); return "tok-" + repoId; },
    ensureCodebase: async () => ({ root: "/tmp/cb", repos: [
      { ws: multiRepoSession("dev").repos[0] as any, alias: "main-app", dir: "main-app", path: "/tmp/cb/main-app", fidelity: "full", branch: "reqgenie/sess-multi", base: "main", reused: false },
      { ws: multiRepoSession("dev").repos[1] as any, alias: "sub-lib",  dir: "sub-lib",  path: "/tmp/cb/sub-lib",  fidelity: "full", branch: "reqgenie/sess-multi", base: "main", reused: false },
    ], failed: [] }),
  }));
  // dev 阶段：应用主库（r-main）的 repo_id 取 token
  expect(tokenRequests).toContain("r-main");
  expect(evs.some((e) => e.type === "gate_opened")).toBe(true);
});

test("I3（pr）：多库 session 逐库取 token（每库用自己的 repo_id）", async () => {
  const tokenRequests: string[] = [];
  const submitCalls: Array<{ repoLabel: string; gitToken: string }> = [];
  await runStageRound(multiRepoSession("pr"), stubDeps({
    getGitToken: async (_sid, repoId) => { tokenRequests.push(repoId); return "tok-" + repoId; },
    ensureCodebase: async () => ({ root: "/tmp/cb", repos: [
      { ws: multiRepoSession("pr").repos[0] as any, alias: "main-app", dir: "main-app", path: "/tmp/cb/main-app", fidelity: "full", branch: "reqgenie/sess-multi", base: "main", reused: false },
      { ws: multiRepoSession("pr").repos[1] as any, alias: "sub-lib",  dir: "sub-lib",  path: "/tmp/cb/sub-lib",  fidelity: "full", branch: "reqgenie/sess-multi", base: "main", reused: false },
    ], failed: [] }),
    submitPrPure: async (repos, opts) => {
      submitCalls.push({ repoLabel: repos[0]!.label, gitToken: opts.gitToken ?? "" });
      return { results: repos.map((r) => ({ repo: r, prUrl: `https://x/pull/1`, prNumber: 1 })), failures: [] };
    },
  }));
  // pr 阶段：main-app 用 r-main 的 token，sub-lib 用 r-sub 的 token
  const mainCall = submitCalls.find((c) => c.repoLabel === "main-app");
  const subCall  = submitCalls.find((c) => c.repoLabel === "sub-lib");
  expect(mainCall?.gitToken).toBe("tok-r-main");
  expect(subCall?.gitToken).toBe("tok-r-sub");
});
