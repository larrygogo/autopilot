/**
 * native 内置模板的「拉 repo 最新 fix」机制（file 覆盖语义对 DB 工作流失效后的替身）：
 * reseedTemplateWorkflow / templateRevisionStatus / listOutdatedWorkflowCopies 对 DB native 行的
 * template_revision 比对与刷新。examples dev/ad-hoc 是真实模板（revision 动态读，不写死）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { createTemplateDbWorkflow, getWorkflowFromDb } from "../src/core/workflow/workflows";
import {
  reseedTemplateWorkflow,
  templateRevisionStatus,
  listOutdatedWorkflowCopies,
  parseSpecRevision,
} from "../src/core/workflow/templates";

describe("native 模板 reseed（拉 repo fix）", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let db: Database;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `autopilot-reseed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  /** 造一个 revision 落后的 native dev 行（spec_json.template_revision=1，低于 examples）。 */
  function seedStaleNativeDev(): void {
    const oldSpec = JSON.stringify({ name: "dev", template_revision: 1, phases: [{ name: "x", timeout: 60 }] });
    createTemplateDbWorkflow({ name: "dev", description: "旧版", spec_json: oldSpec });
  }

  it("templateRevisionStatus：DB native 落后 → {local:1, template:>1}", () => {
    seedStaleNativeDev();
    const status = templateRevisionStatus("dev")!;
    expect(status).not.toBeNull();
    expect(status.local).toBe(1);
    expect(status.template).toBeGreaterThan(status.local);
  });

  it("reseed：examples 更新 → 覆盖 DB 行到最新 revision + 拉来真实 phases", () => {
    seedStaleNativeDev();
    const before = templateRevisionStatus("dev")!;

    const r = reseedTemplateWorkflow("dev");
    expect(r).toBe("reseeded");

    const row = getWorkflowFromDb("dev")!;
    expect(parseSpecRevision(row.spec_json!)).toBe(before.template); // revision 已刷到 examples 版
    const spec = JSON.parse(row.spec_json!) as { phases: Array<{ name?: string; deliver?: string }> };
    // 拉来的是真实 dev（含 design/submit_pr 的 deliver:pr 阶段），不是占位 "x"。
    // 注：delivers 不再存 spec_json——从 deliver:pr 阶段运行时派生，故断言派生源。
    expect(spec.phases.some((p) => p.name === "submit_pr" && p.deliver === "pr")).toBe(true);
  });

  it("reseed 幂等：已是最新 → up-to-date，不再改", () => {
    seedStaleNativeDev();
    expect(reseedTemplateWorkflow("dev")).toBe("reseeded");
    expect(reseedTemplateWorkflow("dev")).toBe("up-to-date");
  });

  it("reseed：本地 revision 高于 examples（用户手设）→ up-to-date 不降级", () => {
    const aheadSpec = JSON.stringify({ name: "dev", template_revision: 9999, phases: [{ name: "x", timeout: 60 }] });
    createTemplateDbWorkflow({ name: "dev", description: "超前", spec_json: aheadSpec });
    expect(reseedTemplateWorkflow("dev")).toBe("up-to-date");
  });

  it("非 DB 模板（file 行）→ not-template（仍走文件 sync 路径）", () => {
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, file_path, created_at, updated_at) VALUES ('dev', '', 'name: dev\\nphases:\\n  - name: x\\n', NULL, 'file', 'file', NULL, '/tmp/dev', 1, 1)",
    );
    expect(reseedTemplateWorkflow("dev")).toBe("not-template");
    expect(templateRevisionStatus("dev")).toBeNull();
  });

  it("listOutdatedWorkflowCopies：检出落后的 DB native 行（无磁盘副本）", () => {
    seedStaleNativeDev();
    const outdated = listOutdatedWorkflowCopies();
    const dev = outdated.find((o) => o.name === "dev");
    expect(dev).toBeDefined();
    expect(dev!.local).toBe(1);
    expect(dev!.template).toBeGreaterThan(1);
  });
});
