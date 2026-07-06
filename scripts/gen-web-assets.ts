#!/usr/bin/env bun
// scripts/gen-web-assets.ts
// 扫 web-dist/**，把每个文件烤成 `import x from "..." with { type: "file" }` 清单。
// 生成物 src/generated/_web-assets.generated.ts 是 gitignore 的，依赖 gitignore 的 web-dist。
import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, relative } from "path";

const WEB_DIST = join(import.meta.dir, "../web-dist");
const OUT_DIR = join(import.meta.dir, "../src/generated");
const OUT = join(OUT_DIR, "_web-assets.generated.ts");

if (!existsSync(WEB_DIST)) {
  console.error("✗ web-dist/ 不存在，先跑 bun run build:web");
  process.exit(1);
}

const files: string[] = [];
(function walk(dir: string) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(WEB_DIST);

const imports: string[] = [];
const rows: string[] = [];
files.forEach((abs, i) => {
  const rel = relative(WEB_DIST, abs).replace(/\\/g, "/");
  const urlKey = "/" + rel;
  imports.push(`import a${i} from "../../web-dist/${rel}" with { type: "file" };`);
  rows.push(`  ${JSON.stringify(urlKey)}: a${i},`);
});

const body = `// @ts-nocheck
// 由 scripts/gen-web-assets.ts 生成（build:web 后自动跑）。
// 依赖 gitignore 的 web-dist，本文件亦 gitignore、不入库。勿手改。
${imports.join("\n")}

export const WEB_ASSETS: Record<string, string> = {
${rows.join("\n")}
};
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 嵌入 ${files.length} 个 web 资源 → ${OUT}`);
