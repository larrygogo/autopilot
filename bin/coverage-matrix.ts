#!/usr/bin/env bun
/**
 * RPC method × {web / tui / cli} 覆盖矩阵扫描器。
 *
 * 用途：发现 (a) 只在 Web 上用的 method —— 反渗内核命名的候选；
 *      (b) 在 TUI / CLI 上长期缺位的 method —— 死代码候选。
 *
 * 用法：
 *   bun run bin/coverage-matrix.ts              # markdown 输出到 stdout
 *   bun run bin/coverage-matrix.ts --json       # JSON 输出
 *   bun run bin/coverage-matrix.ts -o FILE      # 写到文件
 *
 * 覆盖判定：粗匹配 —— 在客户端目录里 grep 字面量 method name / endpoint path。
 * 字符串带引号才算（避免误匹配注释/日志里的提及）。出现次数 ≥ 1 视为覆盖。
 *
 * 这是诊断工具，不做 CI 强制。要加 expected vs actual diff 是下一步。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");

const CLIENT_ROOTS: Record<"web" | "tui" | "cli", string[]> = {
  web: ["src/web/src"],
  tui: ["src/tui"],
  // CLI 直接调 client；client 自身是三端共用，不算在 CLI 单独覆盖里
  cli: ["src/cli", "bin"],
};

interface CoverageRow {
  /** RPC method 名（如 "tasks.list"）或 HTTP endpoint 签名（如 "GET /api/tasks"） */
  name: string;
  /** 类型：rpc 或 http */
  kind: "rpc" | "http";
  /** 三端实际引用次数 */
  web: number;
  tui: number;
  cli: number;
  /** 总引用次数（含内核 + 客户端） */
  totalRefs: number;
}

// ──────────────────────────────────────────────
// 提取：daemon 内核能力面
// ──────────────────────────────────────────────

function extractRpcMethods(): string[] {
  const src = readFileSync(join(ROOT, "src/daemon/rpc-methods.ts"), "utf-8");
  // 匹配 `method: "tasks.list"` —— 仅在 registerRpcMethod 参数里出现
  const re = /^\s*method:\s*"([^"]+)"/gm;
  const set = new Set<string>();
  for (const m of src.matchAll(re)) set.add(m[1]);
  return [...set].sort();
}

function extractHttpEndpoints(): { httpMethod: string; path: string }[] {
  const src = readFileSync(join(ROOT, "src/daemon/routes.ts"), "utf-8");
  // 形如：`method === "GET" && path === "/api/foo"`
  const re = /method === "([A-Z]+)"[^=]*path === "([^"]+)"/g;
  const seen = new Set<string>();
  const out: { httpMethod: string; path: string }[] = [];
  for (const m of src.matchAll(re)) {
    const key = `${m[1]} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ httpMethod: m[1], path: m[2] });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.httpMethod.localeCompare(b.httpMethod));
}

// ──────────────────────────────────────────────
// 扫描客户端引用
// ──────────────────────────────────────────────

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", "web-dist", ".bun", ".git"]);

function* walkSources(dir: string): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkSources(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXT.has(name.slice(dot))) yield full;
    }
  }
}

/**
 * 在文件里数 needle 出现次数。
 *
 * RPC method（带 `.` 的形如 tasks.list）：匹配「带引号字面量」，防注释 / log 误中。
 * HTTP path（带 `/api/`）：匹配「引号或反引号包裹 + 后面是空格 / 反引号 / 引号 / 模板 ${」，
 *   覆盖 `"path"` 和 `` `path/${id}` `` 两种常见写法。
 */
function makeMatcher(needle: string): RegExp {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (needle.startsWith("/api/")) {
    // 允许 path 后接 / （子路径）、? （query）、$ （模板插值）、引号或反引号边界
    return new RegExp(`["'\`]${esc}(?=[/?$"'\`])`, "g");
  }
  // RPC method：严格引号边界两侧
  return new RegExp(`["']${esc}["']`, "g");
}

/** 一次读完所有客户端源文件，存到 root → [{file, content}] 缓存。 */
function loadClientFiles(): Record<keyof typeof CLIENT_ROOTS, string[]> {
  const out = { web: [] as string[], tui: [] as string[], cli: [] as string[] };
  for (const key of Object.keys(CLIENT_ROOTS) as (keyof typeof CLIENT_ROOTS)[]) {
    for (const root of CLIENT_ROOTS[key]) {
      const abs = join(ROOT, root);
      for (const file of walkSources(abs)) {
        out[key].push(readFileSync(file, "utf-8"));
      }
    }
  }
  return out;
}

function countInContents(contents: string[], needle: string): number {
  const re = makeMatcher(needle);
  let total = 0;
  for (const c of contents) total += (c.match(re) ?? []).length;
  return total;
}

