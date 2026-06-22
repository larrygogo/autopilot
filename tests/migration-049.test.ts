/**
 * migration 049：把存量 file 形态的产品工作流 dev / ad-hoc 就地转成 native(template) DB 行，
 * 备份并删除家目录物理副本。覆盖：转换正确性、顺序铁律（转 db 后孤儿清理不误删）、
 * 白名单边界（dev-kimi 不碰）、新装无副本、幂等。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { up as migrate049 } from "../src/migrations/049-seed-native-products";
import { _setDbForTest } from "../src/core/db";
import { getWorkflowFromDb, syncFileWorkflowsToDb, createDbWorkflow } from "../src/core/workflow/workflows";
import { _clearRegistry, discover, getWorkflow } from "../src/core/workflow/registry";

describe("migration 049：file dev/ad-hoc → native", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let db: Database;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `autopilot-mig049-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    _clearRegistry();
    db.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 造一个 source=file 的工作流行 + 假家目录物理目录（模拟老用户装机形态）。 */
  function seedFileRow(name: string): string {
    const dir = join(tmpHome, "workflows", name);
    mkdirSync(dir, { recursive: true });
    const yaml = `name: ${name}\ndescription: 旧副本\nphases:\n  - name: x\n    timeout: 60\n`;
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, file_path, created_at, updated_at) VALUES (?, ?, ?, NULL, 'file', 'file', NULL, ?, ?, ?)",
      [name, "旧副本", yaml, dir, 1000, 1000],
    );
    return dir;
  }

  it("老用户场景：file dev 行就地转 native(template) + 物理目录删 + 备份", () => {
    const devDir = seedFileRow("dev");
    expect(getWorkflowFromDb("dev")!.source).toBe("file");

    migrate049(db);

    const row = getWorkflowFromDb("dev")!;
    expect(row.source).toBe("db");
    expect(row.kind).toBe("template");
    expect(row.spec_json).toBeTruthy();
    expect(row.file_path).toBeNull();
    // spec_json = examples 的最新版（声明式 deliver:pr、非旧 file 副本的 "x" 占位阶段）
    const spec = JSON.parse(row.spec_json!) as { phases: unknown[]; delivers?: string };
    expect(Array.isArray(spec.phases)).toBe(true);
    expect(spec.delivers).toBe("pr");
    // 物理目录已删 + 备份到 _migrated-049/
    expect(existsSync(devDir)).toBe(false);
    expect(existsSync(join(tmpHome, "workflows", "_migrated-049", "dev", "workflow.yaml"))).toBe(true);
  });

  it("ad-hoc 同样转 native（无 delivers 字段也不报错）", () => {
    seedFileRow("ad-hoc");
    migrate049(db);
    const row = getWorkflowFromDb("ad-hoc")!;
    expect(row.source).toBe("db");
    expect(row.kind).toBe("template");
    expect(JSON.parse(row.spec_json!).phases.length).toBeGreaterThan(0);
  });

  it("顺序铁律：转 native 后 discover 的孤儿清理不会误删（只删 source=file）", () => {
    seedFileRow("dev");
    migrate049(db);
    // 模拟 discover 的 file→db 同步：空磁盘扫描（dev 已无物理目录）。
    // deleteOrphanFileWorkflows 只删 source='file'；dev 已 source=db → 不受影响。
    syncFileWorkflowsToDb([]);
    expect(getWorkflowFromDb("dev")!.source).toBe("db");
  });

  it("白名单外的用户自建 file 工作流（dev-kimi）完全不碰", () => {
    seedFileRow("dev-kimi");
    migrate049(db);
    const row = getWorkflowFromDb("dev-kimi")!;
    expect(row.source).toBe("file");
    expect(row.kind).toBe("file");
    expect(existsSync(join(tmpHome, "workflows", "dev-kimi"))).toBe(true); // 物理目录保留
  });

  it("新装无副本场景：DB 无 dev 行 → 直接插 native(template)", () => {
    // 不 seedFileRow，DB 里没有 dev 行
    migrate049(db);
    const row = getWorkflowFromDb("dev")!;
    expect(row.source).toBe("db");
    expect(row.kind).toBe("template");
  });

  it("幂等：重跑不抛错、结果稳定", () => {
    seedFileRow("dev");
    migrate049(db);
    expect(() => migrate049(db)).not.toThrow();
    expect(getWorkflowFromDb("dev")!.kind).toBe("template");
  });

  it("回归：dev 有派生子（derived）→ 049 转 native 后 discover 仍能注册派生工作流", async () => {
    // 老用户：file dev 副本（磁盘目录 + DB file 行）+ 派生自 dev 的 derived 工作流
    // （workflow create my-dev-fast --derives-from dev 的官方引导路径）。
    seedFileRow("dev");
    createDbWorkflow({
      name: "my-dev-fast",
      description: "派生自 dev",
      derives_from: "dev",
      yaml_content: "name: my-dev-fast\nphases:\n  - name: design\n    timeout: 60\n",
    });

    // 049：dev 转 native + 删磁盘目录（base 从 file 形态变 native 形态）
    migrate049(db);
    expect(getWorkflowFromDb("dev")!.source).toBe("db");

    // discover：派生工作流必须仍能注册——两遍处理 + base 回退 native dev，不静默掉出注册表
    _clearRegistry();
    await discover();
    expect(getWorkflow("my-dev-fast")).not.toBeNull();
    expect(getWorkflow("dev")).not.toBeNull();
  });
});
