#!/usr/bin/env bun
// Runner 离线契约冒烟：mock-control-plane（Task 2）+ autopilot runner（mode:runner daemon，A2）+
// executor（A1）全链路，**无 reqgenie / 无 GitHub / 无真 LLM**，CI 可跑。
//
// 跑通 clarify→spec→dev→pr，断言事件流出现 pr_created + session done + 远程真有交付分支。
//
// 离线保真手段（不改生产代码，全靠 PATH 注入）：
//   - dev/pr 的远程 = 本地 `file://` bare 仓（GitHub 替身）；git clone/push 走真 git，
//     `pr push` 真把 reqgenie/<sid> 分支推到 bare（验「dev 只 diff、pr 才 push」契约）。
//   - agent 子进程 `claude` = stub（PATH 优先）：读 stdin prompt，dev 阶段写一个文件让 produceDiff/
//     hasChanges 看到真 diff，回 NDJSON `result.success`（anthropic provider 协议）。不烧 token、确定性。
//   - PR 开口 `gh` = stub：`pr view`→无 PR、`pr create`→回假 PR url（submitPrPure 的 openOrUpdatePr 路径）。
//   - 大脑决策由 mock 脚本化：clarify「判清楚」用 cp.advanceStage、gate 人审用 cp.decideGate、
//     澄清回复用 cp.injectUserMessage。claimAny 解决「脚本拿不到 daemon 内真实 runner_id」。
//
//   bun run runner-smoke
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MockControlPlane } from "./mock-control-plane";

const REPO = process.cwd();
const home = mkdtempSync(join(tmpdir(), `runner-smoke-${Date.now()}-`));
let cp: MockControlPlane | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let repoBase: string | null = null;
let stubBin: string | null = null;

