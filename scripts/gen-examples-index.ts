#!/usr/bin/env bun
// scripts/gen-examples-index.ts
// 把 examples/workflows/*/workflow.json 烤成编译期内联 TS 常量。
// 有 workflow.ts 的目录归入 EXAMPLE_TS_ONLY（当前为空）。
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../examples/workflows");
const OUT_DIR = join(import.meta.dir, "../src/generated");
const OUT = join(OUT_DIR, "_examples.ts");

/**
 * 扫 rootDir 下各子目录，按以下规则分类：
 *  - 含 workflow.ts → tsOnly（不种 DB，避免幽灵死行）
 *  - 否则含 workflow.json → templates（解析 doc + revision）
 * 结果按 name 字母序返回。
 */
export function classifyExamples(rootDir: string): {
  templates: { name: string; doc: Record<string, unknown>; revision: number }[];
  tsOnly: string[];
} {
  const names = readdirSync(rootDir)
    .filter((n) => statSync(join(rootDir, n)).isDirectory())
    .sort();

  const templates: { name: string; doc: Record<string, unknown>; revision: number }[] = [];
  const tsOnly: string[] = [];

  for (const name of names) {
    const dir = join(rootDir, name);
    if (existsSync(join(dir, "workflow.ts"))) {
      tsOnly.push(name);
      continue;
    }
    const jsonPath = join(dir, "workflow.json");
    if (!existsSync(jsonPath)) continue;
    const doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
    const revision = typeof doc.template_revision === "number" ? doc.template_revision : 0;
    templates.push({ name, doc, revision });
  }

  return { templates, tsOnly };
}

const { templates, tsOnly } = classifyExamples(ROOT);

const rows = templates
  .map((t) => `  { name: ${JSON.stringify(t.name)}, revision: ${t.revision}, doc: ${JSON.stringify(t.doc)} },`)
  .join("\n");

const body = `// 由 scripts/gen-examples-index.ts 生成，勿手改。examples/workflows/*/workflow.json 的编译期内联。
export interface ExampleTemplate { name: string; doc: Record<string, unknown>; revision: number; }
export const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
${rows}
];
export const EXAMPLE_TS_ONLY: string[] = ${JSON.stringify(tsOnly)};
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 生成 ${templates.length} 个 examples 模板常量（含 ts 跳过 ${tsOnly.length}）→ ${OUT}`);
