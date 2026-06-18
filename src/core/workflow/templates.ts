/**
 * 工作流模板管理：扫描 examples/workflows/* 目录，让用户从内置模板克隆出自己的工作流。
 *
 * - 模板源：项目仓库内 `examples/workflows/<name>/` 目录
 * - 目标：`AUTOPILOT_HOME/workflows/<new-name>/`
 * - 克隆 = 递归拷贝目录（含 workflow.yaml + workflow.ts + 任意附属文件）
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { getWorkflowFromDb, createTemplateDbWorkflow, createNativeDbWorkflow, createDbWorkflow } from "./workflows";
import { parseWorkflowText, stringifyWorkflowDoc } from "./serialize";

export interface WorkflowTemplate {
  /** 模板名（目录名，如 "dev"） */
  name: string;
  /** 来自 workflow.yaml 的 label（显示名），未填则前端回退到 name */
  label?: string;
  /** 来自 workflow.yaml 的 description */
  description: string;
  /** phases 数量 */
  phase_count: number;
  /** agents 数量 */
  agent_count: number;
}

/**
 * 找仓库内的 examples/workflows 根目录。
 * 优先用 bin/autopilot.ts 所在仓库路径（CWD / process.argv[1] 推断）；
 * 失败则尝试相对当前文件位置回溯。
 */
function findExamplesRoot(): string | null {
  // 从当前模块出发：src/core/workflow-templates.ts → ../../examples/workflows
  const candidates = [
    join(import.meta.dir, "..", "..", "examples", "workflows"),
    join(process.cwd(), "examples", "workflows"),
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

/**
 * 列出所有可用模板（扫 examples/workflows/<name>/workflow.yaml）。
 * 没有 workflow.yaml 的目录被跳过（如 README.md）。
 */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  const root = findExamplesRoot();
  if (!root) return [];

  const result: WorkflowTemplate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const yamlPath = join(dir, "workflow.yaml");
    if (!existsSync(yamlPath)) continue;
    try {
      const parsed = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
      const label = typeof parsed.label === "string" && parsed.label.trim()
        ? parsed.label.trim()
        : undefined;
      const description = typeof parsed.description === "string" ? parsed.description : "";
      const phases = Array.isArray(parsed.phases) ? parsed.phases : [];
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      result.push({
        name: entry,
        label,
        description,
        phase_count: phases.length,
        agent_count: agents.length,
      });
    } catch {
      // yaml 解析失败的模板跳过；不阻塞其他模板
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * 从模板克隆到 AUTOPILOT_HOME/workflows/<targetName>/。
 * - 目标已存在：抛 Error("target workflow already exists")
 * - 模板不存在：抛 Error("template not found")
 * - 克隆完成后调用方负责重启 discover 让 registry 重新加载
 *
 * 关键步骤：拷贝后会**重写 workflow.yaml 顶层 name 字段为 targetName**，
 * 否则克隆出来的 yaml 还是用模板原名，discover 时会和源工作流同名冲突，
 * 内存 registry 用 wf.name 作 key 互相覆盖，UI 列表里只看到一个。
 */
/** 在 root 下列出可用模板目录名（含 workflow.yaml 的）。给错误信息当 hint。 */
function availableTemplates(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((entry) => {
        const dir = join(root, entry);
        return statSync(dir).isDirectory() && existsSync(join(dir, "workflow.yaml"));
      });
  } catch { return []; }
}

/**
 * 把内置模板 examples/workflows/<name>/ 种成 DB 模板行（kind=template，spec_json 真相），
 * **不拷文件**（DB 是默认安装形态，方案 C / Step 5b）。**幂等**：
 *   - 磁盘已有 file 副本（~/.autopilot/workflows/<name>/）→ skip（双轨：存量 file 优先，不撞名）；
 *   - DB 已有同名 → skip。
 * 仅适用于零 ts 的声明式模板（dev/ad-hoc）——含 ts 的模板没法当 native/template（declarative 强制）。
 * 返回 'seeded' | 'exists' | 'no-template' | 'has-ts'（含 workflow.ts，拒种避免死行）。
 */
export function seedTemplateWorkflow(name: string): "seeded" | "exists" | "no-template" | "has-ts" {
  // 磁盘 file 副本在 → 不种（存量用户双轨，避免同名冲突）
  if (existsSync(join(autopilotHome(), "workflows", name))) return "exists";
  if (getWorkflowFromDb(name)) return "exists";
  const root = findExamplesRoot();
  if (!root) return "no-template";
  // L6 守卫：含 workflow.ts 的模板不是声明式，种成 native/template 会被 declarative 闸门拒、组装失败
  // → 幽灵死行（init 报「已装入」但列表找不到）。把约束钉死在种子入口，而非依赖手维护 seed 列表。
  if (existsSync(join(root, name, "workflow.ts"))) return "has-ts";
  const yamlPath = join(root, name, "workflow.yaml");
  if (!existsSync(yamlPath)) return "no-template";
  const doc = parseWorkflowText(readFileSync(yamlPath, "utf-8"), "yaml") as Record<string, unknown> | null;
  if (!doc || !Array.isArray(doc["phases"])) return "no-template";
  const description = typeof doc["description"] === "string" ? doc["description"] : "";
  createTemplateDbWorkflow({ name, description, spec_json: stringifyWorkflowDoc(doc, "json") });
  return "seeded";
}

export function cloneTemplate(template: string, targetName: string): void {
  const root = findExamplesRoot();
  if (!root) throw new Error(`找不到 examples/workflows 根目录（cwd=${process.cwd()}）。确保仓库结构完整，或自行 cp 模板到 ~/.autopilot/workflows/`);
  const srcDir = join(root, template);
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`模板 "${template}" 不存在：${srcDir}。已有模板：${availableTemplates(root).join(", ") || "(无)"}`);
  }
  if (!existsSync(join(srcDir, "workflow.yaml"))) {
    throw new Error(`模板 "${template}" 缺 workflow.yaml：${srcDir}`);
  }

  const home = autopilotHome();
  const dstDir = join(home, "workflows", targetName);
  if (existsSync(dstDir)) {
    throw new Error("target workflow already exists");
  }

  // 递归拷贝（保守：避免引入新依赖；只拷文件 + 一层目录）
  copyDirSync(srcDir, dstDir);

  // 把新 workflow.yaml 里的 name 改成 targetName
  rewriteWorkflowName(join(dstDir, "workflow.yaml"), targetName);
}

