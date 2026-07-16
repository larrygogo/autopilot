/**
 * `autopilot service` 纯生成器测试。
 *
 * 平台 install/uninstall 会 spawn 真 OS 命令（systemctl/launchctl/schtasks），太重不宜单测；
 * 这里覆盖三平台服务描述文件的**纯生成逻辑** + 命令解析 + 引号处理（含空格路径是主要坑）：
 * - resolveServiceExec：编译 / dev 两模式托管命令（复用 daemonSpawnPlan，且必带 --supervise）
 * - systemdUnitContent：ExecStart 引号、Restart、AUTOPILOT_HOME 注入
 * - launchdPlistContent：ProgramArguments 逐个 <string>、RunAtLoad/KeepAlive、XML 转义
 * - windowsRunCommand：HKCU Run 键命令值，exe 路径必带内嵌双引号（Program Files 含空格）
 */

import { describe, it, expect } from "bun:test";
import {
  shQuote,
  resolveServiceExec,
  systemdUnitContent,
  launchdPlistContent,
  windowsRunCommand,
  LAUNCHD_LABEL,
} from "../src/cli/service";

describe("shQuote", () => {
  it("无空格无引号不加引号", () => {
    expect(shQuote("daemon")).toBe("daemon");
    expect(shQuote("--supervise")).toBe("--supervise");
  });
  it("含空格加双引号", () => {
    expect(shQuote("/opt/Program Files/autopilot")).toBe('"/opt/Program Files/autopilot"');
  });
  it("含引号转义并包裹", () => {
    expect(shQuote('a"b')).toBe('"a\\"b"');
  });
});

describe("resolveServiceExec", () => {
  it("编译模式：<exe> daemon run --supervise", () => {
    const { cmd, args } = resolveServiceExec({
      standalone: true,
      execPath: "/usr/local/bin/autopilot",
      scriptDir: "/whatever",
    });
    expect(cmd).toBe("/usr/local/bin/autopilot");
    expect(args).toEqual(["daemon", "run", "--supervise"]);
  });
  it("dev 模式：bun run supervisor.ts", () => {
    const { cmd, args } = resolveServiceExec({
      standalone: false,
      execPath: "/home/u/.bun/bin/bun",
      scriptDir: "/repo/src/cli",
    });
    expect(cmd).toBe("bun");
    expect(args[0]).toBe("run");
    expect(args[1]).toContain("supervisor.ts");
  });
  it("两模式都必带 supervisor（编译走 flag、dev 走 supervisor.ts）", () => {
    const compiled = resolveServiceExec({ standalone: true, execPath: "/x/autopilot", scriptDir: "/y" });
    expect(compiled.args).toContain("--supervise");
    const dev = resolveServiceExec({ standalone: false, execPath: "/x/bun", scriptDir: "/y/src/cli" });
    expect(dev.args.some((a) => a.includes("supervisor.ts"))).toBe(true);
  });
});

describe("systemdUnitContent", () => {
  it("ExecStart 用命令行 + 关键字段齐全", () => {
    const unit = systemdUnitContent({ cmd: "/usr/local/bin/autopilot", args: ["daemon", "run", "--supervise"] });
    expect(unit).toContain("ExecStart=/usr/local/bin/autopilot daemon run --supervise");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
  it("含空格 exe 路径在 ExecStart 里被引号包裹", () => {
    const unit = systemdUnitContent({ cmd: "/opt/App Dir/autopilot", args: ["daemon", "run", "--supervise"] });
    expect(unit).toContain('ExecStart="/opt/App Dir/autopilot" daemon run --supervise');
  });
  it("传 autopilotHome 注入 Environment 行；不传则无", () => {
    const withHome = systemdUnitContent({ cmd: "/x/autopilot", args: [], autopilotHome: "/data/.autopilot" });
    expect(withHome).toContain("Environment=AUTOPILOT_HOME=/data/.autopilot");
    const noHome = systemdUnitContent({ cmd: "/x/autopilot", args: [] });
    expect(noHome).not.toContain("Environment=AUTOPILOT_HOME");
  });
});

describe("launchdPlistContent", () => {
  const base = { label: LAUNCHD_LABEL, cmd: "/usr/local/bin/autopilot", args: ["daemon", "run", "--supervise"], logDir: "/home/u/.autopilot/runtime/logs" };
  it("ProgramArguments 逐个 <string> 且顺序为 cmd, ...args", () => {
    const plist = launchdPlistContent(base);
    expect(plist).toContain("<string>/usr/local/bin/autopilot</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>--supervise</string>");
    // cmd 在 args 之前
    expect(plist.indexOf("/usr/local/bin/autopilot")).toBeLessThan(plist.indexOf("<string>daemon</string>"));
  });
  it("RunAtLoad / KeepAlive 开启，Label 正确", () => {
    const plist = launchdPlistContent(base);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });
  it("XML 特殊字符被转义", () => {
    const plist = launchdPlistContent({ ...base, cmd: "/x/a&b<c>" });
    expect(plist).toContain("<string>/x/a&amp;b&lt;c&gt;</string>");
  });
  it("autopilotHome 注入 EnvironmentVariables", () => {
    const plist = launchdPlistContent({ ...base, autopilotHome: "/data/.autopilot" });
    expect(plist).toContain("<key>AUTOPILOT_HOME</key>");
    expect(plist).toContain("<string>/data/.autopilot</string>");
  });
});

describe("windowsRunCommand", () => {
  it("exe 路径必带内嵌双引号，args 空格拼接（与系统内既有 Run 项同款格式）", () => {
    const v = windowsRunCommand({ cmd: "C:\\Program Files\\autopilot\\autopilot.exe", args: ["daemon", "run", "--supervise"] });
    expect(v).toBe('"C:\\Program Files\\autopilot\\autopilot.exe" daemon run --supervise');
  });
});
