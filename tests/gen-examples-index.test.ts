import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EXAMPLE_TEMPLATES, EXAMPLE_TS_ONLY } from "../src/generated/_examples";
import { classifyExamples } from "../scripts/gen-examples-index";

test("dev 与 ad-hoc 模板在常量里、doc 有 phases", () => {
  const names = EXAMPLE_TEMPLATES.map((t) => t.name);
  expect(names).toContain("dev");
  expect(names).toContain("ad-hoc");
  const dev = EXAMPLE_TEMPLATES.find((t) => t.name === "dev")!;
  expect(Array.isArray(dev.doc.phases)).toBe(true);
  expect(dev.revision).toBeGreaterThanOrEqual(0);
});

test("当前无含 ts 模板", () => { expect(EXAMPLE_TS_ONLY).toEqual([]); });

test("classifyExamples：含 workflow.ts 的目录归入 tsOnly、只含 workflow.json 的归入 templates", () => {
  const tmpRoot = join(tmpdir(), `gen-examples-classify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tsDir = join(tmpRoot, "ts_only_fixture");
  const jsonDir = join(tmpRoot, "json_only_fixture");
  try {
    mkdirSync(tsDir, { recursive: true });
    mkdirSync(jsonDir, { recursive: true });

    // ts_only_fixture: 含 workflow.ts（可额外附带 workflow.json，ts 优先）
    writeFileSync(join(tsDir, "workflow.ts"), "export function run_a() {}\n");

    // json_only_fixture: 只含 workflow.json
    writeFileSync(join(jsonDir, "workflow.json"), JSON.stringify({
      name: "json_only_fixture",
      template_revision: 5,
      description: "仅 json",
      phases: [],
    }));

    const { templates, tsOnly } = classifyExamples(tmpRoot);

    expect(tsOnly).toContain("ts_only_fixture");
    expect(tsOnly).not.toContain("json_only_fixture");

    const found = templates.find((t) => t.name === "json_only_fixture");
    expect(found).toBeDefined();
    expect(found!.revision).toBe(5);
    expect(templates.map((t) => t.name)).not.toContain("ts_only_fixture");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
