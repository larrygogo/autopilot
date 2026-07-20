import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import type { SupervisorStatusInfo } from "./protocol";

// 路径函数化（不是常量）以便测试用 tmpdir 隔离：process.env.AUTOPILOT_HOME
// 优先 / 常量兜底。daemon 运行期间 env 不变，行为跟常量等价。

function home(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

function pidFile(): string {
  return join(home(), "runtime", "daemon.pid");
}

function supervisorPidFile(): string {
  return join(home(), "runtime", "supervisor.pid");
}

function listenFile(): string {
  return join(home(), "runtime", "daemon.listen.json");
}

export function getPidFilePath(): string {
  return pidFile();
}

export function getSupervisorPidFilePath(): string {
  return supervisorPidFile();
}

export function writePid(): void {
  writeFileSync(pidFile(), String(process.pid), "utf-8");
}

export function readPid(): number | null {
  const path = pidFile();
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removePid(): void {
  try {
    unlinkSync(pidFile());
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    // 僵尸 PID 文件，清理
    removePid();
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// Supervisor PID（独立于 daemon PID）
// ──────────────────────────────────────────────

export function writeSupervisorPid(): void {
  writeFileSync(supervisorPidFile(), String(process.pid), "utf-8");
}

export function readSupervisorPid(): number | null {
  const path = supervisorPidFile();
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removeSupervisorPid(): void {
  try { unlinkSync(supervisorPidFile()); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────
// daemon 实际监听地址元数据 —— daemon 启动时写入，客户端/status 读取
// ──────────────────────────────────────────────

export interface DaemonListenInfo {
  host: string;
  port: number;
}

export function writeListenInfo(info: DaemonListenInfo): void {
  try {
    const path = listenFile();
    // 自动创建 runtime 目录（init 没跑过 / tmpdir 隔离场景）
    const { mkdirSync } = require("fs") as typeof import("fs");
    const { dirname } = require("path") as typeof import("path");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(info), "utf-8");
  } catch { /* ignore */ }
}

export function readListenInfo(): DaemonListenInfo | null {
  const path = listenFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed?.host === "string" && typeof parsed?.port === "number") {
      return { host: parsed.host, port: parsed.port };
    }
  } catch { /* ignore */ }
  return null;
}

export function removeListenInfo(): void {
  try { unlinkSync(listenFile()); } catch { /* ignore */ }
}

export function isSupervisorRunning(): boolean {
  const pid = readSupervisorPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    removeSupervisorPid();
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// Supervisor 运行状态（重启次数 / 崩因 / 退避）—— supervisor 内存态的磁盘投影，
// 供 `daemon status` 读出「supervisor 重启了几次、上次崩因是什么」（可观测性）。
// 所有写入 try/catch 静默失败，绝不影响 supervisor 崩溃恢复主循环。
// ──────────────────────────────────────────────

export interface SupervisorState {
  supervisor_pid: number;
  started_at: number; // epoch ms
  daemon_spawns: number; // daemon 子进程累计启动次数
  restarts: number; // 崩溃触发的重启次数
  last_exit_code: number | null;
  last_classification: string | null; // exit_clean / respawn_immediate / fatal_config / crash
  last_crash_at: number | null; // epoch ms
  crash_loop: boolean;
}

function supervisorStateFile(): string {
  return join(home(), "runtime", "supervisor.state.json");
}

export function writeSupervisorState(state: SupervisorState): void {
  try {
    const path = supervisorStateFile();
    const { mkdirSync } = require("fs") as typeof import("fs");
    const { dirname } = require("path") as typeof import("path");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf-8");
  } catch { /* ignore：状态投影失败不影响 supervisor 主循环 */ }
}

export function readSupervisorState(): SupervisorState | null {
  const path = supervisorStateFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed?.supervisor_pid === "number" && typeof parsed?.started_at === "number") {
      return parsed as SupervisorState;
    }
  } catch { /* ignore */ }
  return null;
}

export function removeSupervisorState(): void {
  try { unlinkSync(supervisorStateFile()); } catch { /* ignore */ }
}

// crash-loop 告警去重标记：记录已就哪个 supervisor 会话（started_at）告过警，
// 避免同一崩溃循环里 daemon 每次被 respawn 都重复记通知。
function crashLoopAlertFile(): string {
  return join(home(), "runtime", "crash-loop-alert.json");
}

export function readCrashLoopAlertedAt(): number | null {
  const path = crashLoopAlertFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.alerted_started_at === "number" ? parsed.alerted_started_at : null;
  } catch { return null; }
}

export function writeCrashLoopAlertedAt(startedAt: number): void {
  try {
    writeFileSync(crashLoopAlertFile(), JSON.stringify({ alerted_started_at: startedAt }), "utf-8");
  } catch { /* ignore：去重标记写失败最多多记一条通知，不影响正确性 */ }
}

/**
 * 汇总 supervisor 运行状态（供 daemon.status RPC / /api/status 透出到 Web/CLI）。
 * running 凭 supervisor.pid 存活判定；其余指标读 supervisor.state（无则给零值缺省）。
 */
export function getSupervisorStatus(): SupervisorStatusInfo {
  const pid = readSupervisorPid();
  const running = pid !== null && isProcessAlive(pid);
  const st = readSupervisorState();
  return {
    running,
    pid,
    started_at: st?.started_at ?? null,
    daemon_spawns: st?.daemon_spawns ?? 0,
    restarts: st?.restarts ?? 0,
    last_exit_code: st?.last_exit_code ?? null,
    last_crash_at: st?.last_crash_at ?? null,
    // crash_loop 只在 supervisor 存活时透出：state 文件在 SIGKILL / 断电后残留
    //（removeSupervisorState 只在优雅退出时跑），死 supervisor 谈不上"正在崩溃循环"，
    // 陈旧判定收口在这一处，消费方（Web 告警 / CLI / 通知补记）不必各自发明。
    crash_loop: running ? (st?.crash_loop ?? false) : false,
  };
}

// ──────────────────────────────────────────────
// restart.flag —— 主动重启标志：新 daemon 启动时识别「上一次是主动重启不是崩溃」，
// 从而对 running_* task 走自动 respawn（关旧 phase event + 立即重跑）而非标
// dangling 等用户。daemon.restart RPC 与 CLI `daemon restart` 都应写它——
// CLI 路径曾漏写，导致被打断任务落到 dangling 分支、最终靠 watcher 卡死判定
// 兜底恢复（慢几分钟，且修复前还会留僵尸 open phase event）。
// ──────────────────────────────────────────────

function restartFlagFile(): string {
  return join(home(), "runtime", "restart.flag");
}

export function writeRestartFlag(): void {
  try {
    writeFileSync(restartFlagFile(), String(Date.now()), "utf-8");
  } catch { /* 写失败不阻塞重启，代价是 task 被标 dangling 等用户 */ }
}

/** 检查并消费 restart.flag。返回 true 表示这次启动是主动重启的延续。 */
export function consumeRestartFlag(): boolean {
  const p = restartFlagFile();
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
  } catch { /* 删失败也不影响逻辑，下次启动还会再读到（保守做法） */ }
  return true;
}
