#!/usr/bin/env bun
/**
 * 文档中英对照检查脚本
 *
 * 用法：
 *   bun run scripts/check-docs-translation.ts          # 默认模式：仅缺文件时失败
 *   bun run scripts/check-docs-translation.ts --strict # 严格模式：行数差距 / 标题缺失也失败
 *
 * 退出码：
 *   0 — 一切正常（strict 模式下无警告）
 *   1 — 存在缺失的英文版本，或 strict 模式下存在内容差异
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// ── 配置 ─────────────────────────────────────────────────────────
const ROOT = join(import.meta.dir, "..");
const DOCS_CN = join(ROOT, "docs");
const DOCS_EN = join(ROOT, "docs", "en");

// docs/ 下不参与对比的子目录（这些不是需要翻译的文档）
const SKIP_DIRS = new Set(["en", "superpowers", "screenshots"]);

// 单文件免翻译白名单：项目内部记录 / 自动生成 / 中文 first-class 资料
const EXEMPT_FILES = new Set([
  "dogfood-log.md",   // 项目自用 dogfood 记录，中文 first-class
  "rpc-coverage.md",  // 自动生成的覆盖矩阵（bun run coverage:rpc）
]);

// 行数比低于此阈值触发警告（strict 模式下也计入失败）
const WARN_RATIO = 0.85;
// 行数比低于此阈值在严格模式下必须失败
const FAIL_RATIO = 0.70;
// 标题数差距超过此值触发警告
const HEADING_DIFF_WARN = 2;

const STRICT = process.argv.includes("--strict");
// 初期保持 false（报告模式）；存量漏译补完后改为 true 切换到强制模式
const ENFORCE_MODE = false;

// ── 工具函数 ──────────────────────────────────────────────────────

function collectMdFiles(dir: string, skipDirs: Set<string>): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!skipDirs.has(entry)) collectMdFiles(fullPath, new Set());
    } else if (entry.endsWith(".md")) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function extractHeadings(text: string): { h2: number; h3: number; total: number } {
  const lines = text.split("\n");
  const h2 = lines.filter((l) => /^## /.test(l)).length;
  const h3 = lines.filter((l) => /^### /.test(l)).length;
  return { h2, h3, total: h2 + h3 };
}

function ratio(a: number, b: number): number {
  if (a === 0) return 1;
  return b / a;
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

// ANSI 颜色（CI 环境通常支持，不支持时忽略）
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

// ── 主逻辑 ────────────────────────────────────────────────────────

interface FileResult {
  file: string;          // 相对路径（相对 docs/）
  status: "ok" | "warn" | "fail" | "missing";
  cnLines: number;
  enLines: number | null;
  lineRatio: number | null;
  cnHeadings: number;
  enHeadings: number | null;
  headingDiff: number | null;
  issues: string[];
}

const cnFiles = collectMdFiles(DOCS_CN, SKIP_DIRS);
const results: FileResult[] = [];

for (const cnPath of cnFiles) {
  const relPath = relative(DOCS_CN, cnPath);   // e.g. "architecture.md"
  // 免翻译白名单
  if (EXEMPT_FILES.has(relPath)) continue;
  const enPath  = join(DOCS_EN, relPath);

  const cnText = readFileSync(cnPath, "utf-8");
  const cnLines = countLines(cnText);
  const cnHeadings = extractHeadings(cnText);

  let enText: string | null = null;
  try {
    enText = readFileSync(enPath, "utf-8");
  } catch {
    // 英文版不存在
  }

  if (enText === null) {
    results.push({
      file: relPath,
      status: "missing",
      cnLines,
      enLines: null,
      lineRatio: null,
      cnHeadings: cnHeadings.total,
      enHeadings: null,
      headingDiff: null,
      issues: ["缺少英文版"],
    });
    continue;
  }

  const enLines = countLines(enText);
  const enHeadings = extractHeadings(enText);
  const lineR = ratio(cnLines, enLines);
  const headingDiff = cnHeadings.total - enHeadings.total;

  const issues: string[] = [];

  if (lineR < WARN_RATIO) {
    issues.push(
      `行数偏少（中 ${cnLines} 行 → 英 ${enLines} 行，${pct(lineR)}）`
    );
  }
  if (headingDiff > HEADING_DIFF_WARN) {
    issues.push(
      `英文版少 ${headingDiff} 个标题（中 ${cnHeadings.total} → 英 ${enHeadings.total}）`
    );
  }

  let status: FileResult["status"] = "ok";
  if (issues.length > 0) {
    status = lineR < FAIL_RATIO || headingDiff > HEADING_DIFF_WARN * 2 ? "fail" : "warn";
  }

  results.push({
    file: relPath,
    status,
    cnLines,
    enLines,
    lineRatio: lineR,
    cnHeadings: cnHeadings.total,
    enHeadings: enHeadings.total,
    headingDiff,
    issues,
  });
}

// ── 输出报告 ──────────────────────────────────────────────────────

const HR  = "─".repeat(76);
const HR2 = "═".repeat(76);

console.log(`\n${BOLD}📄 docs 中英对照检查报告${RESET}`);
console.log(HR2);
console.log(
  `${DIM}${pad("状态", 5)} ${pad("文件", 32)} ${pad("中文行", 8)} ${pad("英文行", 8)} ${pad("比例", 6)} 标题差${RESET}`
);
console.log(HR);

for (const r of results) {
  let icon: string;
  let color: string;

  if (r.status === "missing") { icon = "❌"; color = RED; }
  else if (r.status === "fail") { icon = "🔴"; color = RED; }
  else if (r.status === "warn") { icon = "⚠️ "; color = YELLOW; }
  else { icon = "✅"; color = GREEN; }

  const cnL  = String(r.cnLines);
  const enL  = r.enLines !== null ? String(r.enLines) : "-";
  const pctS = r.lineRatio !== null ? pct(r.lineRatio) : "-";
  const hdS  = r.headingDiff !== null
    ? (r.headingDiff > 0 ? `EN 少 ${r.headingDiff}` : "=")
    : "-";

  console.log(
    `${color}${icon} ${pad(r.file, 32)} ${pad(cnL, 8)} ${pad(enL, 8)} ${pad(pctS, 6)} ${hdS}${RESET}`
  );

  for (const issue of r.issues) {
    console.log(`   ${DIM}↳ ${issue}${RESET}`);
  }
}

console.log(HR);

// ── 汇总 ──────────────────────────────────────────────────────────

const missing = results.filter((r) => r.status === "missing");
const warns   = results.filter((r) => r.status === "warn");
const fails   = results.filter((r) => r.status === "fail");
const ok      = results.filter((r) => r.status === "ok");

console.log(`\n${BOLD}汇总${RESET}`);
console.log(`  ✅ 正常       ${ok.length} 个`);
if (warns.length)   console.log(`  ⚠️  有警告    ${warns.length} 个`);
if (fails.length)   console.log(`  🔴 内容差距大 ${fails.length} 个`);
if (missing.length) console.log(`  ❌ 缺少英文版 ${missing.length} 个`);

if (missing.length > 0) {
  console.log(`\n${RED}${BOLD}缺少英文版的文件：${RESET}`);
  for (const r of missing) {
    console.log(`  ${RED}docs/en/${r.file}${RESET}`);
  }
}

// ── 退出码 ────────────────────────────────────────────────────────

const hasHardFail = missing.length > 0 || fails.length > 0;
const hasAnyIssue = hasHardFail || warns.length > 0;

// --strict 超严格模式：警告也失败（开发者本地用）
if (STRICT && hasAnyIssue) {
  console.log(
    `\n${RED}[strict] 存在文档差异，退出码 1${RESET}\n`
  );
  process.exit(1);
}

// 强制模式：漏译或严重内容差距时失败（存量补完后切换）
if (ENFORCE_MODE && hasHardFail) {
  console.log(
    `\n${RED}[enforce] 存在漏译或严重内容差距，退出码 1${RESET}\n`
  );
  process.exit(1);
}

// 报告模式（默认）：打印清单，始终 exit 0
if (missing.length > 0 || fails.length > 0) {
  console.log(
    `\n${YELLOW}[report] 发现漏译文件，仅报告不阻断。补完后将 ENFORCE_MODE 改为 true。${RESET}\n`
  );
} else if (warns.length > 0) {
  console.log(
    `\n${YELLOW}有轻微内容差距但不阻断。如需严格检查，加 --strict 参数。${RESET}\n`
  );
} else {
  console.log(`\n${GREEN}所有文档中英对照无问题。${RESET}\n`);
}

process.exit(0);