function fail(msg: string, extra?: string): never {
  console.error(`  ✗ ${msg}`);
  if (extra) console.error(`    ${extra.slice(0, 800)}`);
  cleanup();
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function rmrf(p: string | null): void {
  try {
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function cleanup(): void {
  try {
    daemon?.kill();
  } catch {
    /* */
  }
  void cp?.stop();
  rmrf(home);
  rmrf(repoBase);
  rmrf(stubBin);
}
/**
 * 跑 CLI 子命令（异步 Bun.spawn，**不能用 spawnSync**）：mock-control-plane 是本进程内
 * Bun.serve，spawnSync 会同步阻塞事件循环 → 子进程 register 发来的 HTTP 请求无人应答 → 超时。
 * 异步 spawn 让事件循环空闲、in-process mock 能边跑子进程边应答。
 */
async function cli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
    env: { ...process.env, AUTOPILOT_HOME: home },
    stdin: stdin ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * 写跨平台 stub 可执行：POSIX（无扩展名 + chmod 0755）给 Linux/mac CI，`.bat` 给 Windows。
 * 两者都转发到同一个 bun 脚本（stubBody，落 <dir>/<name>.ts）。
 */
function writeStub(dir: string, name: string, stubBody: string): void {
  const tsPath = join(dir, `${name}.ts`);
  writeFileSync(tsPath, stubBody, "utf-8");
  // POSIX shim（CI Linux）
  const sh = join(dir, name);
  writeFileSync(sh, `#!/bin/sh\nexec bun run "${tsPath}" "$@"\n`, "utf-8");
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows 无 chmod 语义，忽略 */
  }
  // Windows shim
  writeFileSync(join(dir, `${name}.bat`), `@echo off\r\nbun run "${tsPath}" %*\r\n`, "utf-8");
}

// stub claude：anthropic provider 协议 = stdin 收 prompt → stdout NDJSON。
// dev 阶段额外写文件让 produceDiff/hasChanges 看到真 diff（pr 阶段才据此 commit/push）。
const STUB_CLAUDE = `
const prompt = await Bun.stdin.text();
const cwd = process.cwd();
if (prompt.includes("\\u9636\\u6bb5\\uff1adev")) {
  // 在交付分支工作树写一个文件 → produceDiff/hasChanges 有真改动
  try { await Bun.write(cwd + "/runner-smoke-feature.txt", "// implemented by runner-smoke stub\\n"); } catch {}
}
const result = "stub agent done (" + (prompt.match(/\\u9636\\u6bb5\\uff1a(\\w+)/)?.[1] ?? "?") + ")";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, session_id: "stub-" + Date.now() }) + "\\n");
process.exit(0);
`;

// stub gh：openOrUpdatePr 路径——pr view 无 PR（exit 1）→ 走 pr create → 回假 url。
const STUB_GH = `
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  // 无既有 PR：非零退出 + 空 stdout，让 openOrUpdatePr 走 create 分支
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://github.com/acme/repo/pull/1\\n");
  process.exit(0);
}
// 其他 gh 子命令（不应被调用）——回非零暴露
process.stderr.write("stub gh: unsupported args " + args.join(" ") + "\\n");
process.exit(2);
`;

async function main(): Promise<void> {
  console.log(`runner-smoke 开始，HOME=${home}`);
  mkdirSync(join(home, "runtime"), { recursive: true });

  // 1. init（建 ~/.autopilot 骨架 + 跑迁移）
  const init = await cli(["init"]);
  if (init.code !== 0) fail("autopilot init 失败", init.stderr || init.stdout);
  ok("init 完成");

  // 2. 准备 stub bin（claude / gh），稍后注入 daemon 子进程 PATH 最前
  stubBin = mkdtempSync(join(tmpdir(), "runner-smoke-bin-"));
  writeStub(stubBin, "claude", STUB_CLAUDE);
  writeStub(stubBin, "gh", STUB_GH);
  ok(`stub bin 就绪（claude/gh 于 ${stubBin}）`);

  // 3. 起 mock control-plane + claimAny（解决脚本拿不到 daemon 内真实 runner_id）
  cp = new MockControlPlane();
  await cp.start();
  cp.enableClaimAny();
  cp.injectGitToken("ghs_faketoken"); // dev/pr 链路会现取 git-token；file:// 远程下 token 走 noop
  ok(`mock control-plane 起在 ${cp.url}（claimAny）`);

  // 4. 写 runner config（mode:runner + control_plane_url；键名按 RunnerConfig：poll_wait_seconds）
  writeFileSync(
    join(home, "config.yaml"),
    `mode: runner\nrunner:\n  control_plane_url: ${cp.url}\n  name: smoke-runner\n  poll_wait_seconds: 1\n  heartbeat_seconds: 1\n`,
    "utf-8",
  );

  // 5. 注册（token 走 stdin）
  const regToken = cp.issueRegistrationToken();
  const reg = await cli(["runner", "register", "--url", cp.url, "--name", "smoke-runner"], regToken);
  if (reg.code !== 0) fail("runner register 失败", reg.stderr || reg.stdout);
  if (!existsSync(join(home, "runner", "credentials.json"))) fail("注册后未落 credentials.json", reg.stdout);
  ok("runner register（凭证落盘）");

  // 6. 准备 dev/pr 用的 bare 远程（GitHub 替身）+ seed 一个 main 分支
  repoBase = mkdtempSync(join(tmpdir(), "runner-smoke-repo-"));
  const bare = join(repoBase, "bare.git");
  const seed = join(repoBase, "seed");
  const git = (args: string[], cwd: string): void => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if ((r.exitCode ?? 0) !== 0) {
      fail(`git ${args.join(" ")} 失败`, new TextDecoder().decode(r.stderr));
    }
  };
  git(["init", "--bare", "-b", "main", bare], repoBase);
  git(["clone", bare, seed], repoBase);
  git(["config", "user.email", "t@t"], seed);
  git(["config", "user.name", "t"], seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["push", "-u", "origin", "main"], seed);
  ok("bare 远程（GitHub 替身）seed 完成");

  // 7. 起 mode:runner daemon（后台子进程）—— stub bin 注入 PATH 最前，覆盖真 claude/gh
  const pathSep = process.platform === "win32" ? ";" : ":";
  daemon = Bun.spawn(["bun", "run", join(REPO, "src/daemon/index.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      AUTOPILOT_HOME: home,
      PATH: `${stubBin}${pathSep}${process.env.PATH ?? ""}`,
      // 同时覆盖 Windows 可能用的 Path（大小写）
      Path: `${stubBin}${pathSep}${process.env.Path ?? process.env.PATH ?? ""}`,
      // gate/WAIT 轮询调到亚秒级（生产默认 30s），让 6 stage 链路在 CI 时限内跑完。
      RUNNER_WAIT_POLL_MS: "300",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ok("mode:runner daemon 已起（等 poller 领派）");

  // 8. 派一个 session（file:// 远程 = GitHub 替身；claimAny 下 assignedRunner 占位即可）
  const sid = cp.dispatchSession({
    assignedRunner: "smoke-placeholder",
    repos: [
      {
        repo_id: "repo-1",
        alias: "repo",
        remote_url: `file://${bare.replace(/\\/g, "/")}`,
        default_branch: "main",
        primary: true,
      },
    ],
    stage: "clarify",
  });
  ok(`派发 session ${sid}（clarify）`);

  // 9. 驱动链路：clarify（runner 回 assistant_message → 大脑判清楚推进 spec）→
  //    spec/dev gate（自动批准）→ pr（出 PR）。clarify 无 gate，故 assistant_message 后手动 advanceStage。
  let lastSeq = 0;
  let clarifyAdvanced = false;
  const drive = (): void => {
    const evs = cp!.events(sid).filter((e) => e.seq > lastSeq);
    for (const e of evs) {
      lastSeq = Math.max(lastSeq, e.seq);
      if (e.event_type === "clarification_requested") {
        cp!.injectUserMessage(sid, "按默认实现即可");
      }
      if (e.event_type === "gate_opened") {
        cp!.decideGate(sid, String(e.payload.gate_id), "approved");
      }
      // clarify 阶段 runner 只回 assistant_message（不开 gate、stage 字段为 null）→ 大脑判清楚，推进到 spec。
      // 注意：用 session.current_stage 判定而非 e.stage——runner 的 clarify assistant_message 不带 stage。
      if (
        e.event_type === "assistant_message" &&
        !clarifyAdvanced &&
        cp!.sessionStatus(sid)?.current_stage === "clarify"
      ) {
        clarifyAdvanced = true;
        cp!.advanceStage(sid); // clarify → spec
      }
    }
  };
  const start = Date.now();
  const DEADLINE_MS = 180_000;
  while (Date.now() - start < DEADLINE_MS) {
    drive();
    const s = cp.sessionStatus(sid);
    if (s && (s.status === "completed" || s.status === "failed")) break;
    await Bun.sleep(400);
  }

  // 10. 断言：链路出现 spec stage_artifact + dev stage_artifact + pr_created + session done
  const all = cp.events(sid);
  const types = all.map((e) => `${e.event_type}@${e.stage ?? "-"}`);
  if (!all.some((e) => e.event_type === "stage_artifact" && e.payload.kind === "spec")) {
    fail("缺 spec stage_artifact 事件", JSON.stringify(types));
  }
  ok("spec 阶段产 stage_artifact");
  if (!all.some((e) => e.event_type === "stage_artifact" && e.payload.kind === "dev")) {
    fail("缺 dev stage_artifact 事件", JSON.stringify(types));
  }
  ok("dev 阶段产 stage_artifact（仅 diff，未 push）");
  if (!all.some((e) => e.event_type === "pr_created")) {
    fail("缺 pr_created 事件（pr 阶段未出 PR）", JSON.stringify(types));
  }
  ok("pr 阶段产 pr_created");
  const final = cp.sessionStatus(sid);
  if (final?.status !== "completed") fail(`session 未 done（status=${final?.status}）`, JSON.stringify(types));
  if (!final.pr_url) fail("session.pr_url 未写");
  ok(`session done，pr_url=${final.pr_url}`);

  // 11. 验远程 bare 上确有交付分支（pr 阶段真 push 了 reqgenie/<sid>）
  const br = Bun.spawnSync(["git", "branch"], { cwd: bare, stdout: "pipe", stderr: "pipe" });
  const branches = new TextDecoder().decode(br.stdout);
  if (!branches.includes("reqgenie/")) {
    fail("远程 bare 无 reqgenie/ 交付分支（pr 阶段未真 push）", branches);
  }
  ok("远程交付分支已 push");

  cleanup();
  console.log("\n✅ runner 离线契约冒烟全链路通（clarify→spec→dev→pr→pr_created→done）");
}

main().catch((e: unknown) => {
  console.error("runner-smoke 异常：", e);
  cleanup();
  process.exit(1);
});