/**
 * 从用户已有的工作流（AUTOPILOT_HOME/workflows/<source>/）克隆为新工作流。
 *
 * 跟 cloneTemplate 的区别：
 *   - cloneTemplate 的源在仓库内 `examples/workflows/`（只读、只能克隆内置模板）
 *   - cloneWorkflow 的源在用户家目录（含用户修改过的内容、自己创建的工作流）
 *
 * 行为：
 *   - 源不存在 → 抛 "source workflow not found"
 *   - 目标已存在 → 抛 "target workflow already exists"
 *   - 拷贝完成后重写新 yaml 顶层 name 为 targetName，避免重名碰撞
 *
 * 限制：仅支持 file 来源（磁盘有目录的工作流）；DB 工作流（source=db）数据
 * 在 DB 里没有磁盘目录，不走此路径。
 */
export function cloneWorkflow(sourceName: string, targetName: string): void {
  if (!/^[\w.\-]+$/.test(targetName)) {
    throw new Error("target name 只允许字母 / 数字 / . _ -");
  }
  if (getWorkflowFromDb(targetName)) {
    throw new Error("target workflow already exists");
  }
  const home = autopilotHome();
  const srcDir = join(home, "workflows", sourceName);
  const dstDir = join(home, "workflows", targetName);

  // 磁盘无源目录 → 回退 DB：克隆 DB 工作流（native/template/derived）。新装机 dev/ad-hoc 是
  // DB 模板无磁盘目录，旧逻辑直接「source not found」404；这里据 DB 行克隆出一份可编辑的 native。
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    const row = getWorkflowFromDb(sourceName);
    if (!row) throw new Error("source workflow not found");
    if (existsSync(dstDir)) throw new Error("target workflow already exists");
    if ((row.kind === "native" || row.kind === "template") && row.spec_json) {
      // 克隆出 native（可编辑）；内层 name 归一为 targetName
      const doc = JSON.parse(row.spec_json) as Record<string, unknown>;
      doc["name"] = targetName;
      createNativeDbWorkflow({ name: targetName, description: row.description, spec_json: stringifyWorkflowDoc(doc, "json") });
    } else if (row.kind === "derived" && row.derives_from) {
      const doc = parseWorkflowText(row.yaml_content, "yaml") as Record<string, unknown>;
      doc["name"] = targetName;
      createDbWorkflow({ name: targetName, description: row.description, derives_from: row.derives_from, yaml_content: stringifyWorkflowDoc(doc, "yaml") });
    } else {
      throw new Error("source workflow not found");
    }
    return;
  }
  if (!existsSync(join(srcDir, "workflow.yaml"))) {
    throw new Error("source workflow has no workflow.yaml");
  }
  if (existsSync(dstDir)) {
    throw new Error("target workflow already exists");
  }

  copyDirSync(srcDir, dstDir);
  rewriteWorkflowName(join(dstDir, "workflow.yaml"), targetName);
}

