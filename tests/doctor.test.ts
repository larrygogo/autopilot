import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runChecks } from "../src/core/doctor";

let tmpFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpFile = join(tmpDir, "config.yaml");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
  // 防止 getConfigPath fallback 读到开发者真实的 ~/.autopilot/config.yaml
  process.env.AUTOPILOT_HOME = tmpDir;
});
afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor.runChecks 基础契约", () => {
  it("返回结构完整", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n");
    const report = await runChecks({ level: 1 });
    expect(report.level).toBe(1);
    expect(["ok", "warning", "error"]).toContain(report.status);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(typeof report.durationMs).toBe("number");
    expect(typeof report.generatedAt).toBe("string");
  });
});

describe("L1 C1/C2", () => {
  // 注：beforeEach 同时设了 DEV_WORKFLOW_CONFIG 与 AUTOPILOT_HOME 指向 tmpDir，
  // 确保 `getConfigPath()` 在 DEV_WORKFLOW_CONFIG 文件不存在时 fallback 到的 AUTOPILOT_HOME 也在隔离目录内。

  it("yaml 不存在 → status=error", async () => {
    rmSync(tmpFile, { force: true });
    const report = await runChecks({ level: 1 });
    expect(report.status).toBe("error");
    const c1 = report.checks.find((c) => c.id === "config.exists");
    expect(c1?.status).toBe("error");
    expect(c1?.fix?.cli).toContain("init");
  });

  it("yaml 损坏 → C2 报 error 并 stop", async () => {
    writeFileSync(tmpFile, "providers: [this is invalid: {{", "utf-8");
    const report = await runChecks({ level: 1 });
    const c2 = report.checks.find((c) => c.id === "config.parses");
    expect(c2?.status).toBe("error");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")).toBeUndefined();
  });

  it("yaml 存在且合法 → C1 ok + C2 ok", async () => {
    writeFileSync(tmpFile, "providers: {}\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "config.exists")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "config.parses")?.status).toBe("ok");
  });
});
