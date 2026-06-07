import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 任务 sandbox —— 每次任务独立的沙盒目录
//
// 布局：
//   AUTOPILOT_HOME/
//     runtime/tasks/<task-id>/
//       ├── workspace/         ← 阶段函数的沙盒目录（本模块管理；物理目录名保持 workspace 不变）
//       └── .worktree.json     ← git worktree 元数据（仅 sandbox.git=true 时）
//
// 工作流可在 workflow.yaml 声明：
//   sandbox:
//     template: workspace_template   # 可选，相对于工作流目录
//     git: true                      # 启用 git worktree 模式（基于 workspace 临时分支）
//     branch_prefix: "autopilot/"    # worktree 分支名前缀（默认 autopilot/）
//     base: "main"                   # 派生 base 分支（默认 workspace.default_branch）
// template 与 git 互斥：同时配置时 git 优先，template 忽略 + warn。
// 非 git 仓库 workspace / 缺 workspace → warn 退化空目录，不阻塞任务启动。
// ──────────────────────────────────────────────

const TASK_ID_RE = /^[\w.\-]+$/;
const WORKTREE_MANIFEST = ".worktree.json";

export interface SandboxConfig {
  /** 模板目录名（相对于 workflow 目录），默认 undefined = 空 sandbox */
  template?: string;
  /** 启用 git worktree 模式（基于 workspace 临时分支沙盒） */
  git?: boolean;
  /** worktree 分支名前缀，默认 "autopilot/" */
  branch_prefix?: string;
  /** 派生 base 分支，默认 workspace.default_branch */
  base?: string;
}

/** 创建 sandbox（独立 clone）时传入的 workspace 信息（caller 反查后传入，sandbox.ts 不依赖 workspaces.ts） */
export interface WorkspaceRef {
  id: string;
  path: string;
  default_branch: string;
  /** GitHub owner/repo：用于把 clone 的 origin 从本地路径改写成 GitHub url（push/PR 用） */
  github_owner?: string | null;
  github_repo?: string | null;
}

/**
 * task sandbox 走 git worktree 时记录在 .worktree.json 的元数据。
 *
 * 这些字段是纯操作性元数据，仅用于删除时定位 git 目录（不参与任何 DB 查询/FK join），
 * codebase→workspace 改名后字段名改为 workspace_*。读取时兼容 Phase 2 之前写下的旧文件
 * （旧字段名 codebase_id/codebase_path、旧 id 前缀 cb-）见 readWorktreeMeta()。
 */
export interface WorktreeMeta {
  workspace_id: string;
  workspace_path: string;
  branch: string;
  base: string;
  created_at: number;
  /** 沙盒模式：clone=独立克隆（删除纯 rmSync，不碰源仓库）；缺省/worktree=老 git worktree 数据 */
  mode?: "clone" | "worktree";
  /** clone 模式 push 的目标远程 url（GitHub）；null 表示无远程，submit_pr 会失败 */
  remote_url?: string | null;
}

/** .worktree.json 磁盘原文形态：可能是新字段（workspace_*）或 Phase 2 前的旧字段（codebase_*）。 */
interface WorktreeMetaRaw {
  workspace_id?: string;
  workspace_path?: string;
  codebase_id?: string;
  codebase_path?: string;
  branch: string;
  base: string;
  created_at: number;
  mode?: "clone" | "worktree";
  remote_url?: string | null;
}


/**
 * 获取任务 sandbox 的绝对路径（不保证存在）。
 * 物理目录名保持 `workspace`，与历史磁盘布局兼容。
 */
export function getTaskSandbox(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "workspace");
}

/**
 * 确保 sandbox 目录存在；按 workflow.yaml 的 sandbox 段配置选择初始化方式：
 *   - git=true + 提供 workspace 信息 → git worktree 模式（在 workspace 临时分支上工作）
 *   - template=xxx → 拷贝模板目录
 *   - 其余 → 空目录
 *
 * 幂等：已存在非空 sandbox 时不会覆盖用户数据。
 * 退化策略：worktree 创建失败（workspace 非 git / 命令失败）→ warn + 空目录，不抛错。
 *
 * @param taskId 任务 ID
 * @param workflowName 工作流名（决定 template 查找路径）
 * @param sandboxConfig 工作流 workflow.yaml 里的 sandbox 段（可选）
 * @param workspace git worktree 模式所需的 workspace 信息（caller 反查后传入；不传 + git=true 时退化）
 * @returns sandbox 绝对路径（无论 worktree 是否成功 — 失败会退化为空目录）。
 *   worktree 元数据通过 getTaskWorktreeMeta(taskId) 单独读取。
 */
