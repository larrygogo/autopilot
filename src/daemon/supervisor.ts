import { join } from "path";
import { VERSION } from "../index";
import { isStandaloneBinary } from "../core/runtime-env";
import {
  writeSupervisorPid,
  removeSupervisorPid,
  readPid,
  removePid,
  removeListenInfo,
  isProcessAlive,
  isSupervisorRunning,
  isDaemonRunning,
  writeSupervisorState,
  removeSupervisorState,
  type SupervisorState,
} from "./pid";

// ──────────────────────────────────────────────
// Supervisor —— 长驻进程，子进程（daemon）崩了就重启
//
// 约定：
// - 子进程退出码 0 → 优雅退出，supervisor 也退出
// - 子进程退出码 75（RESTART_SENTINEL）→ 主动请求 respawn（如改 host/port 后），
//   supervisor 立即重启 daemon，跳过退避，不增加 attempt 计数
// - 非 0 / 非 75 退出码 或 被信号杀死（SIGKILL / SIGSEGV）→ 视为崩溃，重启
// - 指数退避：1s / 2s / 5s / 10s / 30s / 60s，上限 60s
// - 连续 10 次 <30s 内重启 → 进入"快速崩溃"判定，退避到 60s
// - Supervisor 收到 SIGTERM / SIGINT → 转发给子进程，等子进程退出后自己退出
// ──────────────────────────────────────────────

/** daemon 主动请求 respawn 的退出码（参考 sysexits.h EX_TEMPFAIL） */
export const RESTART_SENTINEL_CODE = 75;

/**
 * daemon 确定性配置错误的退出码（如 SEC-6 启动安全门拦截）。
 * 配置不改重启一万次结果也一样，supervisor 看到此码直接停下报人，不进退避循环。
 */
export const FATAL_CONFIG_CODE = 2;

export const BASE_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
export const CRASH_LOOP_WINDOW_MS = 30_000;
export const CRASH_LOOP_THRESHOLD = 10;

function nextBackoff(attempt: number): number {
  return BASE_BACKOFF_MS[Math.min(attempt, BASE_BACKOFF_MS.length - 1)];
}

// ──────────────────────────────────────────────
// 纯函数决策层（便于单测覆盖；runSupervisor 内部直接调用）
// ──────────────────────────────────────────────

export type ExitClassification = "exit_clean" | "respawn_immediate" | "fatal_config" | "crash";

/**
 * 子进程退出码 → supervisor 动作。
 * - shuttingDown=true：不管 exitCode 都 exit_clean（信号传递完成）
 * - exit 0：optional 退出
 * - exit 75：主动 respawn，不退避
 * - exit 2：确定性配置错误（SEC-6 等），重启无意义，supervisor 停下报人
 * - 其他：视为崩溃
 */
export function classifyExit(exitCode: number | null, shuttingDown: boolean): ExitClassification {
  if (shuttingDown) return "exit_clean";
  if (exitCode === 0) return "exit_clean";
  if (exitCode === RESTART_SENTINEL_CODE) return "respawn_immediate";
  if (exitCode === FATAL_CONFIG_CODE) return "fatal_config";
  return "crash";
}

/**
 * 崩溃退避计算。
 * - 维护近 CRASH_LOOP_WINDOW_MS 窗口内的崩溃时间戳
 * - 加入当前时间戳；若总数 ≥ CRASH_LOOP_THRESHOLD 判定 crash loop，退避到 max
 * - 否则按 attempt 索引取退避
 *
 * 调用方负责把 nextCrashTimestamps 写回 state 并应用 sleep(backoffMs)。
 */
export function computeCrashBackoff(input: {
  crashTimestamps: number[];
  attempt: number;
  now: number;
}): { backoffMs: number; isCrashLoop: boolean; nextCrashTimestamps: number[] } {
  const filtered = input.crashTimestamps.filter((t) => input.now - t <= CRASH_LOOP_WINDOW_MS);
  filtered.push(input.now);
  const isCrashLoop = filtered.length >= CRASH_LOOP_THRESHOLD;
  const backoffMs = isCrashLoop
    ? BASE_BACKOFF_MS[BASE_BACKOFF_MS.length - 1]!
    : nextBackoff(input.attempt);
  return { backoffMs, isCrashLoop, nextCrashTimestamps: filtered };
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
  // 运行状态投影（供 daemon status 读出重启次数 / 崩因）——写失败静默，不影响主循环
  const state: SupervisorState = {
    supervisor_pid: process.pid,
    started_at: Date.now(),
    daemon_spawns: 0,
    restarts: 0,
    last_exit_code: null,
    last_classification: null,
    last_crash_at: null,
    crash_loop: false,
  };
  writeSupervisorState(state);
  console.log(`autopilot supervisor v${VERSION} started (pid=${process.pid})`);

  // 编译单文件模式：无 bun 可执行、无 index.ts 文件，直接用 execPath 子命令。
  // dev 模式：保持原来的 bun run <script> 方式。
  const standalone = isStandaloneBinary();
  const spawnCmd: string[] = standalone
    ? [process.execPath, "daemon", "run"]
    : ["bun", "run", join(import.meta.dir, "index.ts")];
  if (opts.port) spawnCmd.push("--port", String(opts.port));
  if (opts.host) spawnCmd.push("--host", opts.host);

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
    // stdio 必须用 ignore：当 supervisor 自身是后台 detach 启动时，inherit 的
    // stdout/stderr 句柄无效，会让 daemon 子进程一启动就崩溃。daemon 自己用 logger
    // 写文件日志，不依赖标准输出。
    currentChild = Bun.spawn(spawnCmd, {
      stdout: "ignore",
      stderr: "ignore",
    });
    console.log(`daemon 子进程启动 (pid=${currentChild.pid})`);
    state.daemon_spawns++;
    writeSupervisorState(state);
    const exitCode = await currentChild.exited;
    const ranMs = Date.now() - startedAt;

    const classification = classifyExit(exitCode, shuttingDown);
    state.last_exit_code = exitCode;
    state.last_classification = classification;
    if (classification === "exit_clean") {
      console.log(shuttingDown
        ? `daemon 退出（信号传递完成），supervisor 退出`
        : `daemon 优雅退出（code=0），supervisor 同步退出`);
      break;
    }
    if (classification === "respawn_immediate") {
      console.log(`daemon 主动请求 respawn (code=${RESTART_SENTINEL_CODE})，立即重启`);
      continue;
    }
    if (classification === "fatal_config") {
      console.error(
        `daemon 因配置错误退出 (code=${exitCode})，不自动重启。` +
        `原因见 runtime/logs/daemon.log，修复配置后用 autopilot daemon start 重新启动`,
      );
      break;
    }

    // crash 分支：用纯函数算 backoff
    const now = Date.now();
    const { backoffMs: backoff, isCrashLoop: crashLoop, nextCrashTimestamps } = computeCrashBackoff({
      crashTimestamps,
      attempt,
      now,
    });
    crashTimestamps.length = 0;
    crashTimestamps.push(...nextCrashTimestamps);
    attempt++;
    state.restarts++;
    state.last_crash_at = now;
    state.crash_loop = crashLoop;
    writeSupervisorState(state);
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
  // Windows 下 SIGTERM 实际是 TerminateProcess，daemon 来不及运行自己的 SIGTERM handler
  // 来清理 PID 文件，因此 supervisor 退出前兜底清理一次。
  removePid();
  removeListenInfo();
  removeSupervisorPid();
  removeSupervisorState();
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
