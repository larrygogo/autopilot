import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
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
  // 用 path.sep 跨平台：Windows 是 "\\"，POSIX 是 "/"
  if (!templateDir.startsWith(workflowDir + sep) && templateDir !== workflowDir) {
    return null;
  }
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    return null;
  }
  return templateDir;
}

// ──────────────────────────────────────────────
// Workspace 浏览 API —— 用于 UI 文件树 / 预览 / 下载
// ──────────────────────────────────────────────

export interface WorkspaceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

/**
 * 把用户传入的相对路径安全解析到 workspace 下的绝对路径。
 * 防越界：解析后必须仍位于 workspace 根目录下；拒绝含 NUL 字符的路径。
 * @returns 绝对路径或 null（路径非法）
 */
export function resolveWorkspacePath(taskId: string, relPath: string): string | null {
  const ws = getTaskWorkspace(taskId);
  const root = resolve(ws);
  if (relPath.includes("\0")) return null;
  const trimmed = relPath.replace(/^[/\\]+/, "");
  const candidate = resolve(root, trimmed || ".");
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * 列目录直接子项（单层，按名称字典序）。目录不存在时抛错。
 */
export function listWorkspaceDir(taskId: string, relPath: string): WorkspaceEntry[] {
  const abs = resolveWorkspacePath(taskId, relPath);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("路径不存在");
  const info = statSync(abs);
  if (!info.isDirectory()) throw new Error("不是目录");

  const entries: WorkspaceEntry[] = [];
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        entries.push({ name, type: "dir" });
      } else if (s.isFile()) {
        entries.push({ name, type: "file", size: s.size, mtime: s.mtimeMs });
      }
      // 跳过符号链接和特殊文件
    } catch { /* 忽略不可访问项 */ }
  }
  // 目录优先 + 名称排序
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export interface WorkspaceFileInfo {
  content: string;
  /** 若为二进制（非 UTF-8 可解码）则为 true，content 为空 */
  binary: boolean;
  size: number;
  truncated: boolean;
}

/** 单文件读取上限，超过只返回元信息让用户下载 */
export const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

/**
 * 读取文件供 UI 预览。超过上限不读内容；二进制检测失败返回空 content。
 */
export function readWorkspaceFile(taskId: string, relPath: string): WorkspaceFileInfo {
  const abs = resolveWorkspacePath(taskId, relPath);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("文件不存在");
  const info = statSync(abs);
  if (info.isDirectory()) throw new Error("路径是目录");
  const size = info.size;
  if (size > MAX_PREVIEW_BYTES) {
    return { content: "", binary: false, size, truncated: true };
  }
  const buf = readFileSync(abs);
  // 二进制检测：含 NUL 或 UTF-8 decode 失败视为二进制
  if (buf.includes(0)) {
    return { content: "", binary: true, size, truncated: false };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { content: text, binary: false, size, truncated: false };
  } catch {
    return { content: "", binary: true, size, truncated: false };
  }
}

/**
 * 用 `zip` 命令流式压缩整个 workspace。
 * 没装 zip 命令时抛错。调用方负责把 stdout 流包装成 Response。
 */