/**
 * 重写 workflow.yaml 顶层 name 字段为 newName。
 * 简单做法：只替换"行首 name:" 那一行，不解析整个 yaml，避免破坏注释/格式/锚点。
 */
function rewriteWorkflowName(yamlPath: string, newName: string): void {
  if (!existsSync(yamlPath)) return;
  const content = readFileSync(yamlPath, "utf-8");
  const lines = content.split(/\r?\n/);
  let rewritten = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^name:\s*.*$/);
    if (m) {
      lines[i] = `name: ${newName}`;
      rewritten = true;
      break; // 只改第一处顶层 name
    }
  }
  if (!rewritten) {
    // yaml 里没有顶层 name？补一行到开头
    lines.unshift(`name: ${newName}`);
  }
  writeFileSync(yamlPath, lines.join("\n"), "utf-8");
}

function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDirSync(s, d);
    } else if (st.isFile()) {
      copyFileSync(s, d);
    }
  }
}

// ──────────────────────────────────────────────
// 模板同步（dogfood-bug9）：repo 内 examples 改了 bug fix，老用户已有的
// ~/.autopilot/workflows/<name>/ 副本是冻结快照拿不到。提供 diff + 覆盖能力。
// ──────────────────────────────────────────────

export interface TemplateDiffEntry {
  /** 文件名（相对模板根） */
  path: string;
  /** local 是否存在 */
  hasLocal: boolean;
  /** template 是否存在 */
  hasTemplate: boolean;
  /** local 跟 template 内容是否一致（都不存在时 true） */
  identical: boolean;
  /** local 行数（不存在则 0） */
  localLines: number;
  /** template 行数（不存在则 0） */
  templateLines: number;
}

/**
 * 比对本地 ~/.autopilot/workflows/<name>/ 跟 repo 内 examples/workflows/<name>/
 * 的所有文件，返回 diff 摘要。同时存在的文件按字节比较内容是否一致。
 *
 * - template 不存在 → 抛 Error
 * - local 不存在 → 返回所有 template 文件标记 hasLocal=false
 */
export function diffWorkflowTemplate(name: string): TemplateDiffEntry[] {
  const root = findExamplesRoot();
  if (!root) throw new Error("templates root not found");
  const tplDir = join(root, name);
  if (!existsSync(tplDir) || !statSync(tplDir).isDirectory()) {
    throw new Error(`template not found: ${name}`);
  }
  const home = autopilotHome();
  const localDir = join(home, "workflows", name);

  const tplFiles = listFilesRecursive(tplDir);
  const localFiles = existsSync(localDir) ? listFilesRecursive(localDir) : new Set<string>();
  const allRel = new Set<string>([...tplFiles, ...localFiles]);

  const entries: TemplateDiffEntry[] = [];
  for (const rel of [...allRel].sort()) {
    const localPath = join(localDir, rel);
    const tplPath = join(tplDir, rel);
    const hasLocal = localFiles.has(rel);
    const hasTemplate = tplFiles.has(rel);
    let identical = hasLocal === hasTemplate; // 都不存在时 vacuously true
    let localLines = 0;
    let templateLines = 0;
    if (hasLocal) {
      try {
        const buf = readFileSync(localPath, "utf-8");
        localLines = buf.split("\n").length;
        if (hasTemplate) {
          const tplBuf = readFileSync(tplPath, "utf-8");
          templateLines = tplBuf.split("\n").length;
          identical = buf === tplBuf;
        }
      } catch { /* 读失败认为不一致 */ identical = false; }
    } else if (hasTemplate) {
      try {
        const tplBuf = readFileSync(tplPath, "utf-8");
        templateLines = tplBuf.split("\n").length;
      } catch { /* ignore */ }
    }
    entries.push({ path: rel, hasLocal, hasTemplate, identical, localLines, templateLines });
  }
  return entries;
}

