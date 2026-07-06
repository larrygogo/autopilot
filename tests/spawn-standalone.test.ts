import { test, expect, describe } from "bun:test";
import { daemonSpawnPlan } from "../src/cli/spawn-plan";

describe("daemonSpawnPlan — 编译单文件模式", () => {
  test("standalone=true, supervise=false → execPath + daemon run", () => {
    const p = daemonSpawnPlan({
      standalone: true,
      supervise: false,
      execPath: "C:/Program Files/autopilot/autopilot.exe",
      scriptDir: "/virtual/cli",
    });
    expect(p.cmd).toBe("C:/Program Files/autopilot/autopilot.exe");
    expect(p.args).toEqual(["daemon", "run"]);
  });

  test("standalone=true, supervise=true → execPath + daemon run --supervise", () => {
    const p = daemonSpawnPlan({
      standalone: true,
      supervise: true,
      execPath: "C:/Program Files/autopilot/autopilot.exe",
      scriptDir: "/virtual/cli",
    });
    expect(p.cmd).toBe("C:/Program Files/autopilot/autopilot.exe");
    expect(p.args).toEqual(["daemon", "run", "--supervise"]);
  });

  test("standalone=true, port 附加", () => {
    const p = daemonSpawnPlan({
      standalone: true,
      supervise: false,
      execPath: "/usr/local/bin/autopilot",
      scriptDir: "/virtual/cli",
      port: 6180,
    });
    expect(p.cmd).toBe("/usr/local/bin/autopilot");
    expect(p.args).toEqual(["daemon", "run", "--port", "6180"]);
  });

  test("standalone=true, supervise=true, port+host 附加", () => {
    const p = daemonSpawnPlan({
      standalone: true,
      supervise: true,
      execPath: "/usr/local/bin/autopilot",
      scriptDir: "/virtual/cli",
      port: 16180,
      host: "0.0.0.0",
    });
    expect(p.cmd).toBe("/usr/local/bin/autopilot");
    expect(p.args).toEqual(["daemon", "run", "--supervise", "--port", "16180", "--host", "0.0.0.0"]);
  });
});

describe("daemonSpawnPlan — dev 模式", () => {
  test("standalone=false, supervise=false → bun run daemon/index.ts", () => {
    const p = daemonSpawnPlan({
      standalone: false,
      supervise: false,
      execPath: "bun",
      scriptDir: "/x/src/cli",
    });
    expect(p.cmd).toBe("bun");
    expect(p.args[0]).toBe("run");
    expect(p.args[1]).toContain("daemon/index.ts");
  });

  test("standalone=false, supervise=true → bun run daemon/supervisor.ts", () => {
    const p = daemonSpawnPlan({
      standalone: false,
      supervise: true,
      execPath: "bun",
      scriptDir: "/x/src/cli",
    });
    expect(p.cmd).toBe("bun");
    expect(p.args[0]).toBe("run");
    expect(p.args[1]).toContain("daemon/supervisor.ts");
  });

  test("standalone=false, port+host 附加", () => {
    const p = daemonSpawnPlan({
      standalone: false,
      supervise: false,
      execPath: "bun",
      scriptDir: "/x/src/cli",
      port: 16180,
      host: "127.0.0.1",
    });
    expect(p.cmd).toBe("bun");
    expect(p.args).toContain("--port");
    expect(p.args).toContain("16180");
    expect(p.args).toContain("--host");
    expect(p.args).toContain("127.0.0.1");
  });

  test("port 未提供时不附加 --port", () => {
    const p = daemonSpawnPlan({
      standalone: false,
      supervise: false,
      execPath: "bun",
      scriptDir: "/x/src/cli",
    });
    expect(p.args).not.toContain("--port");
    expect(p.args).not.toContain("--host");
  });
});
