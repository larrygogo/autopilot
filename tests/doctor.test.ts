import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runChecks } from "../src/core/doctor";
import { _setDbForTest } from "../src/core/db";

let tmpFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpFile = join(tmpDir, "config.yaml");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
  // 防止 getConfigPath fallback 读到开发者真实的 ~/.autopilot/config.yaml
  process.env.AUTOPILOT_HOME = tmpDir;
  _setDbForTest(new Database(":memory:"));
});
afterEach(() => {
  _setDbForTest(null);
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

describe("L1 C3-C7", () => {
  it("C4 没有 enabled provider → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: false\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("C4 enabled 但无 default_model → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("C5 agent 引用未启用 provider → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n  openai:\n    enabled: false\nagents:\n  coder:\n    provider: openai\n", "utf-8");
    const report = await runChecks({ level: 1 });
    const c5 = report.checks.find((c) => c.id === "agents.coder.provider-bound");
    expect(c5?.status).toBe("error");
    expect(c5?.fix?.auto).toBe("fix.agent.unbind-disabled-provider");
  });

  it("C6 无 agent → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "agents.has-any")?.status).toBe("error");
  });

  it("全部合规 → ok", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 1 });
    // 注：beforeEach 注入了 in-memory DB，C7 (projects.has-any) 查询会抛错被 catch 吞掉
    // 不产生 check，所以这里可以安全地断言 status === "ok"
    expect(report.checks.find((c) => c.id === "config.exists")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "config.parses")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "agents.coder.provider-bound")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "agents.has-any")?.status).toBe("ok");
    expect(report.status).toBe("ok");
  });
});
