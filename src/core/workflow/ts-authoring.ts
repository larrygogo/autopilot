import { existsSync, readFileSync, copyFileSync, writeFileSync } from "fs";
import { getWorkflow, getWorkflowTsPath, type PhaseEntryInput } from "./registry";
import { collectPhaseNames } from "./registry-authoring";

/**
 * workflow.ts 源码改写（authoring）——从 registry.ts 拆出的叶子模块。
 *
 * 把"解析/重写用户 workflow.ts 源文件"这一与工作流注册/运行无关的关注点独立出来：
 * 校准缺失 run_<phase>、重命名、删孤儿、整体替换函数体。含字符级 tokenizer
 * （跳字符串/注释、平衡花括号定位函数体）。Web 工作流编辑器经 rpc 调用。
 *
 * 依赖 registry 的只读接口（getWorkflow/getWorkflowTsPath/collectPhaseNames）；
 * registry 不依赖本模块 → 干净 DAG 无回环。
 */

export interface SyncTsResult {
  /** 新追加的函数名列表 */
  added: string[];
  /** 存在但 phases 未引用的孤儿函数（不自动删） */
  orphans: string[];
  /** 是否修改了文件 */
  modified: boolean;
  /** 使用了旧 `ctx` 签名（runner 实际只传 taskId 字符串，会运行时报错）的函数名 */
  legacy_signature?: string[];
}

export function syncWorkflowTs(workflowName: string): SyncTsResult {
  const tsPath = getWorkflowTsPath(workflowName);
  if (!existsSync(tsPath)) throw new Error(`workflow.ts 不存在：${workflowName}`);

  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`工作流未注册：${workflowName}（请先 reload）`);

  const phaseNames = collectPhaseNames(wf.phases as PhaseEntryInput[]);
  const phaseSet = new Set(phaseNames);

  const content = readFileSync(tsPath, "utf-8");
  const existingFns = extractRunFunctions(content);
  const existingSet = new Set(existingFns);

  const missing = phaseNames.filter((n) => !existingSet.has(n));
  const orphans = existingFns.filter((n) => !phaseSet.has(n));
  const legacy = detectLegacySignatures(content);

  if (missing.length === 0) {
    return { added: [], orphans, modified: false, legacy_signature: legacy };
  }

  const appended = missing.map((name) => renderRunFunctionStub(name)).join("\n\n");
  const newContent = content.replace(/\s*$/, "") + "\n\n" + appended + "\n";

  copyFileSync(tsPath, tsPath + ".bak");
  writeFileSync(tsPath, newContent, "utf-8");

  return { added: missing, orphans, modified: true, legacy_signature: legacy };
}

/**
 * 重命名 workflow.ts 中的 run_<old> 函数声明为 run_<new>，保留函数体。
 * 支持 export async function / export function / export const 三种写法。
 * 不修改字符串字面量或注释中的旧名（避免污染业务代码）。
 * 返回实际被重命名的旧名列表。
 */
export function renameRunFunctions(
  workflowName: string,
  renames: Record<string, string>,
): { renamed: string[] } {
  const tsPath = getWorkflowTsPath(workflowName);
  if (!existsSync(tsPath)) return { renamed: [] };

  let content = readFileSync(tsPath, "utf-8");
  const renamed: string[] = [];

  for (const [oldName, newName] of Object.entries(renames)) {
    if (!oldName || !newName || oldName === newName) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(newName)) continue;

    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`(export\\s+(?:async\\s+)?function\\s+)run_${escaped}(?=\\s*\\()`, "g"),
      new RegExp(`(export\\s+const\\s+)run_${escaped}(?=\\s*[=:])`, "g"),
    ];
    let changed = false;
    for (const re of patterns) {
      const replaced = content.replace(re, (_m, prefix: string) => {
        changed = true;
        return `${prefix}run_${newName}`;
      });
      if (replaced !== content) content = replaced;
    }
    if (changed) renamed.push(oldName);
  }

  if (renamed.length > 0) {
    copyFileSync(tsPath, tsPath + ".bak");
    writeFileSync(tsPath, content, "utf-8");
  }
  return { renamed };
}

/**
 * 删除 workflow.ts 中指定的 run_<name> 函数声明（整个函数）。
 * 用字符级 tokenizer 处理字符串 / 注释 / 模板字符串，平衡花括号定位函数体结束。
 * 写入前先备份 .bak。返回真正删除的函数名。
 */
export function pruneOrphanRunFunctions(
  workflowName: string,
  names: string[],
): { removed: string[] } {
  const tsPath = getWorkflowTsPath(workflowName);
  if (!existsSync(tsPath)) return { removed: [] };

  let content = readFileSync(tsPath, "utf-8");
  const removed: string[] = [];

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const range = findRunFunctionRange(content, name);
    if (!range) continue;
    // 同时吃掉前后多余空行，避免留下两个空行
    let before = range.start;
    while (before > 0 && (content[before - 1] === "\n" || content[before - 1] === " ")) {
      if (content[before - 1] === "\n" && (before - 2 < 0 || content[before - 2] === "\n")) break;
      before--;
    }
    let after = range.end;
    while (after < content.length && content[after] === "\n") after++;
    content = content.slice(0, before) + (before > 0 ? "\n" : "") + content.slice(after);
    removed.push(name);
  }

  if (removed.length > 0) {
    copyFileSync(tsPath, tsPath + ".bak");
    writeFileSync(tsPath, content, "utf-8");
  }
  return { removed };
}

