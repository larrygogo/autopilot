import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { getProviderByName, setProviderCliStatus } from "../src/core/providers";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

let tmpHome: string;

/** 创建一个临时的 bare git 仓库，可被 git ls-remote 探测（与 routes-codebase-api 同款） */
function createBareRepo(): string {
  const dir = join(tmpdir(), `autopilot-setup-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "--bare", "-q", dir], { stdout: "pipe", stderr: "pipe" });
  const work = dir + "-work";
  mkdirSync(work, { recursive: true });
  const cmds: string[][] = [
    ["git", "-C", work, "init", "-q", "-b", "main"],
    ["git", "-C", work, "config", "user.email", "test@autopilot.local"],
    ["git", "-C", work, "config", "user.name", "Test"],
    ["git", "-C", work, "commit", "--allow-empty", "-q", "-m", "init"],
    ["git", "-C", work, "remote", "add", "origin", dir],
    ["git", "-C", work, "push", "-q", "origin", "main"],
  ];
  for (const cmd of cmds) Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  rmSync(work, { recursive: true, force: true });
  return dir;
}

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-setup-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.json");
  writeFileSync(
    join(tmpHome, "config.json"),
    "{}",
    "utf-8",
  );
  // 注入 in-memory DB 并跑迁移，确保 kv 表存在
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  // doctor has-enabled 以「可用性」为准（cli_status=ok / api key）：给 anthropic 设 ok 作可用基线，
  // 否则 seed 的条目 cli_status=null → 无可用 → has-enabled error，挡住 setup 流程用例。
  setProviderCliStatus(getProviderByName("anthropic")!.id, "ok");
  registerCoreRpcMethods();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("setup.status RPC", () => {
  it("返回 DoctorReport（level=1）+ setupDismissed", async () => {
    const r = await invokeRpcMethod("setup.status", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as {
        level: number;
        status: string;
        checks: unknown[];
        setupDismissed: boolean;
      };
      expect(body.level).toBe(1);
      // status 可能是 "warning"（C7 projects 表空）或 "ok"，但不该是 error
      expect(body.status).not.toBe("error");
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.setupDismissed).toBe(false);
    }
  });
});

describe("setup.save* RPC", () => {
  it("setup.saveProviders 写入 + 返回最新 report", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({providers: {}, agents: {}}, null, 2), "utf-8");
    const r = await invokeRpcMethod("setup.saveProviders", {
      providers: { anthropic: { enabled: true, default_model: "claude-sonnet-4-6" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { report: { checks: Array<{ id: string; status: string }> } };
      expect(body.report.checks.find((c) => c.id === "providers.has-enabled")?.status).toBe("ok");
    }
  });

  it("setup.saveAgents 已移除（Phase 3：命名复用 agent 机制删除）", async () => {
    const r = await invokeRpcMethod("setup.saveAgents", {
      agents: { coder: { provider: "anthropic", model: "x", max_turns: 10, permission_mode: "auto" } },
    });
    // 方法已注销 → 不再成功
    expect(r.ok).toBe(false);
  });

  it("setup.saveWorkspaces 自动建 default project + 写 workspace（remote_url 模式）", async () => {
    const bareRepo = createBareRepo();
    try {
      const r = await invokeRpcMethod("setup.saveWorkspaces", { name: "my-project", remote_url: bareRepo });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const body = r.payload as { workspace: { alias: string; remote_url: string | null; default_branch: string; project_id: string } };
        expect(body.workspace.alias).toBe("my-project");
        expect(body.workspace.remote_url).toBe(bareRepo);
        expect(body.workspace.default_branch).toBe("main");
        expect(body.workspace.project_id).toBeTruthy();
      }
    } finally {
      rmSync(bareRepo, { recursive: true, force: true });
    }
  });

  it("setup.saveWorkspaces 缺 remote_url → INVALID_PARAM（旧 path 签名已废弃）", async () => {
    const r = await invokeRpcMethod("setup.saveWorkspaces", { name: "my-project", path: tmpHome });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("setup.saveWorkspaces 远程不可达 → REMOTE_UNREACHABLE", async () => {
    const r = await invokeRpcMethod("setup.saveWorkspaces", {
      name: "my-project",
      remote_url: join(tmpdir(), `nonexistent-repo-${Date.now()}`),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REMOTE_UNREACHABLE");
  });

  it("setup.dismiss 标记 dismiss", async () => {
    const d = await invokeRpcMethod("setup.dismiss", {});
    expect(d.ok).toBe(true);
    const s = await invokeRpcMethod("setup.status", {});
    expect(s.ok).toBe(true);
    if (s.ok) {
      const body = s.payload as { setupDismissed: boolean };
      expect(body.setupDismissed).toBe(true);
    }
  });

  it("非法 body → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("setup.saveProviders", { providers: "not an object" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });
});
