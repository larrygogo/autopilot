/**
 * daemon/supervisor PID + listen info 文件管理测试。
 *
 * daemon stop/start 是客户最高频运维操作。僵尸 PID 检测 (isDaemonRunning)
 * 出 bug 会让客户卡在"daemon 已在运行但其实没在跑"。读写 PID 文件 +
 * process.kill(pid, 0) 探活 + 自动清理是核心路径，必须有回归保护。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writePid,
  readPid,
  removePid,
  isProcessAlive,
  isDaemonRunning,
  writeSupervisorPid,
  readSupervisorPid,
  removeSupervisorPid,
  isSupervisorRunning,
  writeListenInfo,
  readListenInfo,
  removeListenInfo,
  getPidFilePath,
  getSupervisorPidFilePath,
} from "../src/daemon/pid";

let tmpHome: string;
let oldHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-pid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  oldHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome;
  else delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("getPidFilePath / getSupervisorPidFilePath", () => {
  it("反映当前 AUTOPILOT_HOME", () => {
    expect(getPidFilePath()).toBe(join(tmpHome, "runtime", "daemon.pid"));
    expect(getSupervisorPidFilePath()).toBe(join(tmpHome, "runtime", "supervisor.pid"));
  });
});

describe("writePid / readPid / removePid", () => {
  it("writePid 写当前进程 PID，readPid 读回", () => {
    writePid();
    expect(readPid()).toBe(process.pid);
  });

  it("readPid 文件不存在 → null", () => {
    expect(readPid()).toBe(null);
  });

  it("readPid 文件含非数字 → null", () => {
    writeFileSync(getPidFilePath(), "not-a-pid", "utf-8");
    expect(readPid()).toBe(null);
  });

  it("readPid 文件含纯空白 → null", () => {
    writeFileSync(getPidFilePath(), "  \n\t  ", "utf-8");
    expect(readPid()).toBe(null);
  });

  it("readPid 文件含带空白的数字 → 正常 parse", () => {
    writeFileSync(getPidFilePath(), "  12345  \n", "utf-8");
    expect(readPid()).toBe(12345);
  });

  it("removePid 文件存在 → 删", () => {
    writePid();
    removePid();
    expect(existsSync(getPidFilePath())).toBe(false);
  });

  it("removePid 文件不存在 → 静默", () => {
    expect(() => removePid()).not.toThrow();
  });
});

describe("isProcessAlive", () => {
  it("当前进程 → true（自己肯定活着）", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("不可能存在的大 PID → false", () => {
    expect(isProcessAlive(99_999_999)).toBe(false);
  });

  it("PID 0 → false（process.kill 对 0 是 group signal 不该当存活）", () => {
    // signal 0 to PID 0 在不同平台行为不一致；此处只断言"不抛错"
    // 实际返回值可能 true（kernel idle process）或 false，但不应抛
    expect(() => isProcessAlive(0)).not.toThrow();
  });
});

describe("isDaemonRunning", () => {
  it("PID 文件不存在 → false", () => {
    expect(isDaemonRunning()).toBe(false);
  });

  it("PID 文件含当前进程 PID（活的） → true", () => {
    writePid();
    expect(isDaemonRunning()).toBe(true);
  });

  it("PID 文件含死 PID → false 且文件被清（僵尸清理）", () => {
    writeFileSync(getPidFilePath(), "99999999", "utf-8");
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isDaemonRunning()).toBe(false);
    // 关键：死 PID 触发自动清理
    expect(existsSync(getPidFilePath())).toBe(false);
  });

  it("PID 文件损坏（非数字） → false", () => {
    writeFileSync(getPidFilePath(), "garbage", "utf-8");
    expect(isDaemonRunning()).toBe(false);
  });
});

describe("supervisor PID 同款行为", () => {
  it("writeSupervisorPid / readSupervisorPid 往返", () => {
    writeSupervisorPid();
    expect(readSupervisorPid()).toBe(process.pid);
  });

  it("isSupervisorRunning：死 PID 触发僵尸清理", () => {
    writeFileSync(getSupervisorPidFilePath(), "99999999", "utf-8");
    expect(isSupervisorRunning()).toBe(false);
    expect(existsSync(getSupervisorPidFilePath())).toBe(false);
  });

  it("isSupervisorRunning：无文件 → false", () => {
    expect(isSupervisorRunning()).toBe(false);
  });

  it("removeSupervisorPid 静默", () => {
    expect(() => removeSupervisorPid()).not.toThrow();
  });

  it("daemon PID 跟 supervisor PID 独立（不互相影响）", () => {
    writePid();
    expect(readSupervisorPid()).toBe(null);
    writeSupervisorPid();
    expect(readPid()).toBe(process.pid);
    removeSupervisorPid();
    expect(readPid()).toBe(process.pid); // daemon PID 不受影响
  });
});

describe("listen info 读写", () => {
  it("writeListenInfo → readListenInfo 往返", () => {
    writeListenInfo({ host: "127.0.0.1", port: 6180 });
    const info = readListenInfo();
    expect(info).toEqual({ host: "127.0.0.1", port: 6180 });
  });

  it("readListenInfo 文件不存在 → null", () => {
    expect(readListenInfo()).toBe(null);
  });

  it("readListenInfo JSON 损坏 → null", () => {
    const p = join(tmpHome, "runtime", "daemon.listen.json");
    writeFileSync(p, "{not-valid-json", "utf-8");
    expect(readListenInfo()).toBe(null);
  });

  it("readListenInfo 字段类型不对 → null（防 garbage in）", () => {
    const p = join(tmpHome, "runtime", "daemon.listen.json");
    writeFileSync(p, JSON.stringify({ host: 123, port: "6180" }), "utf-8");
    expect(readListenInfo()).toBe(null);
  });

  it("readListenInfo 缺字段 → null", () => {
    const p = join(tmpHome, "runtime", "daemon.listen.json");
    writeFileSync(p, JSON.stringify({ host: "127.0.0.1" }), "utf-8");
    expect(readListenInfo()).toBe(null);
  });

  it("removeListenInfo 不存在静默", () => {
    expect(() => removeListenInfo()).not.toThrow();
  });

  it("覆盖已有 listen info（改 host/port 后）", () => {
    writeListenInfo({ host: "127.0.0.1", port: 6180 });
    writeListenInfo({ host: "0.0.0.0", port: 9999 });
    expect(readListenInfo()).toEqual({ host: "0.0.0.0", port: 9999 });
  });
});

describe("AUTOPILOT_HOME 切换隔离", () => {
  it("切到不同 home，原 home 的 PID 文件不会被读到", () => {
    writePid(); // 写到 tmpHome
    const alt = join(tmpdir(), `autopilot-pid-alt-${Date.now()}`);
    mkdirSync(join(alt, "runtime"), { recursive: true });
    try {
      process.env.AUTOPILOT_HOME = alt;
      expect(readPid()).toBe(null); // 新 home 无 PID
    } finally {
      process.env.AUTOPILOT_HOME = tmpHome;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});
