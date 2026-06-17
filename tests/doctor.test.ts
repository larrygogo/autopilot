import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runChecks } from "../src/core/doctor";
import { _setDbForTest, getDb } from "../src/core/db";
import { up as m041 } from "../src/migrations/041-api-keys";
import { up as m047 } from "../src/migrations/047-providers-table";
import { getProviderByName, setProviderCliStatus } from "../src/core/providers";

let tmpFile: string;
let tmpDir: string;

/** 让当前测试 DB 有一个「可用」provider（doctor has-enabled 以可用性为准，读条目表的 cli_status）：
 *  seed 三家条目 + 把 anthropic cli_status 设 ok。 */
function seedUsableProvider(): void {
  const db = getDb();
  m041(db);
  m047(db);
  setProviderCliStatus(getProviderByName("anthropic")!.id, "ok");
}

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

  it("无 provider 条目 → error（P1：系统必须有一个可用供应商）", async () => {
    // 条目化 + 可用性重构后：零 provider → 明确 error（澄清/入队/起任务会被拒）+ 引导。
    writeFileSync(tmpFile, "agents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("error");
    expect(c?.fix?.url).toBe("/settings/providers");
  });

  it("有 seed 条目但都未就绪（无 cli_status / 无 key）→ error", async () => {
    writeFileSync(tmpFile, "\n", "utf-8");
    m041(getDb());
    m047(getDb()); // seed 三家但不设 cli_status → 都不可用
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("error");
    expect(c?.title).toContain("没有一个可用");
  });

  it("有可用 provider（cli 已就绪）→ ok", async () => {
    writeFileSync(tmpFile, "\n", "utf-8");
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("ok");
    expect(c?.title).toContain("可用");
  });

  it("用户显式写 providers: {} 空对象 → error（明确没启用）", async () => {
    // 跟"零配置"不同：用户显式写了 providers 段但为空，是明确"我没启用"。
    // 保留 error 提示去 /setup 配置。
    writeFileSync(tmpFile, "providers: {}\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("C4 enabled 但无 default_model → error", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\nagents: {}\n", "utf-8");
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("error");
  });

  it("命名复用 agent 移除后：config.yaml 的 agents 段不再产生健康检查", async () => {
    // Phase 3：删除命名 agent 机制。即便用户在 agents 段引用了未启用 provider，
    // doctor 也不再对其报错（该段已不被框架读取）。
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n  openai:\n    enabled: false\nagents:\n  coder:\n    provider: openai\n", "utf-8");
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id.startsWith("agents."))).toBeUndefined();
    // provider 校验仍正常
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
  });

  it("全部合规 → ok", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n", "utf-8");
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    // 注：beforeEach 注入了 in-memory DB，C7 (projects.has-any) 查询会抛错被 catch 吞掉
    // 不产生 check，所以这里可以安全地断言 status === "ok"
    expect(report.checks.find((c) => c.id === "config.exists")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "config.parses")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
    // 命名 agent 健康检查已移除
    expect(report.checks.find((c) => c.id.startsWith("agents."))).toBeUndefined();
    expect(report.status).toBe("ok");
  });
});

describe("L2 provider CLI 探测", () => {
  it("L2 包含 L1 全部检查", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 2 });
    expect(report.level).toBe(2);
    expect(report.checks.find((c) => c.id === "config.exists")).toBeDefined();
  });

  it("L2 探测全部三家内置 CLI（条目化后无「config 显式 enabled 子集」概念）", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\n", "utf-8");
    const report = await runChecks({ level: 2 });
    expect(report.checks.find((c) => c.id === "providers.openai.cli")).toBeDefined();
    expect(report.checks.find((c) => c.id === "providers.anthropic.cli")).toBeDefined();
    expect(report.checks.find((c) => c.id === "providers.google.cli")).toBeDefined();
  });
});

describe("L3 凭证 ping", () => {
  it("L3 模式 level 字段为 3", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    seedUsableProvider(); // 限定 L3 ping 范围为可用的 anthropic（否则按全三家 ping，易超时）
    const report = await runChecks({ level: 3 });
    expect(report.level).toBe(3);
  }, 15000);

  it("providers 空数组 → 不跑任何 L3 ping", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 3, providers: [] });
    expect(report.checks.find((c) => c.id === "providers.anthropic.ping")).toBeUndefined();
  });
});

describe("报告契约", () => {
  it("DoctorReport JSON.stringify 安全", async () => {
    writeFileSync(tmpFile, "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n", "utf-8");
    const report = await runChecks({ level: 1 });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.status).toBe(report.status);
    expect(parsed.checks.length).toBe(report.checks.length);
  });

  it("所有 fix.auto 在 FixId 白名单内", async () => {
    rmSync(tmpFile, { force: true });
    const r1 = await runChecks({ level: 1 });
    writeFileSync(tmpFile, "providers: {}\nagents: {}\n", "utf-8");
    const r2 = await runChecks({ level: 1 });
    const allFix = [...r1.checks, ...r2.checks].map((c) => c.fix?.auto).filter(Boolean);
    const allowed = ["init.providers", "fix.config.create"];
    for (const id of allFix) expect(allowed).toContain(id!);
  });
});