/**
 * 用 repo 内 examples/workflows/<name>/ 覆盖 ~/.autopilot/workflows/<name>/。
 * 不删本地多余的文件（保守：用户可能有自己加的辅助文件）。
 * 调用方负责先 diff + 让用户确认。
 */
export function syncWorkflowTemplate(name: string): { copied: string[] } {
  // 同名已是 DB 工作流（native/template）→ sync（文件覆盖语义）不适用：写盘只会造一个被 discover
  // 忽略的孤儿目录。明确拒绝、指引正路，避免用户对着「sync 了却没生效」困惑。
  const dbRow = getWorkflowFromDb(name);
  if (dbRow && dbRow.source === "db") {
    throw new Error(`工作流 "${name}" 是 DB 工作流（${dbRow.kind}），文件 sync 不适用；要更新请用 autopilot workflow import 或重新 init`);
  }
  const root = findExamplesRoot();
  if (!root) throw new Error("templates root not found");
  const tplDir = join(root, name);
  if (!existsSync(tplDir) || !statSync(tplDir).isDirectory()) {
    throw new Error(`template not found: ${name}`);
  }
  const home = autopilotHome();
  const localDir = join(home, "workflows", name);
  mkdirSync(localDir, { recursive: true });

  const tplFiles = [...listFilesRecursive(tplDir)].sort();
  const copied: string[] = [];
  for (const rel of tplFiles) {
    const s = join(tplDir, rel);
    const d = join(localDir, rel);
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    copied.push(rel);
  }
  return { copied };
}

/**
 * 从 workflow.yaml 文本取顶层 `template_revision`（缺失 / 无匹配 → 0）。纯函数，可测。
 * 用 targeted 正则而非全量 YAML 解析：只取一个顶层整数，鲁棒、零依赖、容忍行尾注释。
 * 老副本（本字段引入前的拷贝）没有此字段 → 0，天然落后于带 revision 的新模板。
 */
export function parseTemplateRevision(yamlContent: string): number {
  const m = yamlContent.match(/^template_revision:\s*(\d+)\s*(?:#.*)?$/m);
  return m ? parseInt(m[1], 10) : 0;
}

/** 读 workflow.yaml 顶层 `template_revision`（文件不存在 / 读失败 → 0）。 */
function readTemplateRevision(yamlPath: string): number {
  try {
    return parseTemplateRevision(readFileSync(yamlPath, "utf-8"));
  } catch {
    return 0;
  }
}

/**
 * 单个工作流的本地副本是否落后于内置模板（按 template_revision 比对）。
 * 区别于字节 diff：revision 比对能区分「用户合法定制」和「上游有新修复」——只有 examples
 * 的 revision 更高才算落后。examples 或本地副本不存在 → false（无从比较）。
 */
export function isWorkflowCopyOutdated(name: string): boolean {
  const root = findExamplesRoot();
  if (!root) return false;
  const tplYaml = join(root, name, "workflow.yaml");
  const localYaml = join(autopilotHome(), "workflows", name, "workflow.yaml");
  if (!existsSync(tplYaml) || !existsSync(localYaml)) return false;
  return readTemplateRevision(tplYaml) > readTemplateRevision(localYaml);
}

/**
 * 列出所有「本地副本落后内置模板」的工作流（template_revision 比对）。
 * daemon 启动时跑一次，把「副本该同步了」从「每个 git 任务无条件 warn」（狼来了）
 * 收敛成「真落后才提示一次」。
 */
export function listOutdatedWorkflowCopies(): Array<{ name: string; local: number; template: number }> {
  const root = findExamplesRoot();
  if (!root) return [];
  const home = autopilotHome();
  const out: Array<{ name: string; local: number; template: number }> = [];
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => existsSync(join(root, n, "workflow.yaml")));
  } catch {
    return [];
  }
  for (const name of names) {
    const localYaml = join(home, "workflows", name, "workflow.yaml");
    if (!existsSync(localYaml)) continue;
    const template = readTemplateRevision(join(root, name, "workflow.yaml"));
    const local = readTemplateRevision(localYaml);
    if (template > local) out.push({ name, local, template });
  }
  return out;
}

