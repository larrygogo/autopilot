/**
 * checkSupervisorCrashLoop —— daemon 启动时读 supervisor.state 补记崩溃循环告警。
 *
 * 覆盖：
 * - crash_loop=true 且本会话未告警 → 记 1 条 supervisor_crash_loop
 * - 同会话（同 started_at）重复调用 → 不重复记（按 started_at 去重）
 * - 新 supervisor 会话（started_at 变化）再 crash_loop → 再记 1 条
 * - crash_loop=false → 不记
 * - 无 supervisor.state → 不记
 * - supervisor 不在运行（陈旧 state 文件）→ 不记
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate035 } from "../src/migrations/035-notifications";
import { _setDbForTest } from "../src/core/db";
import { listNotifications } from "../src/core/notify/stream";
import { checkSupervisorCrashLoop } from "../src/daemon/notification-recorder";
import { writeSupervisorState, writeSupervisorPid, removeSupervisorPid, type SupervisorState } from "../src/daemon/pid";

let tmpDir: string;
let prevHome: string | undefined;
let db: Database;

const state = (over: Partial<SupervisorState>): SupervisorState => ({
  supervisor_pid: 111,
  started_at: 1000,
  daemon_spawns: 5,
  restarts: 4,
  last_exit_code: 1,
  last_classification: "crash",
  last_crash_at: 2000,
  crash_loop: true,
  ...over,
});

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-crashloop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, "runtime"), { recursive: true });
  prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpDir;
  db = new Database(":memory:");
  migrate035(db);
  _setDbForTest(db);
  // 告警要求 supervisor 存活（陈旧 state 文件不该记假通知）：
  // 用当前测试进程的 pid 冒充活着的 supervisor
  writeSupervisorPid();
});

afterEach(() => {
  _setDbForTest(null);
  db.close();
  if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prevHome;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

const crashLoopNotifs = () =>
  listNotifications({ limit: 50 }).items.filter((n) => n.type === "supervisor_crash_loop");

describe("checkSupervisorCrashLoop", () => {
  it("crash_loop=true 记 1 条告警", () => {
    writeSupervisorState(state({ crash_loop: true }));
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(1);
  });

  it("同会话重复调用不重复记（去重）", () => {
    writeSupervisorState(state({ started_at: 1000, crash_loop: true }));
    checkSupervisorCrashLoop();
    checkSupervisorCrashLoop();
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(1);
  });

  it("新会话（started_at 变化）再记 1 条", () => {
    writeSupervisorState(state({ started_at: 1000, crash_loop: true }));
    checkSupervisorCrashLoop();
    writeSupervisorState(state({ started_at: 9999, crash_loop: true }));
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(2);
  });

  it("crash_loop=false 不记", () => {
    writeSupervisorState(state({ crash_loop: false }));
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(0);
  });

  it("无 supervisor.state 不记", () => {
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(0);
  });

  it("supervisor 不在运行（陈旧 state 文件）不记", () => {
    // SIGKILL / 断电后 state 文件残留：裸 daemon run 读到 crash_loop=true，
    // 但 supervisor 已死，不该记「正在崩溃循环」的假通知
    removeSupervisorPid();
    writeSupervisorState(state({ crash_loop: true }));
    checkSupervisorCrashLoop();
    expect(crashLoopNotifs().length).toBe(0);
  });
});