// ──────────────────────────────────────────────
// 构建矩阵
// ──────────────────────────────────────────────

function buildMatrix(): CoverageRow[] {
  const rows: CoverageRow[] = [];
  const cache = loadClientFiles();

  for (const m of extractRpcMethods()) {
    const web = countInContents(cache.web, m);
    const tui = countInContents(cache.tui, m);
    const cli = countInContents(cache.cli, m);
    rows.push({
      name: m,
      kind: "rpc",
      web,
      tui,
      cli,
      totalRefs: web + tui + cli,
    });
  }

  for (const ep of extractHttpEndpoints()) {
    const web = countInContents(cache.web, ep.path);
    const tui = countInContents(cache.tui, ep.path);
    const cli = countInContents(cache.cli, ep.path);
    rows.push({
      name: `${ep.httpMethod} ${ep.path}`,
      kind: "http",
      web,
      tui,
      cli,
      totalRefs: web + tui + cli,
    });
  }

  return rows;
}

// ──────────────────────────────────────────────
// 输出
// ──────────────────────────────────────────────

function fmtCov(n: number): string {
  if (n === 0) return "—";
  return String(n);
}

function renderMarkdown(rows: CoverageRow[]): string {
  const rpc = rows.filter((r) => r.kind === "rpc");
  const http = rows.filter((r) => r.kind === "http");

  const lines: string[] = [];
  lines.push("# RPC × {web / tui / cli} 覆盖矩阵");
  lines.push("");
  lines.push("自动生成 —— `bun run bin/coverage-matrix.ts`。");
  lines.push("");
  lines.push("**覆盖判定**：在客户端目录里 grep method 名 / endpoint path 作为字符串字面量出现的次数。`—` 表示零引用。");
  lines.push("");
  lines.push("**怎么读这张表**：");
  lines.push("- 一列只有 web 而 tui/cli 都 `—` 的 method → 反渗内核的高危候选；改名时 web 拖动 trigger 改动");
  lines.push("- **三列全 `—` 的 method** → 死代码候选。常见两种来源：");
  lines.push("  - **HTTP / RPC 迁移残留**：同名 endpoint 已迁到 WS RPC，HTTP 这边没清 → 安全可删");
  lines.push("  - **孤儿 method**：注册了但客户端忘接 → 补客户端调用 or 删 method");
  lines.push("- tui 列大面积 `—` 是当前定位（observer-only）的体现，正常");
  lines.push("- cli 列 `—` 而 web 有 → 若 method 跟自动化无关（如 UI 内编辑器）则正常；跟任务/工作流相关则是 CLI 待补");
  lines.push("");

  // 摘要
  const onlyWebRpc = rpc.filter((r) => r.web > 0 && r.tui === 0 && r.cli === 0).length;
  const orphanRpc = rpc.filter((r) => r.totalRefs === 0).length;
  const onlyWebHttp = http.filter((r) => r.web > 0 && r.tui === 0 && r.cli === 0).length;
  const orphanHttp = http.filter((r) => r.totalRefs === 0).length;

  lines.push("## 摘要");
  lines.push("");
  lines.push(`- RPC method 总数：${rpc.length}`);
  lines.push(`  - 只 web 用：${onlyWebRpc}`);
  lines.push(`  - 无人调用：${orphanRpc}`);
  lines.push(`- HTTP endpoint 总数：${http.length}`);
  lines.push(`  - 只 web 用：${onlyWebHttp}`);
  lines.push(`  - 无人调用：${orphanHttp}`);
  lines.push("");

  function renderSection(title: string, items: CoverageRow[]) {
    lines.push(`## ${title}`);
    lines.push("");
    lines.push("| Name | Web | TUI | CLI |");
    lines.push("|------|-----|-----|-----|");
    for (const r of items) {
      lines.push(`| \`${r.name}\` | ${fmtCov(r.web)} | ${fmtCov(r.tui)} | ${fmtCov(r.cli)} |`);
    }
    lines.push("");
  }

  renderSection("WS RPC methods", rpc);
  renderSection("HTTP endpoints", http);

  return lines.join("\n");
}

function renderJson(rows: CoverageRow[]): string {
  return JSON.stringify({
    generated_at: new Date().toISOString(),
    rows,
  }, null, 2);
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const outIdx = args.indexOf("-o");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

  const rows = buildMatrix();
  const out = wantJson ? renderJson(rows) : renderMarkdown(rows);

  if (outFile) {
    writeFileSync(outFile, out, "utf-8");
    console.log(`已写入 ${relative(ROOT, outFile)}`);
  } else {
    process.stdout.write(out);
    if (!out.endsWith("\n")) process.stdout.write("\n");
  }
}

main();
