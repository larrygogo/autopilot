#!/usr/bin/env bun
// R1 验收勾稽（spec §9 R1）：机检项自动跑，人工/真环境项打印待办。
// 一条命令出红绿总账。全绿退出 0，任一机检 ✗ 退出 1。
//
// 两阶段（审查修正 #5）：
//   阶段 1（前置检查）：A1/A2/B 核心文件在位？缺则 exit 2 打印「前置阻塞」，
//                     避免「11 项全红」被误读成 C 本身有缺陷。
//   阶段 2（机检）：在位后自动跑测试 / 存在性 / 静态断言，逐项 ✓/✗。
//
//   bun run runner-acceptance
import { existsSync } from "fs";
import { join } from "path";

const REPO = process.cwd();
const REQGENIE = join(REPO, "../reqgenie");

// ════════════════════════════════════════════════════════════════════════════
// 阶段 1：前置检查（缺任一核心前置文件 → exit 2 报「前置阻塞」）
// ════════════════════════════════════════════════════════════════════════════
interface Prereq { id: string; desc: string; file: string; base?: "repo" | "reqgenie" }

const PREREQS: Prereq[] = [
  // A1 executor 核（必须在位，T8/T9 依赖其存在）
  { id: "A1/executor/git-ops", desc: "executor git-ops.ts", file: "src/core/executor/git-ops.ts" },
  { id: "A1/executor/submit-pr", desc: "executor submit-pr.ts", file: "src/core/executor/submit-pr.ts" },
  { id: "A1/executor/agent-runner", desc: "executor agent-runner.ts", file: "src/core/executor/agent-runner.ts" },
  { id: "A1/executor/index", desc: "executor index.ts", file: "src/core/executor/index.ts" },
  // A2 runner 协议客户端（必须在位）
  { id: "A2/runner/registration", desc: "runner registration.ts", file: "src/daemon/runner/registration.ts" },
  { id: "A2/runner/poller", desc: "runner poller.ts", file: "src/daemon/runner/poller.ts" },
  { id: "A2/runner/session-loop", desc: "runner session-loop.ts", file: "src/daemon/runner/session-loop.ts" },
  { id: "A2/runner/rounds", desc: "runner rounds.ts", file: "src/daemon/runner/rounds.ts" },
];

/** reqgenie B 侧前置（迁移文件是否存在）——B 计划未落地时缺失，前置检查报「前置阻塞」不混入机检失败。 */
const B_PREREQS: Prereq[] = [
  { id: "B/060_runners", desc: "reqgenie 迁移 060_runners.sql", file: "backend/migrations/060_runners.sql", base: "reqgenie" },
  { id: "B/061_dev_sessions_runner", desc: "reqgenie 迁移 061_dev_sessions_runner.sql", file: "backend/migrations/061_dev_sessions_runner.sql", base: "reqgenie" },
  { id: "B/062_runner_manage_perm", desc: "reqgenie 迁移 062_runner_manage_perm.sql", file: "backend/migrations/062_runner_manage_perm.sql", base: "reqgenie" },
];

function prereqPath(p: Prereq): string {
  return join(p.base === "reqgenie" ? REQGENIE : REPO, p.file);
}

let phase1Failed = false;

console.log("════ Runner R1 验收勾稽（spec §9）════\n── 阶段 1：前置检查 ──");
const missingA = PREREQS.filter((p) => !existsSync(prereqPath(p)));
if (missingA.length > 0) {
  for (const p of missingA) console.error(`  ✗ [前置阻塞] [${p.id}] 缺失：${prereqPath(p)}`);
  console.error("\n前置阻塞：A1/A2 核心文件未落地，请先完成对应计划（A1/A2）后再跑验收。");
  process.exit(2);
}
console.log(`  ✓ A1/A2 核心文件（${PREREQS.length} 项）全部在位`);

const missingB = B_PREREQS.filter((p) => !existsSync(prereqPath(p)));
if (missingB.length > 0) {
  for (const p of missingB) console.error(`  ✗ [前置阻塞] [${p.id}] 缺失：${prereqPath(p)}`);
  console.error(`\n前置阻塞：reqgenie B 侧迁移未落地（${missingB.map((p) => p.id).join(", ")}），` +
    "请先完成 B 计划（reqgenie 060/061/062 迁移 + RunnerDispatcher + 路由）后再跑验收。");
  phase1Failed = true;
}

