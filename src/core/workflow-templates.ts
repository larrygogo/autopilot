/**
 * 工作流模板管理：扫描 examples/workflows/* 目录，让用户从内置模板克隆出自己的工作流。
 *
 * - 模板源：项目仓库内 `examples/workflows/<name>/` 目录
 * - 目标：`AUTOPILOT_HOME/workflows/<new-name>/`
 * - 克隆 = 递归拷贝目录（含 workflow.yaml + workflow.ts + 任意附属文件）
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

export interface WorkflowTemplate {
  /** 模板名（目录名，如 "dev" / "req_dev"） */
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
export function cloneTemplate(template: string, targetName: string): void {
  const root = findExamplesRoot();
  if (!root) throw new Error("templates root not found");
  const srcDir = join(root, template);
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error("template not found");
  }
  if (!existsSync(join(srcDir, "workflow.yaml"))) {
    throw new Error("template invalid (no workflow.yaml)");
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
  const home = autopilotHome();
  const srcDir = join(home, "workflows", sourceName);
  const dstDir = join(home, "workflows", targetName);

  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error("source workflow not found");
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
