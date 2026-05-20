import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 任务 workspace —— 每次任务独立的沙盒目录
//
// 布局：
//   AUTOPILOT_HOME/
//     runtime/tasks/<task-id>/
//       ├── workspace/         ← 阶段函数的工作区（本模块管理）
//       └── .worktree.json     ← git worktree 元数据（仅 workspace.git=true 时）
//
// 工作流可在 workflow.yaml 声明：
//   workspace:
//     template: workspace_template   # 可选，相对于工作流目录
//     git: true                      # 启用 git worktree 模式（基于 codebase 临时分支）
//     branch_prefix: "autopilot/"    # worktree 分支名前缀（默认 autopilot/）
//     base: "main"                   # 派生 base 分支（默认 codebase.default_branch）
// template 与 git 互斥：同时配置时 git 优先，template 忽略 + warn。
// 非 git 仓库 codebase / 缺 codebase → warn 退化空目录，不阻塞任务启动。
// ──────────────────────────────────────────────

const TASK_ID_RE = /^[\w.\-]+$/;
const WORKTREE_MANIFEST = ".worktree.json";

export interface WorkspaceConfig {
  /** 模板目录名（相对于 workflow 目录），默认 undefined = 空 workspace */
  template?: string;
  /** 启用 git worktree 模式（基于 codebase 临时分支沙盒） */
  git?: boolean;
  /** worktree 分支名前缀，默认 "autopilot/" */
  branch_prefix?: string;
  /** 派生 base 分支，默认 codebase.default_branch */
  base?: string;
}

/** 创建 worktree 时传入的 codebase 信息（caller 反查后传入，workspace.ts 不依赖 codebases.ts） */
export interface CodebaseRef {
  id: string;
  path: string;
  default_branch: string;
}