if (!phase1Failed) {
  console.log(`  ✓ B 迁移文件（${B_PREREQS.length} 项）全部在位`);
}

// ════════════════════════════════════════════════════════════════════════════
// 阶段 2：机检项（自动跑，逐项 ✓/✗）
// ════════════════════════════════════════════════════════════════════════════
interface Check {
  id: string;
  desc: string;
  kind: "auto" | "manual";
  run?: () => boolean | Promise<boolean>;
  note?: string;
}

function fileExists(...paths: string[]): boolean {
  return paths.every((f) => existsSync(join(REPO, f)));
}
function reqgenieFileExists(f: string): boolean {
  return existsSync(join(REQGENIE, f));
}

function bunTest(file: string): boolean {
  const r = Bun.spawnSync({
    cmd: ["bun", "test", file],
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (r.exitCode ?? 1) === 0;
}

function cargoCompiles(testName: string): boolean {
  if (!existsSync(REQGENIE)) return false; // reqgenie 仓不可达 → skip
  const r = Bun.spawnSync({
    cmd: ["cargo", "test", "--test", testName, "--no-run"],
    cwd: join(REQGENIE, "backend"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return (r.exitCode ?? 1) === 0;
}

const checks: Check[] = [
  // ── autopilot executor 核（A1）──
  {
    id: "A1-executor-files",
    desc: "executor 四模块存在（git-ops/submit-pr/agent-runner/index）",
    kind: "auto",
    run: () => fileExists(
      "src/core/executor/git-ops.ts",
      "src/core/executor/submit-pr.ts",
      "src/core/executor/agent-runner.ts",
      "src/core/executor/index.ts",
    ),
  },
  {
    id: "A1-token-injection",
    desc: "ensureCodebase 支持注入 gitToken（pickCloneToken）",
    kind: "auto",
    run: () => bunTest("tests/executor-token-injection.test.ts"),
  },
  {
    id: "A1-no-statemachine",
    desc: "executor 不耦合状态机/调度器/createTask（红线测试）",
    kind: "auto",
    run: () => bunTest("tests/executor-no-statemachine-import.test.ts"),
  },
  // ── autopilot runner 协议客户端（A2）──
  {
    id: "A2-runner-mod",
    desc: "src/daemon/runner/ 四模块存在（registration/poller/session-loop/rounds）",
    kind: "auto",
    run: () => fileExists(
      "src/daemon/runner/registration.ts",
      "src/daemon/runner/poller.ts",
      "src/daemon/runner/session-loop.ts",
      "src/daemon/runner/rounds.ts",
    ),
  },
  {
    id: "A2-mock-cp",
    desc: "mock-control-plane 单测（协议子集：注册/claim/事件 seq+gate_id 注入）",
    kind: "auto",
    run: () => bunTest("tests/runner-mock-control-plane.test.ts"),
  },
  {
    id: "A2-conformance",
    desc: "session-loop 与 agent-worker 参考行为对齐（8 剧本对齐证明，防移植漂移）",
    kind: "auto",
    run: () => bunTest("tests/runner-session-loop-conformance.test.ts"),
  },
  {
    id: "A2-protocol-contract",
    desc: "协议枚举契约（event_type/stage ⊆ reqgenie 052；runner 不自定 seq/gate_id）",
    kind: "auto",
    run: () => bunTest("tests/runner-protocol-contract.test.ts"),
  },
  {
    id: "A2-failure-paths",
    desc: "失败路径（驳回增量rework/session取消优雅退出/重启续作不重走/token现取护栏）",
    kind: "auto",
    run: () => bunTest("tests/runner-failure-paths.test.ts"),
  },
  // ── reqgenie 侧（B）──
  {
    id: "B-migrations",
    desc: "reqgenie 060/061/062 迁移存在",
    kind: "auto",
    run: () =>
      reqgenieFileExists("backend/migrations/060_runners.sql") &&
      reqgenieFileExists("backend/migrations/061_dev_sessions_runner.sql") &&
      reqgenieFileExists("backend/migrations/062_runner_manage_perm.sql"),
  },
  {
    id: "B-runner-e2e-compiles",
    desc: "reqgenie runner_e2e 集成测试编译通过（无需真 PG，只验编译）",
    kind: "auto",
    run: () => cargoCompiles("runner_e2e"),
  },
  // ── 联调闭环（C）──
  {
    id: "C-guide",
    desc: "联调启动手册存在（docs/runner-integration-guide.md）",
    kind: "auto",
    run: () => fileExists("docs/runner-integration-guide.md"),
  },
  {
    id: "C-live-e2e-script",
    desc: "全链路 live e2e 脚本存在（scripts/runner/runner-e2e-live.ts）",
    kind: "auto",
    run: () => fileExists("scripts/runner/runner-e2e-live.ts"),
  },
  {
    id: "C-smoke-script",
    desc: "离线契约冒烟脚本存在（scripts/runner/runner-smoke.ts）",
    kind: "auto",
    run: () => fileExists("scripts/runner/runner-smoke.ts"),
  },
  // ── 人工/真环境项 ──
  {
    id: "B-真库e2e",
    kind: "manual",
    desc: "reqgenie runner_e2e 在真 PG+Redis 通过（注册一次性/原子claim/拉模型回收/pr_created/max_stage=pr/单活跃session）",
    note: "起 docker-compose.dev.yml 后：ORCH_PG=postgresql://reqgenie:reqgenie@127.0.0.1:5433 ORCH_REDIS=redis://127.0.0.1:6379 cargo test --test runner_e2e -- --ignored --nocapture",
  },
  {
    id: "C-smoke-run",
    kind: "manual",
    desc: "离线契约冒烟 runner-smoke 全链路通（mock-cp+mode:runner daemon+executor，clarify→spec→dev→pr→pr_created→done）",
    note: "bun run runner-smoke（前提：A1+A2 已落地，executor dev/pr round 真跑 git/PR）",
  },
  {
    id: "C-live",
    kind: "manual",
    desc: "全链路 live e2e 通过（真 reqgenie + 真 GitHub 私有仓 → 真 PR）",
    note: "按 docs/runner-integration-guide.md 起全套，REQGENIE_JWT=<jwt> ... RUNNER_E2E_AUTO_APPROVE=1 bun run runner-e2e-live",
  },
  {
    id: "R1-飞书澄清",
    kind: "manual",
    desc: "clarify 阶段飞书卡澄清答复回流（真飞书环境）",
    note: "live e2e 中在飞书点澄清卡，确认 user_message 事件回流",
  },
  {
    id: "R1-merge签字",
    kind: "manual",
    desc: "PR 在 GitHub 真 merge 完成签字（live e2e 产 PR 后人工 review+merge）",
    note: "live e2e 产 PR 后，在 GitHub UI 完成 review + merge，确认 pr_url 写入 dev_sessions",
  },
  {
    id: "R1-成本闸门",
    kind: "manual",
    desc: "成本闸门触顶产 limit_hit（round 超时/STAGE_MAX/SESSION_MAX），session failed 不静默",
    note: "真库/live 环境压低 STAGE_MAX 触发，确认 limit_hit 事件出现 + session 状态变 failed",
  },
];

console.log("\n── 阶段 2：机检项 ──");
let autoPass = 0;
let autoFail = 0;

for (const c of checks.filter((c) => c.kind === "auto")) {
  process.stdout.write(`  [${c.id}] ${c.desc} … `);
  let pass = false;
  try {
    const result = c.run!();
    pass = result instanceof Promise ? await result : result;
  } catch (e: unknown) {
    pass = false;
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(`异常：${msg.slice(0, 200)} `);
  }
  if (pass) {
    console.log("✓");
    autoPass++;
  } else {
    console.log("✗");
    autoFail++;
  }
}

console.log("\n── 人工/真环境项（需手动确认）──");
for (const c of checks.filter((c) => c.kind === "manual")) {
  console.log(`  [ ] [${c.id}] ${c.desc}`);
  if (c.note) console.log(`        → ${c.note}`);
}

console.log(`\n════ 机检：${autoPass} 通过 / ${autoFail} 失败 ════`);
if (phase1Failed) {
  console.log("前置检查有阻塞项（见阶段 1 输出），请先完成对应计划后重跑。");
  process.exit(2);
}
if (autoFail > 0) {
  console.log("R1 机检未全绿，逐项定位对应 A1/A2/B/C 缺口（机检 id 对应计划 Task）。");
  process.exit(1);
}
console.log("R1 机检全绿。人工项请按上方清单逐条确认后方可宣告 R1 达标。");