export function ensureTaskSandbox(
  taskId: string,
  workflowName: string,
  sandboxConfig?: SandboxConfig,
  workspace?: WorkspaceRef,
  deliverBranch?: string,
): string {
  const wsPath = getTaskSandbox(taskId);

  // 幂等：已存在非空 sandbox 直接返回
  const alreadyPopulated = existsSync(wsPath) && readdirSync(wsPath).length > 0;
  if (alreadyPopulated) return wsPath;

  // git 沙盒模式：独立 clone（template 与 git 互斥，git=true 时忽略 template）
  if (sandboxConfig?.git) {
    if (sandboxConfig.template) {
      log.warn("sandbox.git=true 与 template=%s 互斥，忽略 template [task=%s]",
        sandboxConfig.template, taskId);
    }
    const wt = tryCreateClone(taskId, sandboxConfig, workspace, wsPath, deliverBranch);
    if (wt) return wsPath;
    // 退化：clone 创建失败 → 空目录
    if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });
    return wsPath;
  }

  mkdirSync(wsPath, { recursive: true });

  // 处理 template
  const templateName = sandboxConfig?.template;
  if (templateName) {
    const templateDir = resolveTemplate(workflowName, templateName);
    if (templateDir) {
      copyDirRecursive(templateDir, wsPath);
      log.info("已从 template %s 初始化 sandbox [task=%s path=%s]",
        templateName, taskId, wsPath);
    } else {
      log.warn("workflow.yaml 指定 template=%s 但未找到目录；sandbox 为空 [task=%s]",
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
 * 为 task 创建独立 clone 沙盒。成功返回 WorktreeMeta(mode=clone)，失败 warn + 返回 null（caller 退化空目录）。
 *
 * 核心：用户仓库**全程零痕迹**——源仓库只被 `git clone --local` 只读一次，之后零交互，
 * 删除时纯 rmSync（不跑任何 `git -C <源仓库>`）。不再在源仓库 .git 留 worktree 注册 / 临时分支。
 *
 * 步骤：
 *   1. 校验 workspace 是 git 仓库
 *   2. git clone --local <workspace.path> <wsPath>（硬链接 object，快省空间）
 *   3. 修正 origin → GitHub url（--local origin 指本地路径，否则 push 推回本地仓库）
 *   4. fetch origin 最新 base，基于 origin/<base> 建交付分支（fetch 失败回退本地 base）
 *   5. 写 .worktree.json（mode=clone）让删除路径自包含
 */
function tryCreateClone(
  taskId: string,
  cfg: SandboxConfig,
  workspace: WorkspaceRef | undefined,
  wsPath: string,
  deliverBranch?: string,
): WorktreeMeta | null {
  if (!workspace) {
    log.warn("sandbox.git=true 但未提供 workspace（task.extra 无 workspace_id？）；退化空目录 [task=%s]", taskId);
    return null;
  }
  if (!existsSync(join(workspace.path, ".git"))) {
    log.warn("sandbox.git=true 但 workspace %s 不是 git 仓库（%s/.git 不存在）；退化空目录 [task=%s]",
      workspace.id, workspace.path, taskId);
    return null;
  }
  const base = cfg.base ?? workspace.default_branch;
  const branch = deliverBranch ?? `${cfg.branch_prefix ?? "autopilot/"}${taskId}`;

  // 目标目录必须不存在（git clone 要求）；父目录要在
  const parent = join(wsPath, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });

  // 1. 本地硬链接 clone —— 源仓库只读，零写入（不碰源 .git 的分支/worktree 注册）
  const cl = Bun.spawnSync(["git", "clone", "--local", workspace.path, wsPath], { stdout: "pipe", stderr: "pipe" });
  if (cl.exitCode !== 0) {
    const stderr = cl.stderr ? new TextDecoder().decode(cl.stderr) : "";
    log.warn("git clone --local 失败 [task=%s workspace=%s exit=%d]: %s",
      taskId, workspace.id, cl.exitCode, stderr.slice(0, 300));
    return null;
  }

  // 2. 修正 origin → GitHub（--local 的 origin 指向本地路径，push 会推回本地仓库而非远程）
  const remoteUrl = resolveRemoteUrl(workspace);
  if (remoteUrl) {
    Bun.spawnSync(["git", "-C", wsPath, "remote", "set-url", "origin", remoteUrl], { stderr: "pipe" });
  }

  // 3. 基于 base 建交付分支。clone --local 已带源仓库所有本地 ref（含 base），
  //    用本地 base 快照（dogfood 时源仓库本地即最新），run 阶段 diff <base>...HEAD 准确。
  const co = Bun.spawnSync(["git", "-C", wsPath, "checkout", "-B", branch, base], { stderr: "pipe" });
  if (co.exitCode !== 0) {
    const stderr = co.stderr ? new TextDecoder().decode(co.stderr) : "";
    log.warn("clone 后建交付分支失败 [task=%s branch=%s base=%s]: %s", taskId, branch, base, stderr.slice(0, 200));
    // 不致命：工作树仍在 clone 默认分支，run 阶段尽量跑
  }

  const meta: WorktreeMeta = {
    workspace_id: workspace.id,
    workspace_path: workspace.path,
    branch,
    base,
    created_at: Date.now(),
    mode: "clone",
    remote_url: remoteUrl ?? null,
  };
  writeWorktreeMeta(taskId, meta);
  log.info("独立 clone 创建 [task=%s workspace=%s branch=%s base=%s remote=%s ws=%s]",
    taskId, workspace.id, branch, base, remoteUrl ?? "(本地无远程)", wsPath);
  return meta;
}

/** 解析 clone 的 push 目标远程 url：优先 workspace 的 GitHub owner/repo，回退源仓库 origin（只读）。 */
function resolveRemoteUrl(ws: WorkspaceRef): string | null {
  if (ws.github_owner && ws.github_repo) {
    return `https://github.com/${ws.github_owner}/${ws.github_repo}.git`;
  }
  const p = Bun.spawnSync(["git", "-C", ws.path, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode === 0) {
    const u = new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim();
    if (u) return u;
  }
  return null;
}

function pickUniqueBranchName(workspacePath: string, prefix: string, taskId: string): string {
  const base = `${prefix}${taskId}`;
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const proc = Bun.spawnSync(["git", "-C", workspacePath, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], {
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
    const raw = JSON.parse(readFileSync(p, "utf8")) as WorktreeMetaRaw;
    // 兼容 Phase 2 之前写下的旧 .worktree.json（字段 codebase_id/codebase_path）。
    // 仅用于删除时定位 git 目录，不参与任何 DB 查询，旧 cb- 前缀 id 也无需转换。
    const workspace_id = raw.workspace_id ?? raw.codebase_id;
    const workspace_path = raw.workspace_path ?? raw.codebase_path;
    if (!workspace_id || !workspace_path) return null;
    return {
      workspace_id, workspace_path, branch: raw.branch, base: raw.base, created_at: raw.created_at,
      mode: raw.mode, remote_url: raw.remote_url,
    };
  } catch { return null; }
}

function writeWorktreeMeta(taskId: string, meta: WorktreeMeta): void {
  const p = worktreeMetaPath(taskId);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2));
}

/**
 * 移除任务沙盒的 git 元数据。
 *
 * - clone 模式（mode=clone）：**零碰源仓库** —— 只清 .worktree.json，沙盒目录交给上游 rmSync。
 *   这是"用户仓库零痕迹"的代码级护栏：独立 clone 的删除绝不跑任何 `git -C <源仓库>`。
 * - 老 worktree 数据（无 mode）：向后兼容，仍 `git worktree remove --force` 清掉源仓库的 worktree 注册。
 * - .worktree.json 不存在 → no-op 返回 false。
 */
export function removeTaskWorktree(taskId: string): boolean {
  const meta = readWorktreeMeta(taskId);
  if (!meta) return false;

  // clone 模式：源仓库零接触，删除纯靠 rmSync（上游 deleteTaskSandbox 做）
  if (meta.mode === "clone") {
    try { rmSync(worktreeMetaPath(taskId), { force: true }); } catch { /* ignore */ }
    return true;
  }

  // 老 worktree 数据：清源仓库的 worktree 注册（向后兼容历史 task）
  const wsPath = getTaskSandbox(taskId);
  const proc = Bun.spawnSync(
    ["git", "-C", meta.workspace_path, "worktree", "remove", "--force", wsPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    log.warn("git worktree remove 失败（继续清理元数据）[task=%s ws=%s exit=%d]: %s",
      taskId, wsPath, proc.exitCode, stderr.slice(0, 300));
  } else {
    log.info("git worktree 移除 [task=%s workspace=%s branch=%s]", taskId, meta.workspace_id, meta.branch);
  }

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
// Sandbox 浏览 API —— 用于 UI 文件树 / 预览 / 下载
// ──────────────────────────────────────────────

export interface SandboxEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

/**
 * 把用户传入的相对路径安全解析到 sandbox 下的绝对路径。
 * 防越界：解析后必须仍位于 sandbox 根目录下；拒绝含 NUL 字符的路径。
 * @returns 绝对路径或 null（路径非法）
 */
export function resolveSandboxPath(taskId: string, relPath: string): string | null {
  const ws = getTaskSandbox(taskId);
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
export function listSandboxDir(taskId: string, relPath: string): SandboxEntry[] {
  const abs = resolveSandboxPath(taskId, relPath);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("路径不存在");
  const info = statSync(abs);
  if (!info.isDirectory()) throw new Error("不是目录");

  const entries: SandboxEntry[] = [];
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

export interface SandboxFileInfo {
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
export function readSandboxFile(taskId: string, relPath: string): SandboxFileInfo {
  const abs = resolveSandboxPath(taskId, relPath);
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
 * 用 `zip` 命令流式压缩整个 sandbox。
 * 没装 zip 命令时抛错。调用方负责把 stdout 流包装成 Response。
 */
export function spawnSandboxZip(taskId: string): ReturnType<typeof Bun.spawn> {
  const ws = getTaskSandbox(taskId);
  if (!existsSync(ws)) throw new Error("sandbox 不存在");
  return Bun.spawn(["zip", "-r", "-q", "-", "."], {
    cwd: ws,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * 计算任务 sandbox 磁盘占用（递归）。
 * 跳过不可 stat 项，静默忽略错误。
 */
export function sandboxSize(taskId: string): number {
  const ws = getTaskSandbox(taskId);
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
 * 删除任务 sandbox 目录。返回是否真的删除过。
 * 若 task 走的是 git worktree，先调 git worktree remove --force 让 workspace 干净，再 rmSync 兜底。
 * logs / agent-calls.jsonl 等元数据不受影响（保留在 runtime/tasks/<id>/ 顶层）。
 */
export function deleteTaskSandbox(taskId: string): boolean {
  // 先尝试 worktree 移除（若是 worktree task；非 worktree 直接 no-op 返回 false）
  // worktree 模式下 git worktree remove 会同步删 ws 目录，无需再 rmSync。
  const removedWorktree = removeTaskWorktree(taskId);
  const ws = getTaskSandbox(taskId);
  if (existsSync(ws)) {
    rmSync(ws, { recursive: true, force: true });
    return true;
  }
  return removedWorktree;
}

/**
 * 彻底删除任务运行时目录（`runtime/tasks/<task-id>/` 全部内容，包括 sandbox、
 * logs、events、agent-calls、task-manifest.json）。用于"删除任务"路径。
 * 若 task 走 worktree，先清 worktree 让 workspace 干净。
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
 * 扫描所有任务的 sandbox 目录，返回每个任务的占用信息。
 * 用于 Dashboard 汇总 + 清理规则判断。
 */
export interface TaskSandboxUsage {
  taskId: string;
  size: number;
  mtime: number;
  exists: boolean;
}

export interface RetentionPolicy {
  /** 终态任务 sandbox 保留天数；<=0 表示永久保留 */
  days?: number;
  /** 保留磁盘占用上限 MB；超出则按 mtime 从旧到新删，直到低于上限 */
  max_total_mb?: number;
}

/**
 * 从全局 config 读 sandbox_retention 段。
 * 兼容：优先读 sandbox_retention，回退老字段 workspace_retention 并打 deprecation warning。
 */
export function loadRetentionPolicy(): RetentionPolicy {
  try {
    // 延迟 import 避免循环
    const { loadConfig } = require("./config") as typeof import("./config");
    const raw = loadConfig();
    let section = raw["sandbox_retention"];
    if (
      (!section || typeof section !== "object") &&
      raw["workspace_retention"] &&
      typeof raw["workspace_retention"] === "object"
    ) {
      log.warn("config.yaml 的 `workspace_retention` 已更名为 `sandbox_retention`，请尽快迁移（本次回退读老字段）");
      section = raw["workspace_retention"];
    }
    if (!section || typeof section !== "object") return {};
    return section as RetentionPolicy;
  } catch { return {}; }
}

/**
 * 应用保留策略清理 sandbox：按 (a) 超过 days 的任务 (b) 总占用超 max_total_mb
 * 的老任务清 sandbox。返回被清理的 taskId 列表。
 * 仅清 sandbox 目录，不动 logs / agent-calls / DB 记录。
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
  const all = scanTaskSandboxes(tasksRoot).filter((u) => u.exists && u.size > 0);

  const removed: string[] = [];
  let reclaimed = 0;

  const doRemove = (u: TaskSandboxUsage) => {
    const ws = join(tasksRoot, u.taskId, "workspace");
    if (!existsSync(ws)) return;
    // 若是 worktree task，先 git worktree remove --force 让 workspace 干净（spec §3.4：
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
 * 扫所有任务 sandbox 大小 + mtime。
 * 可注入 root 让测试用 tmpdir；默认 AUTOPILOT_HOME/runtime/tasks。
 */
export function scanTaskSandboxes(rootOverride?: string): TaskSandboxUsage[] {
  const root = rootOverride ?? join(AUTOPILOT_HOME, "runtime", "tasks");
  if (!existsSync(root)) return [];
  const out: TaskSandboxUsage[] = [];
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
