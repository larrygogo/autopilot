import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runChecks, hasTaskStartBlocker } from "../src/core/doctor";
import { _setDbForTest, getDb } from "../src/core/db";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m041 } from "../src/migrations/041-api-keys";
import { up as m047 } from "../src/migrations/047-providers-table";
import { up as m048 } from "../src/migrations/048-workflow-kind-spec-json";
import { getProviderByName, setProviderCliStatus } from "../src/core/providers";
import { createTemplateDbWorkflow } from "../src/core/workflow/workflows";

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
  tmpFile = join(tmpDir, "config.json");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
  // 防止 getConfigPath fallback 读到开发者真实的 ~/.autopilot/config.json
  process.env.AUTOPILOT_HOME = tmpDir;
  _setDbForTest(new Database(":memory:"));
});
afterEach(() => {
  _setDbForTest(null);
  delete process.env.DEV_WORKFLOW_CONFIG;
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// 将 JSON 对象写入临时配置文件
function writeConfig(obj: Record<string, unknown>): void {
  writeFileSync(tmpFile, JSON.stringify(obj, null, 2), "utf-8");
}

describe("doctor.runChecks 基础契约", () => {
  it("返回结构完整", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } }, agents: { coder: { provider: "anthropic" } } });
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

  it("json 不存在 → status=error", async () => {
    rmSync(tmpFile, { force: true });
    const report = await runChecks({ level: 1 });
    expect(report.status).toBe("error");
    const c1 = report.checks.find((c) => c.id === "config.exists");
    expect(c1?.status).toBe("error");
    expect(c1?.fix?.cli).toContain("init");
  });

  it("json 损坏 → C2 报 error 并 stop", async () => {
    writeFileSync(tmpFile, "this is not json {{", "utf-8");
    const report = await runChecks({ level: 1 });
    const c2 = report.checks.find((c) => c.id === "config.parses");
    expect(c2?.status).toBe("error");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")).toBeUndefined();
  });

  it("json 存在且合法 → C1 ok + C2 ok", async () => {
    writeConfig({ providers: {}, agents: {} });
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "config.exists")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "config.parses")?.status).toBe("ok");
  });
});

describe("L1 C3-C7", () => {
  it("C4 没有 enabled provider → warning（诊断不阻塞 exit，强制由 task-start 守卫承担）", async () => {
    writeConfig({ providers: { anthropic: { enabled: false } }, agents: {} });
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("warning");
  });

  it("无 provider 条目 → warning（onboarding 正常态，doctor 只引导不阻塞 exit）", async () => {
    writeConfig({ agents: {} });
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("warning");
    expect(c?.fix?.url).toBe("/settings/providers");
  });

  it("有 seed 条目但都未就绪（无 cli_status / 无 key）→ warning", async () => {
    writeConfig({});
    m041(getDb());
    m047(getDb()); // seed 三家但不设 cli_status → 都不可用
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("warning");
    expect(c?.title).toContain("没有一个可用");
  });

  it("有可用 provider（cli 已就绪）→ ok", async () => {
    writeConfig({});
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "providers.has-enabled");
    expect(c?.status).toBe("ok");
    expect(c?.title).toContain("可用");
  });

  it("用户显式写 providers: {} 空对象 → warning（明确没启用，仍只引导不阻塞）", async () => {
    writeConfig({ providers: {}, agents: {} });
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("warning");
  });

  it("C4 enabled 但无 default_model → warning", async () => {
    writeConfig({ providers: { anthropic: { enabled: true } }, agents: {} });
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("warning");
  });
});