function listFilesRecursive(root: string, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (st.isDirectory()) {
      for (const child of listFilesRecursive(full, rel)) out.add(child);
    } else if (st.isFile()) {
      out.add(rel);
    }
  }
  return out;
}

// ──────────────────────────────────────────────
// 孤儿工作流扫描 / 修复
// ──────────────────────────────────────────────

export interface OrphanWorkflow {
  /** 目录名（位于 ~/.autopilot/workflows/<dir>/） */
  dir: string;
  /** workflow.yaml 顶层 name 字段实际值 */
  yamlName: string;
  /** 不一致的原因 */
  issue: "name_mismatch";
  /** 建议的修复方式 */
  suggestion: string;
}

export interface WorkflowCollision {
  /** 冲突的 yaml.name */
  name: string;
  /** 共用此 name 的所有目录 */
  dirs: string[];
}

export interface WorkflowHealthReport {
  orphans: OrphanWorkflow[];
  collisions: WorkflowCollision[];
}

/**
 * 扫描 ~/.autopilot/workflows/ 下的所有目录，找出 yaml.name 跟目录名
 * 不一致的孤儿（影响 UI 显示），以及多个目录共享同一 yaml.name 的碰撞
 * （registry 内存覆盖 / 列表少条目）。
 *
 * 不解析整个 yaml，只读第一处顶层 `name:` 行（兼容注释、多文档头等）。
 */
export function scanWorkflowHealth(): WorkflowHealthReport {
  const home = autopilotHome();
  const root = join(home, "workflows");
  if (!existsSync(root)) return { orphans: [], collisions: [] };

  const orphans: OrphanWorkflow[] = [];
  const byYamlName = new Map<string, string[]>();

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { orphans: [], collisions: [] };
  }

  for (const dir of entries) {
    if (dir.startsWith("_") || dir.startsWith(".")) continue;
    const yamlPath = join(root, dir, "workflow.yaml");
    if (!existsSync(yamlPath)) continue;
    const yamlName = readYamlTopName(yamlPath);
    if (!yamlName) continue;
    if (yamlName !== dir) {
      orphans.push({
        dir,
        yamlName,
        issue: "name_mismatch",
        suggestion: `把 workflow.yaml 顶层 name 改为 "${dir}"，或重命名目录`,
      });
    }
    const arr = byYamlName.get(yamlName) ?? [];
    arr.push(dir);
    byYamlName.set(yamlName, arr);
  }

  const collisions: WorkflowCollision[] = [];
  for (const [name, dirs] of byYamlName.entries()) {
    if (dirs.length > 1) collisions.push({ name, dirs });
  }

  return { orphans, collisions };
}

/**
 * 修复指定孤儿目录：把 workflow.yaml 顶层 name 改为目录名。
 * 失败原因：目录不存在 / 没有 workflow.yaml / yaml 当前 name 就已经一致。
 */
export function fixOrphanWorkflow(dir: string): { fixed: boolean; oldName: string; newName: string } {
  if (!/^[\w.\-]+$/.test(dir)) {
    throw new Error("目录名非法");
  }
  const yamlPath = join(autopilotHome(), "workflows", dir, "workflow.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error("目录或 workflow.yaml 不存在");
  }
  const oldName = readYamlTopName(yamlPath) ?? "";
  if (oldName === dir) {
    return { fixed: false, oldName, newName: dir };
  }
  rewriteWorkflowName(yamlPath, dir);
  return { fixed: true, oldName, newName: dir };
}

/** 读 yaml 顶层第一处 `name:` 字段值；找不到返回 null */
function readYamlTopName(yamlPath: string): string | null {
  try {
    const content = readFileSync(yamlPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^name:\s*(.+?)\s*$/);
      if (m) {
        return m[1].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
