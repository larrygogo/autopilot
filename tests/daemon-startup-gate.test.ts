/**
 * SEC-6 启动安全门的进程级回归测试。
 *
 * 2026-06-10/11 两次事故后语义升级：暴露 host 且未设防时不再 exit(2) 拒启
 * （「配置矛盾等重启才引爆 → 启不起来」反复烧伤），而是**自动生成 API token
 * 写入 runtime/api-token 并继续启动** —— 生成后即设防，安全不降级。
 *
 * 这里用真实子进程 + 临时 AUTOPILOT_HOME 验证：
 * - 裸跑 daemon：自动设防（token 文件落地 + daemon.log 记录）并保持运行
 * - `daemon run`（不带 -H）读 config 的 0.0.0.0：同样自动设防保持运行
 * - --insecure-no-auth 逃生口仍然有效
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

const homes: string[] = [];

// 每个用例独立端口：自动设防后 daemon 会真监听，硬杀后 Windows 可能短暂残留
// zombie LISTEN（见 daemon-port-6181 事故），串行复用同端口会让后续用例 EADDRINUSE
function makeExposedHome(port: number): string {
  const home = mkdtempSync(join(tmpdir(), "ap-gate-"));
  writeFileSync(
    join(home, "config.yaml"),
    `daemon:\n  host: 0.0.0.0\n  port: ${port}\n`,
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
  it("裸跑 daemon 暴露未设防：自动生成 token 设防并保持运行（不再 exit 2）", async () => {
    const home = makeExposedHome(16555);
    // 自动设防后 daemon 常驻 → 超时杀掉返回 -1 即为「没有被拒启」
    const exitCode = await runWithTimeout(
      ["bun", "run", join(REPO_ROOT, "src/daemon/index.ts")],
      home,
      20_000,
    );
    expect(exitCode).toBe(-1);

    // token 文件已自动落地
    expect(existsSync(join(home, "runtime", "api-token"))).toBe(true);
    const token = readFileSync(join(home, "runtime", "api-token"), "utf-8").trim();
    expect(token.length).toBeGreaterThan(20);

    // daemon.log 记录了自动设防原因
    const logPath = join(home, "runtime", "logs", "daemon.log");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("0.0.0.0");
    expect(logContent).toContain("自动生成");
  }, 40_000);

  it("daemon run（不带 -H）读 config 的 0.0.0.0：同样自动设防保持运行", async () => {
    const home = makeExposedHome(16556);
    const exitCode = await runWithTimeout(
      ["bun", "run", join(REPO_ROOT, "src/cli/index.ts"), "daemon", "run"],
      home,
      20_000,
    );
    expect(exitCode).toBe(-1);
    expect(existsSync(join(home, "runtime", "api-token"))).toBe(true);
  }, 40_000);

  it("daemon run --insecure-no-auth 可跳过安全门（SEC-6 提示给出的逃生口必须真实存在）", async () => {
    const home = makeExposedHome(16557);
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