/** task workspace 走 git worktree 时记录在 .worktree.json 的元数据 */
export interface WorktreeMeta {
  codebase_id: string;
  codebase_path: string;
  branch: string;
  base: string;
  created_at: number;
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
 * 确保 workspace 目录存在；按 workspace.yaml 配置选择初始化方式：
 *   - git=true + 提供 codebase 信息 → git worktree 模式（在 codebase 临时分支上工作）
 *   - template=xxx → 拷贝模板目录
 *   - 其余 → 空目录
 *
 * 幂等：已存在非空 workspace 时不会覆盖用户数据。
 * 退化策略：worktree 创建失败（codebase 非 git / 命令失败）→ warn + 空目录，不抛错。
 *
 * @param taskId 任务 ID
 * @param workflowName 工作流名（决定 template 查找路径）
 * @param workspaceConfig 工作流 workflow.yaml 里的 workspace 段（可选）
 * @param codebase git worktree 模式所需的 codebase 信息（caller 反查后传入；不传 + git=true 时退化）
 * @returns workspace 绝对路径（无论 worktree 是否成功 — 失败会退化为空目录）。
 *   worktree 元数据通过 getTaskWorktreeMeta(taskId) 单独读取。
 */
export function ensureTaskWorkspace(
  taskId: string,
  workflowName: string,
  workspaceConfig?: WorkspaceConfig,
  codebase?: CodebaseRef,
): string {
  const wsPath = getTaskWorkspace(taskId);

  // 幂等：已存在非空 workspace 直接返回
  const alreadyPopulated = existsSync(wsPath) && readdirSync(wsPath).length > 0;
  if (alreadyPopulated) return wsPath;

  // git worktree 模式优先（template 与 git 互斥，git=true 时忽略 template）
  if (workspaceConfig?.git) {
    if (workspaceConfig.template) {
      log.warn("workspace.git=true 与 template=%s 互斥，忽略 template [task=%s]",
        workspaceConfig.template, taskId);
    }
    const wt = tryCreateWorktree(taskId, workspaceConfig, codebase, wsPath);
    if (wt) return wsPath;
    // 退化：worktree 创建失败 → 空目录
    if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });
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

/** 读取 task 的 worktree 元数据（若 task 走 git worktree 模式且 .worktree.json 存在）。 */
export function getTaskWorktreeMeta(taskId: string): WorktreeMeta | null {
  return readWorktreeMeta(taskId);
}

/**
 * 试图为 task 创建 git worktree。成功返回 WorktreeMeta，失败 warn + 返回 null（caller 退化空目录）。
 *
 * 步骤：
 *   1. 校验 codebase 已传入且 codebase.path/.git 是 git 仓库
 *   2. 计算 branch 名 ${branch_prefix}${taskId}，冲突附 -2 / -3 后缀（最多 10 次）
 *   3. git -C <codebase.path> worktree add -b <branch> <wsPath> <base>
 *   4. 写 .worktree.json 让删除路径自包含
 */
function tryCreateWorktree(
  taskId: string,
  cfg: WorkspaceConfig,
  codebase: CodebaseRef | undefined,
  wsPath: string,
): WorktreeMeta | null {
  if (!codebase) {
    log.warn("workspace.git=true 但未提供 codebase（task.extra 无 codebase_id？）；退化空目录 [task=%s]", taskId);
    return null;
  }
  if (!existsSync(join(codebase.path, ".git"))) {
    log.warn("workspace.git=true 但 codebase %s 不是 git 仓库（%s/.git 不存在）；退化空目录 [task=%s]",
      codebase.id, codebase.path, taskId);
    return null;
  }
  const prefix = cfg.branch_prefix ?? "autopilot/";
  const base = cfg.base ?? codebase.default_branch;

  // 计算唯一 branch 名（防止与 codebase 现有分支冲突）
  const branch = pickUniqueBranchName(codebase.path, prefix, taskId);

  // worktree 目录的父目录要存在（mkdir wsPath 父级），但 wsPath 本身 git worktree add 会创建
  const parent = join(wsPath, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  // wsPath 必须不存在或为空，否则 git worktree add 会拒绝
  if (existsSync(wsPath) && readdirSync(wsPath).length === 0) {
    rmSync(wsPath, { recursive: true, force: true });
  }

  const argv = ["git", "-C", codebase.path, "worktree", "add", "-b", branch, wsPath, base];
  const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    log.warn("git worktree add 失败 [task=%s codebase=%s branch=%s base=%s exit=%d]: %s",
      taskId, codebase.id, branch, base, proc.exitCode, stderr.slice(0, 300));
    return null;
  }

  const meta: WorktreeMeta = {
    codebase_id: codebase.id,
    codebase_path: codebase.path,
    branch,
    base,
    created_at: Date.now(),
  };
  writeWorktreeMeta(taskId, meta);
  log.info("git worktree 创建 [task=%s codebase=%s branch=%s base=%s ws=%s]",
    taskId, codebase.id, branch, base, wsPath);
  return meta;
}

function pickUniqueBranchName(codebasePath: string, prefix: string, taskId: string): string {
  const base = `${prefix}${taskId}`;
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const proc = Bun.spawnSync(["git", "-C", codebasePath, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // exitCode != 0 表示分支不存在 → 可以用
    if (proc.exitCode !== 0) return candidate;
  }
  // 10 次都冲突时取一个带时间戳的（极端情况，几乎不会触发）
  return `${base}-${Date.now()}`;
}

function worktreeMetaPath(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`非法 task ID：${taskId}`);
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, WORKTREE_MANIFEST);
}

function readWorktreeMeta(taskId: string): WorktreeMeta | null {
  const p = worktreeMetaPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as WorktreeMeta;
  } catch { return null; }
}

function writeWorktreeMeta(taskId: string, meta: WorktreeMeta): void {
  const p = worktreeMetaPath(taskId);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2));
}

/**
 * 移除任务的 git worktree（清掉 .worktree.json）。
 *
 * 调用 `git worktree remove --force <wsPath>`，无视未提交修改（spec §3.4：超过保留期还没提交就是垃圾）。
 * 若 .worktree.json 不存在（task 未走 worktree 模式）→ no-op 返回 false。
 *
 * @returns true 若执行了 git worktree remove；false 若 task 未走 worktree 或元数据缺失
 */
