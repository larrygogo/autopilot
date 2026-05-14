import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { handleRequest } from "../src/daemon/routes";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-setup-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(
    join(tmpHome, "config.yaml"),
    "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n",
    "utf-8",
  );
  // 注入 in-memory DB 并跑迁移，确保 kv 表存在
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("GET /api/setup/status", () => {
  it("返回 DoctorReport（level=1）+ setupDismissed", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.level).toBe(1);
    // status 可能是 "warning"（C7 projects 表空）或 "ok"，但不该是 error
    expect(body.status).not.toBe("error");
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.setupDismissed).toBe(false);
  });
});

describe("POST /api/setup/*", () => {
  it("POST /providers 写入 + 返回最新 report", async () => {
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\nagents: {}\n", "utf-8");
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/setup/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providers: { anthropic: { enabled: true, default_model: "claude-sonnet-4-6" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.checks.find((c: { id: string }) => c.id === "providers.has-enabled")?.status).toBe("ok");
  });

  it("POST /agents 写入", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/setup/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agents: { coder: { provider: "anthropic", model: "x", max_turns: 10, permission_mode: "auto" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("POST /codebases 自动建 default project + 写 codebase", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/setup/codebases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "my-project", path: tmpHome }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.codebase.alias).toBe("my-project");
    expect(body.codebase.path).toBe(tmpHome);
    expect(body.codebase.project_id).toBeTruthy();
  });

  it("POST /dismiss 标记 dismiss", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/setup/dismiss", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const status = await handleRequest(new Request("http://127.0.0.1:6180/api/setup/status"));
    const body = await status.json();
    expect(body.setupDismissed).toBe(true);
  });

  it("非法 body → 400", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/setup/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers: "not an object" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
