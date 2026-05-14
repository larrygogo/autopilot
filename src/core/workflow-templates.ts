/**
 * 工作流模板管理：扫描 examples/workflows/* 目录，让用户从内置模板克隆出自己的工作流。
 *
 * - 模板源：项目仓库内 `examples/workflows/<name>/` 目录
 * - 目标：`AUTOPILOT_HOME/workflows/<new-name>/`
 * - 克隆 = 递归拷贝目录（含 workflow.yaml + workflow.ts + 任意附属文件）
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

export interface WorkflowTemplate {
  /** 模板名（目录名，如 "dev" / "req_dev"） */
  name: string;
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
      const description = typeof parsed.description === "string" ? parsed.description : "";
      const phases = Array.isArray(parsed.phases) ? parsed.phases : [];
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      result.push({
        name: entry,
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