export function removeTaskWorktree(taskId: string): boolean {
  const meta = readWorktreeMeta(taskId);
  if (!meta) return false;
  const wsPath = getTaskWorkspace(taskId);

  const proc = Bun.spawnSync(
    ["git", "-C", meta.codebase_path, "worktree", "remove", "--force", wsPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    // 常见失败：worktree 已不存在 / 路径不在 codebase 里。仍然清掉 .worktree.json 让上游继续 rmSync。
    log.warn("git worktree remove 失败（继续清理元数据）[task=%s ws=%s exit=%d]: %s",
      taskId, wsPath, proc.exitCode, stderr.slice(0, 300));
  } else {
    log.info("git worktree 移除 [task=%s codebase=%s branch=%s]", taskId, meta.codebase_id, meta.branch);
  }

  // 清元数据文件（无论 git worktree remove 是否成功）
  try { rmSync(worktreeMetaPath(taskId), { force: true }); } catch { /* ignore */ }
  return proc.exitCode === 0;
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
 * 若 task 走的是 git worktree，先调 git worktree remove --force 让 codebase 干净，再 rmSync 兜底。
 * logs / agent-calls.jsonl 等元数据不受影响（保留在 runtime/tasks/<id>/ 顶层）。
 */
export function deleteTaskWorkspace(taskId: string): boolean {
  // 先尝试 worktree 移除（若是 worktree task；非 worktree 直接 no-op 返回 false）
  // worktree 模式下 git worktree remove 会同步删 ws 目录，无需再 rmSync。
  const removedWorktree = removeTaskWorktree(taskId);
  const ws = getTaskWorkspace(taskId);
  if (existsSync(ws)) {
    rmSync(ws, { recursive: true, force: true });
    return true;
  }
  return removedWorktree;
}

/**
 * 彻底删除任务运行时目录（`runtime/tasks/<task-id>/` 全部内容，包括 workspace、
 * logs、events、agent-calls、task-manifest.json）。用于"删除任务"路径。
 * 若 task 走 worktree，先清 worktree 让 codebase 干净。
 */
export function deleteTaskRuntimeDir(taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  removeTaskWorktree(taskId);
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
 *
 * 可注入 opts.tasksRoot 让测试用 tmpdir 模拟 AUTOPILOT_HOME；生产路径不传走默认。
 */
export function applyRetentionPolicy(
  policy: RetentionPolicy,
  opts?: {
    isTerminal?: (taskId: string) => boolean;
    now?: number;
    /** 显式指定 tasks 根目录（测试用 tmpdir），默认 AUTOPILOT_HOME/runtime/tasks */
    tasksRoot?: string;
  },
): { removed: string[]; reclaimedBytes: number } {
  const now = opts?.now ?? Date.now();
  const tasksRoot = opts?.tasksRoot ?? join(AUTOPILOT_HOME, "runtime", "tasks");
  const all = scanTaskWorkspaces(tasksRoot).filter((u) => u.exists && u.size > 0);

  const removed: string[] = [];
  let reclaimed = 0;

  const doRemove = (u: TaskWorkspaceUsage) => {
    const ws = join(tasksRoot, u.taskId, "workspace");
    if (!existsSync(ws)) return;
    // 若是 worktree task，先 git worktree remove --force 让 codebase 干净（spec §3.4：
    // 超过保留期还没提交就是垃圾，直接 force 干掉）。测试场景 tasksRoot 是 tmpdir 时
    // .worktree.json 不存在，removeTaskWorktree 是 no-op，不影响。
    if (tasksRoot === join(AUTOPILOT_HOME, "runtime", "tasks")) {
      try { removeTaskWorktree(u.taskId); } catch { /* ignore */ }
    }
    try {
      rmSync(ws, { recursive: true, force: true });
      removed.push(u.taskId);
      reclaimed += u.size;
    } catch { /* ignore */ }
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

/**
 * 扫所有任务 workspace 大小 + mtime。
 * 可注入 root 让测试用 tmpdir；默认 AUTOPILOT_HOME/runtime/tasks。
 */
export function scanTaskWorkspaces(rootOverride?: string): TaskWorkspaceUsage[] {
  const root = rootOverride ?? join(AUTOPILOT_HOME, "runtime", "tasks");
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
