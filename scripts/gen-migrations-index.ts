#!/usr/bin/env bun
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";

const MIG_DIR = join(import.meta.dir, "../src/migrations");
const OUT = join(MIG_DIR, "_generated-index.ts");
const RE = /^(\d{3})-[\w-]+\.ts$/;

const files = readdirSync(MIG_DIR)
  .filter((f) => RE.test(f))
  .sort();

const entries = files.map((f) => ({ name: f.replace(/\.ts$/, ""), version: parseInt(f.slice(0, 3), 10) }));

const imports = entries.map((e, i) => `import * as m${i} from "./${e.name}";`).join("\n");
const rows = entries
  .map((e, i) => `  { version: ${e.version}, name: ${JSON.stringify(e.name)}, up: m${i}.up as MigrationEntry["up"] },`)
  .join("\n");

const body = `// 由 scripts/gen-migrations-index.ts 生成，勿手改。加迁移用 \`autopilot migrate new\` 会自动重跑本脚本。
import type { Database } from "bun:sqlite";
${imports}

export interface MigrationEntry { version: number; name: string; up: (db: Database) => unknown; }

export const MIGRATIONS: MigrationEntry[] = [
${rows}
];
`;
writeFileSync(OUT, body, "utf-8");
console.log(`✓ 生成 ${entries.length} 条迁移注册表 → ${OUT}`);
