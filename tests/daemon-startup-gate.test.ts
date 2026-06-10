/**
 * SEC-6 启动安全门的进程级回归测试。
 *
 * 2026-06-10 事故：config.yaml 配 host 0.0.0.0 且无 token/用户时，daemon exit(2)，
 * 但报错只走 stderr（supervisor 模式下被 ignore 吞掉），daemon.log 无任何痕迹，
 * 用户只看到"无法启动"。另外 `daemon run` CLI 给 host 默认值 127.0.0.1 覆盖了
 * config.yaml，导致"前台正常、后台必崩"的排查假象。
 *
 * 这里用真实子进程 + 临时 AUTOPILOT_HOME 复现：
 * - 裸跑 daemon 脚本被拦截时，退出码 2 且原因写入 daemon.log
 * - `daemon run`（不带 -H）读 config 的 0.0.0.0，同样被安全门拦截
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
// 死端口：避免与本机真实 daemon（6180）冲突
const DEAD_PORT = 16555;

const homes: string[] = [];

function makeExposedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ap-gate-"));
  writeFileSync(
    join(home, "config.yaml"),
    `daemon:\n  host: 0.0.0.0\n  port: ${DEAD_PORT}\n`,
    "utf-8",
  );
  homes.push(home);
  return home;
}

function gateEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, AUTOPILOT_HOME: home };
  delete env.AUTOPILOT_API_TOKEN;
  delete env.AUTOPILOT_HOST;
  delete env.AUTOPILOT_PORT;
  return env;
}

/** spawn 子进程并等退出；超时（视为没被安全门拦住）则杀掉并返回 -1。 */
async function runWithTimeout(cmd: string[], home: string, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: gateEnv(home),
    stdout: "ignore",
    stderr: "ignore",
  });
  const result = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => {
      proc.kill();
      return -1;
    }),
  ]);
  return result;
}

afterAll(() => {
  for (const home of homes) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("SEC-6 启动安全门", () => {
  it("裸跑 daemon 被拦截：exit 2 且原因写入 daemon.log", async () => {
    const home = makeExposedHome();
    const exitCode = await runWithTimeout(
      ["bun", "run", join(REPO_ROOT, "src/daemon/index.ts")],
      home,
      30_000,
    );
    expect(exitCode).toBe(2);

    const logPath = join(home, "runtime", "logs", "daemon.log");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("0.0.0.0");
    expect(logContent).toContain("安全门");
  }, 40_000);

  it("daemon run（不带 -H）读 config 的 0.0.0.0，同样被拦截 exit 2", async () => {
    const home = makeExposedHome();
    const exitCode = await runWithTimeout(
      ["bun", "run", join(REPO_ROOT, "src/cli/index.ts"), "daemon", "run"],
      home,
      30_000,
    );
    expect(exitCode).toBe(2);
  }, 40_000);

  it("daemon run --insecure-no-auth 可跳过安全门（SEC-6 提示给出的逃生口必须真实存在）", async () => {
    const home = makeExposedHome();
    // 跳过安全门后 daemon 会真正启动并常驻 → runWithTimeout 超时杀掉返回 -1 即为成功；
    // 若 commander 不认识该 option 或仍被安全门拦，则会快速退出非 -1
    const exitCode = await runWithTimeout(
      ["bun", "run", join(REPO_ROOT, "src/cli/index.ts"), "daemon", "run", "--insecure-no-auth"],
      home,
      20_000,
    );
    expect(exitCode).toBe(-1);
  }, 40_000);
});
