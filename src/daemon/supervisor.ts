import { join } from "path";
import { VERSION } from "../index";
import {
  writeSupervisorPid,
  removeSupervisorPid,
  readPid,
  isProcessAlive,
  isSupervisorRunning,
  isDaemonRunning,
} from "./pid";

// ──────────────────────────────────────────────
// Supervisor —— 长驻进程，子进程（daemon）崩了就重启
//
// 约定：
// - 子进程退出码 0 → 优雅退出，supervisor 也退出
// - 非 0 退出码 或 被信号杀死（SIGKILL / SIGSEGV）→ 视为崩溃，重启
// - 指数退避：1s / 2s / 5s / 10s / 30s / 60s，上限 60s
// - 连续 10 次 <30s 内重启 → 进入"快速崩溃"判定，退避到 60s
// - Supervisor 收到 SIGTERM / SIGINT → 转发给子进程，等子进程退出后自己退出
// ──────────────────────────────────────────────

const BASE_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const CRASH_LOOP_WINDOW_MS = 30_000;
const CRASH_LOOP_THRESHOLD = 10;

function nextBackoff(attempt: number): number {
  return BASE_BACKOFF_MS[Math.min(attempt, BASE_BACKOFF_MS.length - 1)];
}

export interface SupervisorOptions {
  port?: number;
  host?: string;
}

export async function runSupervisor(opts: SupervisorOptions = {}): Promise<void> {
  if (isSupervisorRunning()) {
    console.error("错误：supervisor 已在运行中。");
    process.exit(1);
  }
  if (isDaemonRunning()) {
    console.error("错误：daemon 已在运行中（可能是裸跑 `daemon run` 的进程）。");
    process.exit(1);
  }

  writeSupervisorPid();
  console.log(`autopilot supervisor v${VERSION} started (pid=${process.pid})`);

  const daemonScript = join(import.meta.dir, "index.ts");
  const baseArgs = ["run", daemonScript];
  if (opts.port) baseArgs.push("--port", String(opts.port));
  if (opts.host) baseArgs.push("--host", opts.host);

  let shuttingDown = false;
  let currentChild: ReturnType<typeof Bun.spawn> | null = null;
  let attempt = 0;
  const crashTimestamps: number[] = [];

  const forwardSignal = (sig: NodeJS.Signals) => {
    shuttingDown = true;
    console.log(`supervisor 收到 ${sig}，通知 daemon 子进程退出`);
    if (currentChild && !currentChild.killed) {
      try { currentChild.kill(sig); } catch { /* ignore */ }
    }
  };
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGINT", () => forwardSignal("SIGINT"));

  while (!shuttingDown) {
    const startedAt = Date.now();
    currentChild = Bun.spawn(["bun", ...baseArgs], {
      stdout: "inherit",
      stderr: "inherit",
    });
    console.log(`daemon 子进程启动 (pid=${currentChild.pid})`);
    const exitCode = await currentChild.exited;
    const ranMs = Date.now() - startedAt;

    if (shuttingDown) {
      console.log(`daemon 退出（信号传递完成），supervisor 退出`);
      break;
    }

    if (exitCode === 0) {
      console.log("daemon 优雅退出（code=0），supervisor 同步退出");
      break;
    }

    // 崩溃 —— 记录时间戳用于判断快速崩溃循环
    const now = Date.now();
    crashTimestamps.push(now);
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_LOOP_WINDOW_MS) {
      crashTimestamps.shift();
    }
    const crashLoop = crashTimestamps.length >= CRASH_LOOP_THRESHOLD;

    attempt++;
    const backoff = crashLoop ? BASE_BACKOFF_MS[BASE_BACKOFF_MS.length - 1] : nextBackoff(attempt - 1);
    console.error(
      `daemon 异常退出 (code=${exitCode}, 运行 ${Math.round(ranMs / 1000)}s)` +
      `${crashLoop ? "，检测到快速崩溃循环，延长到" : "，将在"} ${backoff / 1000}s 后重启`,
    );
    // 在退避期间仍然响应退出信号
    const sleepTarget = Date.now() + backoff;
    while (!shuttingDown && Date.now() < sleepTarget) {
      await Bun.sleep(Math.min(500, sleepTarget - Date.now()));
    }

    // 只要 daemon 能活一段时间（≥ 10s），重置退避
    if (ranMs > 10_000) attempt = 0;
  }

  // 确认 daemon 真的已退出（supervisor 可能先于子进程退出）
  const daemonPid = readPid();
  if (daemonPid && isProcessAlive(daemonPid)) {
    try { process.kill(daemonPid, "SIGTERM"); } catch { /* ignore */ }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await Bun.sleep(200);
      if (!isProcessAlive(daemonPid)) break;
    }
  }
  removeSupervisorPid();
  console.log("supervisor 已停止。");
}

// 允许直接作为入口执行（cli 后台 spawn 时用到）
if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: SupervisorOptions = {};
  const portIdx = args.indexOf("--port");
  const hostIdx = args.indexOf("--host");
  if (portIdx !== -1 && args[portIdx + 1]) opts.port = parseInt(args[portIdx + 1], 10);
  if (hostIdx !== -1 && args[hostIdx + 1]) opts.host = args[hostIdx + 1];
  runSupervisor(opts);
}
