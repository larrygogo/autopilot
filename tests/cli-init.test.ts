import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function runInit() {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), "init"],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

describe("init 写模板", () => {
  it("首次 init 后 config.json 存在（零配置模板）", () => {
    const r = runInit();
    expect(r.exitCode).toBe(0);
    const cfgPath = join(tmpHome, "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    // 零配置模板：空 JSON 对象（高级说明在 JSDoc 注释里，不在文件内容中）
    const content = readFileSync(cfgPath, "utf-8").trim();
    expect(content).toBe("{}"); // config.json 是纯空对象
  });

  it("二次 init 不覆盖已有 config.json", () => {
    runInit();
    const cfgPath = join(tmpHome, "config.json");
    // 写入合法 JSON（含自定义字段）
    writeFileSync(cfgPath, JSON.stringify({ providers: {}, agents: {}, "_my_marker": "my_edits" }, null, 2), "utf-8");
    runInit();
    expect(readFileSync(cfgPath, "utf-8")).toContain("my_edits");
  });

  it("init 输出包含三个下一步提示", () => {
    const r = runInit();
    expect(r.stdout).toContain("bun run dev config doctor");
    expect(r.stdout).toContain("--fix");
    expect(r.stdout).toContain("dashboard");
  });
});

describe("init 必跑全部 migrations（dogfood-bug19）", () => {
  it("init 后 schema_version 升到最新", () => {
    const r = runInit();
    expect(r.exitCode).toBe(0);
    const dbPath = join(tmpHome, "runtime", "workflow.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      // 必须有 schema_version 表（v1 baseline migration 创建）
      const versions = db
        .query("SELECT version FROM schema_version ORDER BY version")
        .all() as { version: number }[];
      // 至少包含 v1（baseline），后续每加一条迁移都会新增一行
      expect(versions.length).toBeGreaterThanOrEqual(1);
      expect(versions[0].version).toBe(1);
    } finally {
      db.close();
    }
  });

  it("init 后业务表全部存在（projects/workspaces/requirements/workflows）", () => {
    runInit();
    const db = new Database(join(tmpHome, "runtime", "workflow.db"), { readonly: true });
    try {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));
      // 这些表分散在不同迁移里，没全部跑就会缺
      for (const required of ["projects", "workspaces", "requirements", "workflows"]) {
        expect(names.has(required)).toBe(true);
      }
      // schedules 功能已移除，migration 035 会 DROP TABLE schedules
      expect(names.has("schedules")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("init 输出提示应用了 N 条迁移", () => {
    const r = runInit();
    expect(r.stdout).toMatch(/应用 \d+ 条迁移/);
  });

  it("二次 init 不重复跑迁移（幂等）", () => {
    runInit();
    const r2 = runInit();
    expect(r2.exitCode).toBe(0);
    // 第二次不应再有"应用 N 条迁移"提示
    expect(r2.stdout).not.toMatch(/应用 \d+ 条迁移/);
  });
});
