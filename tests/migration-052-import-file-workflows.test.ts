// 迁移 052：存量目录工作流救进 DB（file 轨退役 Step A3）
// - 纯 yaml → native DB 行 + afterCommit 备份并删目录
// - 含 workflow.ts → 跳过告警、目录原样保留
// - DB 已有同名 → 跳过、目录保留
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { up as migrate052 } from "../src/migrations/052-import-file-workflows";
import { _setDbForTest } from "../src/core/db";
import { getWorkflowFromDb, createNativeDbWorkflow } from "../src/core/workflow/workflows";

describe("migration 052: import file workflows", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let db: Database;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `autopilot-m052-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows"), { recursive: true });
    prevHome = process.env.AUTOPILOT_HOME;
    process.env.AUTOPILOT_HOME = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    migrate048(db);
    _setDbForTest(db);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    _setDbForTest(null);
    db.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeDirWorkflow(name: string, yaml: string, ts = ""): string {
    const dir = join(tmpHome, "workflows", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    if (ts) writeFileSync(join(dir, "workflow.ts"), ts);
    return dir;
  }

  it("纯 yaml 目录 → 转 native DB 行；afterCommit 备份并删目录", () => {
    const dir = writeDirWorkflow("my_wf", "name: my_wf\ndescription: d\nphases:\n  - name: a\n    prompt: x\n");
    const afterCommit = migrate052(db);

    const row = getWorkflowFromDb("my_wf");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("native");
    expect(existsSync(dir)).toBe(true); // 事务内不动 fs

    afterCommit();
    expect(existsSync(dir)).toBe(false); // 已删
    expect(existsSync(join(tmpHome, "workflows", "_migrated-052", "my_wf", "workflow.yaml"))).toBe(true); // 已备份
  });

  it("含 workflow.ts 目录 → 跳过不进 DB、目录原样保留", () => {
    const dir = writeDirWorkflow("ts_wf", "name: ts_wf\nphases:\n  - name: a\n    prompt: x\n", "export function run_a() {}\n");
    const afterCommit = migrate052(db);
    afterCommit();

    expect(getWorkflowFromDb("ts_wf")).toBeNull();
    expect(existsSync(join(dir, "workflow.ts"))).toBe(true); // 原样保留
  });

  it("DB 已有同名 → 跳过、目录保留（防重）", () => {
    createNativeDbWorkflow({ name: "dup_wf", description: "已在库", spec_json: JSON.stringify({ name: "dup_wf", phases: [{ name: "z", prompt: "y" }] }) });
    const dir = writeDirWorkflow("dup_wf", "name: dup_wf\nphases:\n  - name: a\n    prompt: x\n");
    const afterCommit = migrate052(db);
    afterCommit();

    const row = getWorkflowFromDb("dup_wf")!;
    expect(row.description).toBe("已在库"); // 未被目录版本覆盖
    expect(existsSync(dir)).toBe(true); // 目录保留
  });

  it("幂等：重跑扫描落空 no-op", () => {
    writeDirWorkflow("once_wf", "name: once_wf\nphases:\n  - name: a\n    prompt: x\n");
    migrate052(db)();
    expect(getWorkflowFromDb("once_wf")).not.toBeNull();
    // 第二次：目录已搬走，什么都不发生、不抛错
    migrate052(db)();
    expect(getWorkflowFromDb("once_wf")).not.toBeNull();
  });
});