describe("hasTaskStartBlocker（强制落在 task-start 守卫，而非 doctor 退出码）", () => {
  it("无可用 provider（doctor 仅 warning）→ 仍阻塞起任务", async () => {
    writeConfig({ agents: {} });
    const report = await runChecks({ level: 1 });
    expect(report.status).not.toBe("error"); // doctor 整体不是 error（不阻塞 exit）
    expect(hasTaskStartBlocker(report)).toBe(true); // 但起任务被拦
  });

  it("有可用 provider → 不阻塞起任务", async () => {
    writeConfig({});
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    expect(hasTaskStartBlocker(report)).toBe(false);
  });

  it("config.json 缺失（真 error）→ 阻塞起任务", async () => {
    rmSync(tmpFile, { force: true });
    const report = await runChecks({ level: 1 });
    expect(report.status).toBe("error");
    expect(hasTaskStartBlocker(report)).toBe(true);
  });

  it("命名复用 agent 移除后：config.json 的 agents 段不再产生健康检查", async () => {
    writeConfig({
      providers: { anthropic: { enabled: true, default_model: "x" }, openai: { enabled: false } },
      agents: { coder: { provider: "openai" } },
    });
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id.startsWith("agents."))).toBeUndefined();
    // provider 校验仍正常
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
  });

  it("全部合规 → ok", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } } });
    seedUsableProvider();
    const report = await runChecks({ level: 1 });
    expect(report.checks.find((c) => c.id === "config.exists")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "config.parses")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
    // 命名 agent 健康检查已移除
    expect(report.checks.find((c) => c.id.startsWith("agents."))).toBeUndefined();
    // upgrade.webdist 在开发者本地 web-dist 较旧时会产生 warning（升级提示，不影响合规性）；
    // 只验证核心检查项无 error，整体 status 排除 upgrade 类 warning 是 ok。
    const nonUpgradeChecks = report.checks.filter((c) => !c.id.startsWith("upgrade."));
    const nonUpgradeStatus = nonUpgradeChecks.some((c) => c.status === "error")
      ? "error"
      : nonUpgradeChecks.some((c) => c.status === "warning")
        ? "warning"
        : "ok";
    expect(nonUpgradeStatus).toBe("ok");
  });

  it("C8 工作流副本落后内置模板 → upgrade.workflows warning", async () => {
    writeConfig({});
    // 需要初始化 workflows 表（001+007+048）才能写 DB native 行
    const db = getDb();
    m001(db);
    m007(db);
    m048(db);
    seedUsableProvider();
    // 在 DB 种一个落后的 dev native 行（revision=1 < examples 的 r≥3）
    const staleSpec = JSON.stringify({ name: "dev", template_revision: 1, phases: [{ name: "a", timeout: 1 }] });
    createTemplateDbWorkflow({ name: "dev", description: "旧版", spec_json: staleSpec });
    const report = await runChecks({ level: 1 });
    const c = report.checks.find((c) => c.id === "upgrade.workflows");
    expect(c?.status).toBe("warning");
    expect(c?.title).toContain("dev");
  });
});

describe("L2 provider CLI 探测", () => {
  it("L2 包含 L1 全部检查", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } }, agents: { coder: { provider: "anthropic" } } });
    const report = await runChecks({ level: 2 });
    expect(report.level).toBe(2);
    expect(report.checks.find((c) => c.id === "config.exists")).toBeDefined();
  });

  it("L2 探测全部三家内置 CLI（条目化后无「config 显式 enabled 子集」概念）", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } } });
    const report = await runChecks({ level: 2 });
    expect(report.checks.find((c) => c.id === "providers.openai.cli")).toBeDefined();
    expect(report.checks.find((c) => c.id === "providers.anthropic.cli")).toBeDefined();
    expect(report.checks.find((c) => c.id === "providers.google.cli")).toBeDefined();
  });
});

describe("L3 凭证 ping", () => {
  it("L3 模式 level 字段为 3", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } }, agents: { coder: { provider: "anthropic" } } });
    seedUsableProvider(); // 限定 L3 ping 范围为可用的 anthropic（否则按全三家 ping，易超时）
    const report = await runChecks({ level: 3 });
    expect(report.level).toBe(3);
  }, 15000);

  it("providers 空数组 → 不跑任何 L3 ping", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } }, agents: { coder: { provider: "anthropic" } } });
    const report = await runChecks({ level: 3, providers: [] });
    expect(report.checks.find((c) => c.id === "providers.anthropic.ping")).toBeUndefined();
  });
});

describe("报告契约", () => {
  it("DoctorReport JSON.stringify 安全", async () => {
    writeConfig({ providers: { anthropic: { enabled: true, default_model: "x" } }, agents: { coder: { provider: "anthropic" } } });
    const report = await runChecks({ level: 1 });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.status).toBe(report.status);
    expect(parsed.checks.length).toBe(report.checks.length);
  });

  it("所有 fix.auto 在 FixId 白名单内", async () => {
    rmSync(tmpFile, { force: true });
    const r1 = await runChecks({ level: 1 });
    writeConfig({ providers: {}, agents: {} });
    const r2 = await runChecks({ level: 1 });
    const allFix = [...r1.checks, ...r2.checks].map((c) => c.fix?.auto).filter(Boolean);
    const allowed = ["init.providers", "fix.config.create"];
    for (const id of allFix) expect(allowed).toContain(id!);
  });
});
