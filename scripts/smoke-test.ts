#!/usr/bin/env bun
/**
 * 客户 onboarding 烟雾测试。
 *
 * 跑客户从 git clone 到能用的完整 CLI 路径：
 *   init → 数据库表全部存在 → project create → codebase create →
 *   project list 验证 → codebase list 验证 → doctor → daemon status（daemon 不跑应报错）
 *
 * 用 tmpdir 隔离 AUTOPILOT_HOME，跑完清理。任何一步失败立即退出非 0。
 *
 * 用途：
 *   - 本地：bun run smoke-test
 *   - CI: .github/workflows/ci.yml 的 smoke-test job
 *
 * 不起 daemon —— daemon e2e 复杂，留单测覆盖。本脚本只保证 install 路径不破。
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

const REPO = process.cwd();
const tmpHome = join(tmpdir(), `autopilot-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const tmpCodebase = join(tmpdir(), `autopilot-smoke-cb-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let stepNum = 0;
function step(name: string): void {
  stepNum++;
  console.log(`\n🔵 [${stepNum}] ${name}`);
}

function runCli(args: string[], expectedExit = 0): { stdout: string; stderr: string; exitCode: number } {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  const exitCode = r.exitCode ?? -1;
  if (exitCode !== expectedExit) {
    console.error(`  ✗ exit ${exitCode}（期望 ${expectedExit}）`);
    if (stdout) console.error(`  stdout: ${stdout.slice(0, 300)}`);
    if (stderr) console.error(`  stderr: ${stderr.slice(0, 300)}`);
    cleanup();
    process.exit(1);
  }
  return { stdout, stderr, exitCode };
}

function assertContains(text: string, needle: string, label: string): void {
  if (!text.includes(needle)) {
    console.error(`  ✗ ${label} 未找到 "${needle}"`);
    console.error(`  实际: ${text.slice(0, 300)}`);
    cleanup();
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
}

function cleanup(): void {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (existsSync(tmpCodebase)) rmSync(tmpCodebase, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log(`smoke-test 开始，临时 HOME: ${tmpHome}`);

  // ────────────────────────────────────────────────
  step("autopilot init —— 创建目录 + 跑迁移 + 装 dev workflow");
  // ────────────────────────────────────────────────
  mkdirSync(tmpHome, { recursive: true });
  const r1 = runCli(["init"]);
  assertContains(r1.stdout, "应用", "输出含'应用 N 条迁移'（bug 19 fix）");
  assertContains(r1.stdout, "默认工作流", "输出含'装入默认工作流'（bug 8 fix）");

  // ────────────────────────────────────────────────
  step("验数据库表完整 —— schema_version + 5 个核心业务表");
  // ────────────────────────────────────────────────
  const dbPath = join(tmpHome, "runtime", "workflow.db");
  if (!existsSync(dbPath)) {
    console.error("  ✗ workflow.db 不存在");
    cleanup();
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const versions = db.query("SELECT version FROM schema_version").all() as { version: number }[];
    if (versions.length < 1) {
      console.error("  ✗ schema_version 表为空");
      cleanup();
      process.exit(1);
    }
    console.log(`  ✓ schema_version v${Math.max(...versions.map((v) => v.version))}`);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    for (const required of ["projects", "codebases", "requirements", "workflows", "schedules"]) {
      if (!names.has(required)) {
        console.error(`  ✗ 表 ${required} 不存在`);
        cleanup();
        process.exit(1);
      }
    }
    console.log(`  ✓ projects / codebases / requirements / workflows / schedules 全存在`);
  } finally {
    db.close();
  }

  // ────────────────────────────────────────────────
  step("autopilot init —— 二次跑保持幂等");
  // ────────────────────────────────────────────────
  const r2 = runCli(["init"]);
  if (r2.stdout.match(/应用 \d+ 条迁移/)) {
    console.error("  ✗ 二次 init 不该重复跑迁移");
    cleanup();
    process.exit(1);
  }
  console.log(`  ✓ 二次 init 幂等（不重复迁移）`);

  // ────────────────────────────────────────────────
  step("autopilot config show / path —— 不需要 daemon");
  // ────────────────────────────────────────────────
  const showR = runCli(["config", "show"]);
  assertContains(showR.stdout, "bun run dev config doctor", "config show 输出含 doctor 引导注释");
  const pathR = runCli(["config", "path"]);
  if (!pathR.stdout.trim().endsWith("config.yaml")) {
    console.error("  ✗ config path 输出不以 config.yaml 结尾");
    cleanup();
    process.exit(1);
  }
  console.log(`  ✓ config path 输出绝对路径`);

  // ────────────────────────────────────────────────
  step("autopilot doctor —— 零配置 L1 报告");
  // ────────────────────────────────────────────────
  const docR = runCli(["doctor", "--json"]);
  let parsed: { level?: number; status?: string };
  try {
    parsed = JSON.parse(docR.stdout);
  } catch {
    console.error("  ✗ doctor --json 输出无法解析为 JSON");
    cleanup();
    process.exit(1);
  }
  if (parsed.level !== 1) {
    console.error(`  ✗ doctor 默认 level 应为 1，得到 ${parsed.level}`);
    cleanup();
    process.exit(1);
  }
  // bug 16/17: 零配置 + warning 不阻塞 exit
  if (docR.exitCode !== 0) {
    console.error(`  ✗ doctor 零配置应 exit 0（bug 16/17），得到 ${docR.exitCode}`);
    cleanup();
    process.exit(1);
  }
  console.log(`  ✓ doctor exit 0 + level=1 + status=${parsed.status}`);

  // ────────────────────────────────────────────────
  step("autopilot project list —— 不通 daemon 应报错（exit ≠ 0）");
  // ────────────────────────────────────────────────
  const pListR = runCli(["project", "list", "--port", "19999"], /* expectedExit */ 3);
  assertContains(pListR.stderr, "daemon", "错误信息含 'daemon' 引导用户启动");

  // ────────────────────────────────────────────────
  step("autopilot project --help —— 命令完整（bug 20）");
  // ────────────────────────────────────────────────
  const pHelpR = runCli(["project", "--help"]);
  for (const sub of ["list", "create", "delete"]) {
    assertContains(pHelpR.stdout, sub, `project ${sub} 子命令注册`);
  }

  // ────────────────────────────────────────────────
  step("autopilot codebase --help —— 命令完整（bug 21）");
  // ────────────────────────────────────────────────
  const cHelpR = runCli(["codebase", "--help"]);
  for (const sub of ["list", "create", "delete", "health"]) {
    assertContains(cHelpR.stdout, sub, `codebase ${sub} 子命令注册`);
  }

  // ────────────────────────────────────────────────
  step("autopilot codebase create —— path 不存在时本地校验 exit 2");
  // ────────────────────────────────────────────────
  const fakePath = join(tmpdir(), `nonexistent-${Date.now()}`);
  const cFakeR = runCli(["codebase", "create", "myrepo", fakePath, "--port", "19999"], 2);
  assertContains(cFakeR.stderr, "path 不存在", "codebase create 报 path 错误");

  // ────────────────────────────────────────────────
  step("autopilot req new --help —— 无 daemon 也能看 help");
  // ────────────────────────────────────────────────
  const reqHelpR = runCli(["req", "new", "--help"]);
  for (const opt of ["--from-prompt", "-f", "--no-extract"]) {
    assertContains(reqHelpR.stdout, opt, `req new ${opt} 选项注册`);
  }

  // ────────────────────────────────────────────────
  step("autopilot workflow list —— 不依赖 daemon");
  // ────────────────────────────────────────────────
  // 用死端口强制走离线路径：daemon 不可达时 CLI 直接读 tmpHome 本地 registry。
  // （不指定端口会打到开发者本地已有的 daemon、拿到真实 home 的数据 → 在开发机假绿、
  //  只有干净环境 CI 才暴露；这正是此步曾长期失败的原因。）
  const wfListR = runCli(["workflow", "list", "--port", "19999"]);
  assertContains(wfListR.stdout, "dev", "workflow list 含 dev（init 装的默认 workflow）");
  assertContains(wfListR.stdout, "ad-hoc", "workflow list 含 ad-hoc（离线读 tmpHome 生效）");

  // ────────────────────────────────────────────────
  step("init 装入 ad-hoc workflow 模板（Phase 4 spec §3.7）");
  // ────────────────────────────────────────────────
  // 直接检查 tmpHome 目录，确认 init 把 ad-hoc 模板文件（workflow.yaml）落了盘。
  const adHocDir = join(tmpHome, "workflows", "ad-hoc");
  if (!existsSync(adHocDir)) {
    console.error(`  ✗ tmpHome 下缺 ad-hoc workflow：${adHocDir}`);
    cleanup();
    process.exit(1);
  }
  if (!existsSync(join(adHocDir, "workflow.yaml"))) {
    console.error(`  ✗ ad-hoc 工作流缺 workflow.yaml`);
    cleanup();
    process.exit(1);
  }
  console.log(`  ✓ ad-hoc workflow 装入 ${adHocDir}`);

  // ────────────────────────────────────────────────
  step("autopilot run --help —— ad-hoc 命令完整（Phase 4 spec §3.7）");
  // ────────────────────────────────────────────────
  const runHelpR = runCli(["run", "--help"]);
  for (const opt of ["--codebase", "--workflow", "--no-follow"]) {
    assertContains(runHelpR.stdout, opt, `run ${opt} 选项注册`);
  }

  // ────────────────────────────────────────────────
  step("autopilot daemon status —— daemon 未启时优雅提示");
  // ────────────────────────────────────────────────
  const dStatusR = runCli(["daemon", "status"]);
  assertContains(dStatusR.stdout, "未在运行", "daemon status 提示未运行");

  // ────────────────────────────────────────────────
  step("smoke-test 全部通过");
  // ────────────────────────────────────────────────
  cleanup();
  console.log("\n✅ 客户 onboarding CLI 路径全链路通");
}

main().catch((e: unknown) => {
  console.error("smoke-test 异常：", e);
  cleanup();
  process.exit(1);
});