/**
 * 用用户提供的 newCode 整体替换 workflow.ts 中 run_<phase> 函数声明。
 *
 * - newCode 必须以 `export (async) function run_<phase>(` 开头（防止函数名 mismatch）。
 * - 若旧函数不存在 → 追加到文件末尾；存在 → 字符级精确替换。
 * - 写入前 .bak 备份。
 *
 * 不修改函数声明以外的 ts 代码（import、其它函数、注释等）。
 */
export function replaceRunFunction(
  workflowName: string,
  phase: string,
  newCode: string,
): { mode: "replaced" | "appended" } {
  if (!/^[a-z][a-z0-9_]*$/.test(phase)) {
    throw new Error(`非法 phase 名：${phase}`);
  }
  const trimmed = newCode.trim();
  const header = new RegExp(`^export\\s+(?:async\\s+)?function\\s+run_${phase}\\s*\\(`);
  if (!header.test(trimmed)) {
    throw new Error(
      `代码必须以 "export async function run_${phase}(" 开头；请勿改函数名或签名`,
    );
  }

  const tsPath = getWorkflowTsPath(workflowName);
  if (!existsSync(tsPath)) {
    throw new Error(`workflow.ts 不存在：${workflowName}`);
  }
  const content = readFileSync(tsPath, "utf-8");
  copyFileSync(tsPath, tsPath + ".bak");

  const range = findRunFunctionRange(content, phase);
  let next: string;
  let mode: "replaced" | "appended";
  if (range) {
    next = content.slice(0, range.start) + trimmed + content.slice(range.end);
    mode = "replaced";
  } else {
    next = content.replace(/\s*$/, "") + "\n\n" + trimmed + "\n";
    mode = "appended";
  }
  writeFileSync(tsPath, next, "utf-8");
  return { mode };
}

/**
 * 定位 `export (async) function run_<name>(...)` 整段函数的起止范围。
 * 不支持 `export const run_x = ...` 箭头函数形式（需要额外处理，少见）。
 */
function findRunFunctionRange(src: string, name: string): { start: number; end: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+run_${escaped}\\s*\\(`, "g");
  const m = re.exec(src);
  if (!m) return null;

  const start = m.index;
  let i = m.index + m[0].length;

  // 1. 配对闭合最外层 `(` (函数参数)
  let parenDepth = 1;
  while (i < src.length && parenDepth > 0) {
    const c = src[i];
    if (c === "(") parenDepth++;
    else if (c === ")") parenDepth--;
    else if (c === "\"" || c === "'" || c === "`") i = skipString(src, i, c);
    else if (c === "/" && src[i + 1] === "/") i = skipLineComment(src, i);
    else if (c === "/" && src[i + 1] === "*") i = skipBlockComment(src, i);
    i++;
  }

  // 2. 跳过返回类型到第一个 `{`
  while (i < src.length && src[i] !== "{") {
    const c = src[i];
    if (c === "\"" || c === "'" || c === "`") { i = skipString(src, i, c); i++; continue; }
    if (c === "/" && src[i + 1] === "/") { i = skipLineComment(src, i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = skipBlockComment(src, i); continue; }
    i++;
  }
  if (i >= src.length) return null;

  // 3. 花括号平衡定位函数体结束
  let braceDepth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") { braceDepth++; i++; continue; }
    if (c === "}") { braceDepth--; i++; if (braceDepth === 0) break; continue; }
    if (c === "\"" || c === "'" || c === "`") { i = skipString(src, i, c); i++; continue; }
    if (c === "/" && src[i + 1] === "/") { i = skipLineComment(src, i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = skipBlockComment(src, i); continue; }
    i++;
  }
  return { start, end: i };
}

/** 返回字符串结束字符（闭合引号）的索引。i 指向开始引号。 */
function skipString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") { j += 2; continue; }
    j++;
  }
  return j; // 指向闭合引号本身，让调用方 i++ 前进
}

function skipLineComment(src: string, i: number): number {
  let j = i;
  while (j < src.length && src[j] !== "\n") j++;
  return j;
}

function skipBlockComment(src: string, i: number): number {
  let j = i + 2;
  while (j < src.length - 1 && !(src[j] === "*" && src[j + 1] === "/")) j++;
  return j + 2;
}

/** 检测使用旧 `ctx: { task: any; ... }` 签名的 run_ 函数（运行时会崩） */
function detectLegacySignatures(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:async\s+)?function\s+run_([A-Za-z0-9_]+)\s*\(\s*ctx\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function extractRunFunctions(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    /export\s+async\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+const\s+run_([A-Za-z0-9_]+)\s*=/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}

function renderRunFunctionStub(phaseName: string): string {
  return `export async function run_${phaseName}(taskId: string): Promise<void> {
  console.log(\`[\${taskId}] 执行阶段 ${phaseName}\`);
  // TODO: 实现阶段逻辑
}`;
}
