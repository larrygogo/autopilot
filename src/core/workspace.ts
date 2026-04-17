import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 任务 workspace —— 每次任务独立的沙盒目录
//
// 布局：
//   AUTOPILOT_HOME/
//     runtime/tasks/<task-id>/
//       └── workspace/         ← 阶段函数的工作区（本模块管理）
//
// 工作流可在 workflow.yaml 声明：
//   workspace:
//     template: workspace_template   # 可选，相对于工作流目录
// 如有 template，任务创建时自动 cp -r 到 workspace/。
// ──────────────────────────────────────────────

const TASK_ID_RE = /^[\w.\-]+$/;

export interface WorkspaceConfig {
  /** 模板目录名（相对于 workflow 目录），默认 undefined = 空 workspace */
  template?: string;
  /** 保留给 W3：是否 git init。当前未实现。 */
  git?: boolean;
}

/**
 * 获取任务 workspace 的绝对路径（不保证存在）。
 */
export function getTaskWorkspace(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "workspace");
}

/**
 * 确保 workspace 目录存在；若工作流声明了 template 且 workspace 为空则复制。
 * 幂等：已存在非空 workspace 时不会覆盖用户数据。
 *
 * @param taskId 任务 ID
 * @param workflowName 工作流名（决定 template 查找路径）
 * @param workspaceConfig 工作流 workflow.yaml 里的 workspace 段（可选）
 * @returns workspace 绝对路径
 */
export function ensureTaskWorkspace(
  taskId: string,
  workflowName: string,
  workspaceConfig?: WorkspaceConfig,
): string {
  const wsPath = getTaskWorkspace(taskId);

  const alreadyPopulated = existsSync(wsPath) && readdirSync(wsPath).length > 0;
  if (alreadyPopulated) {
    return wsPath;
  }

  mkdirSync(wsPath, { recursive: true });

  // 处理 template
  const templateName = workspaceConfig?.template;
  if (templateName) {
    const templateDir = resolveTemplate(workflowName, templateName);
    if (templateDir) {
      copyDirRecursive(templateDir, wsPath);
      log.info("已从 template %s 初始化 workspace [task=%s path=%s]",
        templateName, taskId, wsPath);
    } else {
      log.warn("workflow.yaml 指定 template=%s 但未找到目录；workspace 为空 [task=%s]",
        templateName, taskId);
    }
  }

  return wsPath;
}

/**
 * 解析 template 目录：workflow.yaml 中的 template 字段相对工作流目录。
 * 为防止目录穿越，解析后的路径必须仍在工作流目录内。
 */
function resolveTemplate(workflowName: string, templateName: string): string | null {
  // 禁止绝对路径或 .. 穿越
  if (templateName.startsWith("/") || templateName.includes("..")) {
    return null;
  }
  const workflowDir = join(AUTOPILOT_HOME, "workflows", workflowName);
  const templateDir = resolve(workflowDir, templateName);
  if (!templateDir.startsWith(workflowDir + "/") && templateDir !== workflowDir) {
    return null;
  }
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    return null;
  }
  return templateDir;
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const info = statSync(s);
    if (info.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (info.isFile()) {
      copyFileSync(s, d);
    }
    // 跳过符号链接 / 特殊文件（避免安全风险）
  }
}
