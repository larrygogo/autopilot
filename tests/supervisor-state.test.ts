/**
 * supervisor 运行状态（重启次数 / 崩因）磁盘投影的读写往返测试。
 *
 * supervisor 内存态经 writeSupervisorState 落 runtime/supervisor.state.json，
 * `daemon status` 用 readSupervisorState 读出。这里覆盖 tmpdir 隔离下的：
 * - 写入后读回字段一致
 * - 未安装时读返回 null（不抛）
 * - remove 后读返回 null
 * - 损坏/半截文件读返回 null（不抛）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  writeSupervisorState,
  readSupervisorState,
  removeSupervisorState,
  type SupervisorState,
} from "../src/daemon/pid";

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-supstate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, "runtime"), { recursive: true });
  prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
  else process.env.AUTOPILOT_HOME = prevHome;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

const sample: SupervisorState = {
  supervisor_pid: 4242,
  started_at: 1_700_000_000_000,
  daemon_spawns: 3,
  restarts: 2,
  last_exit_code: 1,
  last_classification: "crash",
  last_crash_at: 1_700_000_100_000,
  crash_loop: true,
};

describe("supervisor state 磁盘投影", () => {
  it("写入后读回字段一致", () => {
    writeSupervisorState(sample);
    const got = readSupervisorState();
    expect(got).toEqual(sample);
  });

  it("未写入时读返回 null（不抛）", () => {
    expect(readSupervisorState()).toBeNull();
  });

  it("remove 后读返回 null", () => {
    writeSupervisorState(sample);
    expect(readSupervisorState()).not.toBeNull();
    removeSupervisorState();
    expect(readSupervisorState()).toBeNull();
  });

  it("损坏文件读返回 null（不抛）", () => {
    writeFileSync(join(tmpDir, "runtime", "supervisor.state.json"), "{ 半截", "utf-8");
    expect(readSupervisorState()).toBeNull();
  });

  it("缺关键字段的文件读返回 null", () => {
    writeFileSync(join(tmpDir, "runtime", "supervisor.state.json"), JSON.stringify({ foo: 1 }), "utf-8");
    expect(readSupervisorState()).toBeNull();
  });
});