export function spawnWorkspaceZip(taskId: string): ReturnType<typeof Bun.spawn> {
  const ws = getTaskWorkspace(taskId);
  if (!existsSync(ws)) throw new Error("workspace 不存在");
  return Bun.spawn(["zip", "-r", "-q", "-", "."], {
    cwd: ws,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * 计算任务 workspace 磁盘占用（递归）。
 * 跳过不可 stat 项，静默忽略错误。
 */
export function workspaceSize(taskId: string): number {
  const ws = getTaskWorkspace(taskId);
  if (!existsSync(ws)) return 0;
  return dirSizeBytes(ws);
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const s = statSync(full);
        if (s.isDirectory()) total += dirSizeBytes(full);
        else if (s.isFile()) total += s.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

/**
 * 删除任务 workspace 目录。返回是否真的删除过。
 * logs / agent-calls.jsonl 等元数据不受影响（保留在 runtime/tasks/<id>/ 顶层）。
 */
export function deleteTaskWorkspace(taskId: string): boolean {
  const ws = getTaskWorkspace(taskId);
  if (!existsSync(ws)) return false;
  rmSync(ws, { recursive: true, force: true });
  return true;
}

/**
 * 彻底删除任务运行时目录（`runtime/tasks/<task-id>/` 全部内容，包括 workspace、
 * logs、events、agent-calls、task-manifest.json）。用于"删除任务"路径。
 */
export function deleteTaskRuntimeDir(taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  const dir = join(AUTOPILOT_HOME, "runtime", "tasks", taskId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 扫描所有任务的 workspace 目录，返回每个任务的占用信息。
 * 用于 Dashboard 汇总 + 清理规则判断。
 */
export interface TaskWorkspaceUsage {
  taskId: string;
  size: number;
  mtime: number;
  exists: boolean;
}

export interface RetentionPolicy {
  /** 终态任务 workspace 保留天数；<=0 表示永久保留 */
  days?: number;
  /** 保留磁盘占用上限 MB；超出则按 mtime 从旧到新删，直到低于上限 */
  max_total_mb?: number;
}

/**
 * 从全局 config 读 workspace_retention 段。
 */
export function loadRetentionPolicy(): RetentionPolicy {
  try {
    // 延迟 import 避免循环
    const { loadConfig } = require("./config") as typeof import("./config");
    const raw = loadConfig();
    const section = raw["workspace_retention"];
    if (!section || typeof section !== "object") return {};
    return section as RetentionPolicy;
  } catch { return {}; }
}

/**
 * 应用保留策略清理 workspace：按 (a) 超过 days 的任务 (b) 总占用超 max_total_mb
 * 的老任务清 workspace。返回被清理的 taskId 列表。
 * 仅清 workspace 目录，不动 logs / agent-calls / DB 记录。
 */
export function applyRetentionPolicy(
  policy: RetentionPolicy,
  opts?: { isTerminal?: (taskId: string) => boolean; now?: number },
): { removed: string[]; reclaimedBytes: number } {
  const now = opts?.now ?? Date.now();
  const all = scanTaskWorkspaces().filter((u) => u.exists && u.size > 0);

  const removed: string[] = [];
  let reclaimed = 0;

  const doRemove = (u: TaskWorkspaceUsage) => {
    if (deleteTaskWorkspace(u.taskId)) {
      removed.push(u.taskId);
      reclaimed += u.size;
    }
  };

  // (a) 按天数清终态任务
  if (typeof policy.days === "number" && policy.days > 0) {
    const threshold = now - policy.days * 86400 * 1000;
    for (const u of all) {
      if (u.mtime && u.mtime < threshold) {
        if (!opts?.isTerminal || opts.isTerminal(u.taskId)) {
          doRemove(u);
        }
      }
    }
  }

  // (b) 总占用超限时，按 mtime 旧→新再删
  if (typeof policy.max_total_mb === "number" && policy.max_total_mb > 0) {
    const maxBytes = policy.max_total_mb * 1024 * 1024;
    let remaining = all.filter((u) => !removed.includes(u.taskId));
    let total = remaining.reduce((a, it) => a + it.size, 0);
    if (total > maxBytes) {
      remaining.sort((a, b) => a.mtime - b.mtime);
      for (const u of remaining) {
        if (total <= maxBytes) break;
        if (!opts?.isTerminal || opts.isTerminal(u.taskId)) {
          doRemove(u);
          total -= u.size;
        }
      }
    }
  }

  return { removed, reclaimedBytes: reclaimed };
}

export function scanTaskWorkspaces(): TaskWorkspaceUsage[] {
  const root = join(AUTOPILOT_HOME, "runtime", "tasks");
  if (!existsSync(root)) return [];
  const out: TaskWorkspaceUsage[] = [];
  for (const taskId of readdirSync(root)) {
    const ws = join(root, taskId, "workspace");
    if (!existsSync(ws)) {
      out.push({ taskId, size: 0, mtime: 0, exists: false });
      continue;
    }
    try {
      const s = statSync(ws);
      out.push({ taskId, size: dirSizeBytes(ws), mtime: s.mtimeMs, exists: true });
    } catch {
      out.push({ taskId, size: 0, mtime: 0, exists: false });
    }
  }
  return out;
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
