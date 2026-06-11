import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join, resolve, sep } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { loadConfig } from "./config";
import { buildAuthUrl, resolveGitToken, GIT_NONINTERACTIVE_ENV } from "./workspace-health";

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
  /** 启用 git 代码沙盒：task 启动把 workspace 仓库 git clone --local 成独立共用 clone（源仓库零痕迹） */
  git?: boolean;
  /** worktree 分支名前缀，默认 "autopilot/" */
  branch_prefix?: string;
  /** 派生 base 分支，默认 workspace.default_branch */
  base?: string;
}

/** 创建 sandbox（独立 clone）时传入的 workspace 信息（caller 反查后传入，sandbox.ts 不依赖 workspaces.ts） */
export interface WorkspaceRef {
  id: string;
  /** 远程 clone URL（新模型主字段）；不含 token，token 在 clone 时动态注入 */
  remote_url: string;
  default_branch: string;
  github_owner?: string | null;
  github_repo?: string | null;
}

/** 多库沙盒（mode=multi-clone）中单个仓库的元数据 */
export interface WorktreeRepoMeta {
  workspace_id: string;
  alias: string;
  /** 相对 workspace/ 根的子目录名（由 alias 白名单化而来） */
  dir: string;
  branch: string;
  base: string;
  remote_url: string | null;
  primary?: boolean;
}

/**
 * task sandbox 走 git worktree 时记录在 .worktree.json 的元数据。
 *
 * 这些字段是纯操作性元数据，仅用于删除时定位 git 目录（不参与任何 DB 查询/FK join），
 * codebase→workspace 改名后字段名改为 workspace_*。读取时兼容 Phase 2 之前写下的旧文件
 * （旧字段名 codebase_id/codebase_path、旧 id 前缀 cb-）见 readWorktreeMeta()。
 *
 * 多库（mode=multi-clone）：repos 数组是真相，顶层 workspace_id/branch/base/remote_url
 * 镜像主库（旧 reader 不读 repos 也不炸）。单库任务不写 repos 字段、mode 仍是 clone
 * —— 与存量文件 byte 级兼容。
 */
export interface WorktreeMeta {
  workspace_id: string;
  workspace_path: string;
  branch: string;
  base: string;
  created_at: number;
  /** 沙盒模式：clone=独立克隆（删除纯 rmSync，不碰源仓库）；multi-clone=多库各自独立克隆；缺省/worktree=老 git worktree 数据 */
  mode?: "clone" | "multi-clone" | "worktree";
  /** clone 模式 push 的目标远程 url（GitHub）；null 表示无远程，submit_pr 会失败 */
  remote_url?: string | null;
  /** 多库布局（mode=multi-clone 时存在） */
  repos?: WorktreeRepoMeta[];
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
  mode?: "clone" | "multi-clone" | "worktree";
  remote_url?: string | null;
  repos?: WorktreeRepoMeta[];
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
 * task agent 的隔离 AUTOPILOT_HOME（L0 环境隔离）。
 *
 * agent 子进程跑 autopilot 命令时，AUTOPILOT_HOME 指向这个 task 专属空目录，而非用户真实
 * `~/.autopilot` —— agent 的验证类操作（如 `autopilot project create`）落在隔离 home 的空
 * DB / 无 daemon 上，污染不了用户真实数据。位于 task 目录下、git 工作树（workspace/）之外，
 * 不进 PR；随 task 沙盒一并清理。
 *
 * 注意：这是「运行时隔离」的轻量补丁（L0），非环境级隔离（L2 MicroVM/CubeSandbox）。
 */
export function getTaskAgentHome(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  const home = join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "agent-home");
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * 任务文件夹的产物根目录 `runtime/tasks/<id>/artifacts`（持久，跨 agent 累积）。
 *
 * 装这个任务所有中间产物：每个 phase 的文档/计划/报告（artifacts/NN-phase/）、agent 调用
 * 归档、累积 patch 链（artifacts/patches/）。**与代码工作树物理分离** —— 产物不再塞进代码
 * clone 的工作树根（旧做法靠 .git/info/exclude 防进 PR），从根上杜绝产物污染交付。
 * 「沙盒」tab 展示的就是这个目录。
 */
export function getTaskArtifactsDir(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  // 纯路径（不 mkdir）：浏览 / 算大小等只读用途不该产生副作用；写产物处各自 recursive mkdir。
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, "artifacts");
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
  workspace?: WorkspaceRef | WorkspaceRef[],
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
    // 多库（数组长度 >1）→ 子目录布局；单库（含单元素数组）→ 原路径零改动
    const wsArr = Array.isArray(workspace) ? workspace : workspace ? [workspace] : [];
    const wt = wsArr.length > 1
      ? tryCreateMultiClone(taskId, sandboxConfig, wsArr, wsPath, deliverBranch)
      : tryCreateClone(taskId, sandboxConfig, wsArr[0], wsPath, deliverBranch);
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
 * 为 task 创建独立远程 clone 沙盒。成功返回 WorktreeMeta(mode=clone)，失败 warn + 返回 null。
 *
 * 核心：直接从远程 git clone（完整 clone，不加 --depth）。
 * token 注入：HTTPS URL + config.yaml git.token 存在时，临时注入凭证到 clone URL，
 * clone 后的 .git/config origin 会带 token（push 时也生效）；SSH 走系统 key。
 *
 * 步骤：
 *   1. 读 git.token 配置，构建含凭证的 clone URL
 *   2. git clone <authUrl> <wsPath>（完整历史，无 --local / --depth）
 *   3. 基于 origin/<base> 建交付分支
 *   4. 写 .worktree.json（mode=clone）
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
  if (!workspace.remote_url) {
    log.warn("sandbox.git=true 但 workspace %s 无 remote_url（软失效工作区）；退化空目录 [task=%s]",
      workspace.id, taskId);
    return null;
  }

  const base = cfg.base ?? workspace.default_branch;
  const branch = deliverBranch ?? `${cfg.branch_prefix ?? "autopilot/"}${taskId}`;

  // 目标目录必须不存在（git clone 要求）；父目录要在
  const parent = join(wsPath, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });

  if (!cloneOneRepo(taskId, workspace, wsPath, base, branch)) return null;

  const meta: WorktreeMeta = {
    workspace_id: workspace.id,
    workspace_path: "",   // 远程 clone 模式无本地路径
    branch,
    base,
    created_at: Date.now(),
    mode: "clone",
    remote_url: workspace.remote_url,  // 存干净 URL（不含 token）
  };
  writeWorktreeMeta(taskId, meta);
  log.info("远程 clone 创建 [task=%s workspace=%s branch=%s base=%s remote=%s]",
    taskId, workspace.id, branch, base, workspace.remote_url);
  return meta;
}

/**
 * clone 单个仓库到 dest：token 注入 → 完整 clone → 去 token 覆盖 origin →
 * 基于 origin/<base> 建交付分支 → 写 .git/info/exclude。单库/多库共用。
 */
function cloneOneRepo(
  taskId: string,
  workspace: WorkspaceRef,
  dest: string,
  base: string,
  branch: string,
): boolean {
  if (!workspace.remote_url) return false;

  // token：config git.token > gh auth token 兜底（私有仓库），构建含凭证的 clone URL（HTTPS 注入；SSH 原样）
  let cloneUrl = workspace.remote_url;
  const cleanUrl = workspace.remote_url; // 不含 token 的干净 URL，clone 后覆盖 origin
  try {
    const gitToken = resolveGitToken();
    if (gitToken) {
      cloneUrl = buildAuthUrl(workspace.remote_url, gitToken);
    }
  } catch (e: unknown) {
    // token 解析失败仅 warn，不阻断 clone（无凭证的公开仓库可正常 clone）
    log.warn("解析 git token 失败，将尝试无凭证 clone [task=%s]: %s",
      taskId, e instanceof Error ? e.message : String(e));
  }

  // 完整 clone（无 --local / --depth）；非交互 env：凭证缺失快速失败不挂死
  const cl = Bun.spawnSync(["git", "clone", cloneUrl, dest], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
  });
  if (cl.exitCode !== 0) {
    const stderr = cl.stderr ? new TextDecoder().decode(cl.stderr) : "";
    // 脱敏：若 cloneUrl 含 token，从 stderr 中去除
    const safeStderr = cloneUrl !== workspace.remote_url
      ? stderr.replace(cloneUrl, workspace.remote_url)
      : stderr;
    log.warn("git clone 失败 [task=%s workspace=%s exit=%d]: %s",
      taskId, workspace.id, cl.exitCode, safeStderr.slice(0, 300));
    return false;
  }

  // clone 后立即覆盖 origin URL：去掉 token，防止凭证明文持久化在 .git/config
  if (cloneUrl !== cleanUrl) {
    Bun.spawnSync(["git", "-C", dest, "remote", "set-url", "origin", cleanUrl], { stderr: "pipe" });
  }

  // 基于 origin/<base> 建交付分支（完整 clone 后所有分支均作为 origin/<x> 可用）
  const baseRef = Bun.spawnSync(
    ["git", "-C", dest, "rev-parse", "--verify", "--quiet", `origin/${base}`],
    { stderr: "pipe" },
  ).exitCode === 0 ? `origin/${base}` : base;

  const co = Bun.spawnSync(["git", "-C", dest, "checkout", "-B", branch, baseRef], { stderr: "pipe" });
  if (co.exitCode !== 0) {
    const stderr = co.stderr ? new TextDecoder().decode(co.stderr) : "";
    log.warn("clone 后建交付分支失败 [task=%s branch=%s base=%s]: %s", taskId, branch, base, stderr.slice(0, 200));
    // 不致命：仍在克隆的默认分支，尽量跑
  }

  // .git/info/exclude：让阶段产物目录不进 PR
  try {
    const excludeFile = join(dest, ".git", "info", "exclude");
    if (existsSync(join(dest, ".git", "info"))) {
      appendFileSync(excludeFile, "\n# autopilot 阶段产物（不进交付 PR）\n/[0-9][0-9]-*/\n");
    }
  } catch { /* exclude 写失败不阻塞任务 */ }

  return true;
}

/** alias → 安全子目录名：白名单字符，非法/为空时回退 workspace id */
function safeAliasDir(alias: string, workspaceId: string): string {
  const cleaned = alias.replace(/[^\w.-]/g, "");
  if (cleaned && TASK_ID_RE.test(cleaned) && cleaned !== "." && cleaned !== "..") return cleaned;
  return workspaceId;
}

/**
 * 多代码库沙盒：各库 clone 到 workspace/<alias>/ 子目录，全库共用同名交付分支。
 * 任一 clone 失败 → 整体清掉退化空目录（半套布局比空目录更危险——agent 会只改一半还以为齐了）。
 * 主库 = workspaces[0]（caller 保证排序）。
 */
function tryCreateMultiClone(
  taskId: string,
  cfg: SandboxConfig,
  workspaces: Array<WorkspaceRef & { alias?: string }>,
  wsRoot: string,
  deliverBranch?: string,
): WorktreeMeta | null {
  const branch = deliverBranch ?? `${cfg.branch_prefix ?? "autopilot/"}${taskId}`;
  if (existsSync(wsRoot)) rmSync(wsRoot, { recursive: true, force: true });
  mkdirSync(wsRoot, { recursive: true });

  const repos: WorktreeRepoMeta[] = [];
  const usedDirs = new Set<string>();
  for (const ws of workspaces) {
    if (!ws.remote_url) {
      log.warn("多库沙盒：workspace %s 无 remote_url（软失效），整体退化空目录 [task=%s]", ws.id, taskId);
      rmSync(wsRoot, { recursive: true, force: true });
      return null;
    }
    let dir = safeAliasDir(ws.alias ?? ws.id, ws.id);
    if (usedDirs.has(dir)) dir = ws.id; // 目录名撞车回退 workspace id（项目内 alias 唯一，理论不撞）
    usedDirs.add(dir);
    const base = cfg.base ?? ws.default_branch;
    const dest = join(wsRoot, dir);
    if (!cloneOneRepo(taskId, ws, dest, base, branch)) {
      log.warn("多库沙盒：仓库 %s clone 失败，整体退化空目录 [task=%s]", ws.id, taskId);
      rmSync(wsRoot, { recursive: true, force: true });
      return null;
    }
    repos.push({
      workspace_id: ws.id,
      alias: ws.alias ?? ws.id,
      dir,
      branch,
      base,
      remote_url: ws.remote_url,
      primary: ws === workspaces[0],
    });
  }

  const p = repos[0];
  const meta: WorktreeMeta = {
    mode: "multi-clone",
    workspace_id: p.workspace_id,  // 顶层镜像主库：旧 reader 不读 repos 也不炸
    workspace_path: "",
    branch: p.branch,
    base: p.base,
    remote_url: p.remote_url,
    created_at: Date.now(),
    repos,
  };
  writeWorktreeMeta(taskId, meta);
  log.info("多库远程 clone 创建 [task=%s repos=%s branch=%s]",
    taskId, repos.map((r) => r.alias).join(","), branch);
  return meta;
}

/** 任务的代码仓库布局上下文（workflow 阶段函数消费的唯一布局接口） */
export interface TaskRepoCtx {
  workspace_id: string;
  alias: string;
  /** 该库 clone 的绝对路径（git 命令 cwd） */
  path: string;
  /** 相对 workspace/ 根的子目录；单库 = ""（即根本身） */
  dir: string;
  branch: string;
  base: string;
  remote_url: string | null;
  primary: boolean;
}

/**
 * 列出任务的代码仓库布局。多库（multi-clone meta）展开 repos；单库/旧任务返回
 * 单项指向 workspace/ 根；无 .worktree.json（非 git 工作流）返回 []。
 */
export function listTaskRepos(taskId: string): TaskRepoCtx[] {
  const meta = readWorktreeMeta(taskId);
  if (!meta) return [];
  const root = getTaskSandbox(taskId);
  if (meta.mode === "multi-clone" && meta.repos && meta.repos.length > 0) {
    return meta.repos.map((r) => ({
      workspace_id: r.workspace_id,
      alias: r.alias,
      path: join(root, r.dir),
      dir: r.dir,
      branch: r.branch,
      base: r.base,
      remote_url: r.remote_url,
      primary: r.primary === true,
    }));
  }
  return [{
    workspace_id: meta.workspace_id,
    alias: "",
    path: root,
    dir: "",
    branch: meta.branch,
    base: meta.base,
    remote_url: meta.remote_url ?? null,
    primary: true,
  }];
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
    // workspace_id 必须存在；workspace_path 在远程 clone 模式可为空字符串（只检查 undefined/null）
    if (!workspace_id || workspace_path == null) return null;
    return {
      workspace_id, workspace_path, branch: raw.branch, base: raw.base, created_at: raw.created_at,
      mode: raw.mode, remote_url: raw.remote_url, repos: raw.repos,
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
 * 重跑专属：删除任务在远程的交付分支（GitHub 会自动 close 关联的 OPEN PR）。
 *
 * 用于「重跑 = 干净重来」语义：让新一轮 push 到全新分支，从源头消除 non-fast-forward 冲突，
 * 无需 --force 覆盖远程。正常终态清理（deleteTaskSandbox）**不**调此函数 —— done 任务的
 * PR/分支要保留。
 *
 * 安全边界（守 CLAUDE.md「仓库零痕迹」+ 只动自有命名空间）：
 * - 仅 clone 模式生效（autopilot 独立副本）；
 * - 仅删 meta.branch（由 deliverBranchName 生成、记在 .worktree.json 的 autopilot 自有交付分支），
 *   且强制 `feat/` 前缀校验，绝不碰用户的其它分支；
 * - 用 gh api 删远程分支（重跑时共用 clone 可能已被删，故走 gh api 而非本地 push --delete；从 meta.remote_url
 *   解析 owner/repo），分支不存在 / 无凭证等一律容错（重跑继续，不阻断）。
 */
/**
 * gh api 删远程分支失败时，判断是否是「远程已无此分支」的良性 404（幂等成功）
 * 而非真失败（受保护/无凭证/网络）。用于 RERUN-07 区分。
 */
export function isBenignBranchDeleteError(stderr: string): boolean {
  // 只认明确的「ref 不存在」信号；不匹配裸 "no such"（会误吞网络错 "no such host"）。
  return /\bHTTP 404\b|\b404\b|reference does not exist|not found|no such ref/i.test(stderr);
}

export function deleteRemoteDeliverBranch(taskId: string): { deleted: boolean; branch?: string; failed?: boolean; error?: string } {
  const meta = readWorktreeMeta(taskId);
  if (!meta || (meta.mode !== "clone" && meta.mode !== "multi-clone") || !meta.branch) {
    return { deleted: false };
  }

  // 多库：逐库删（每库独立 feat/ 校验、独立良性 404 判定）；单库 = 长度 1 列表，行为不变
  const targets: Array<{ branch: string; remote_url: string | null; label: string }> =
    meta.mode === "multi-clone" && meta.repos && meta.repos.length > 0
      ? meta.repos.map((r) => ({ branch: r.branch, remote_url: r.remote_url, label: r.alias }))
      : [{ branch: meta.branch, remote_url: meta.remote_url ?? null, label: "" }];

  let anyDeleted = false;
  const errors: string[] = [];
  for (const t of targets) {
    const tag = t.label ? `[${t.label}] ` : "";
    if (!t.branch.startsWith("feat/")) {
      log.warn("跳过删远程分支：非 autopilot 交付分支命名空间 [task=%s %sbranch=%s]", taskId, tag, t.branch);
      continue;
    }
    // 从 remote_url 解析 owner/repo，用 gh api 删远程分支（重跑时本地 clone 可能已删，故走 gh api）。
    const m = (t.remote_url ?? "").match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) {
      log.warn("删远程分支跳过：无法从 remote 解析 owner/repo [task=%s %sremote=%s]", taskId, tag, t.remote_url ?? "");
      continue;
    }
    const proc = Bun.spawnSync(
      ["gh", "api", "-X", "DELETE", `repos/${m[1]}/${m[2]}/git/refs/heads/${t.branch}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode === 0) {
      log.info("删远程交付分支（重跑清旧轮，GitHub 自动 close 旧 PR）[task=%s %sbranch=%s]", taskId, tag, t.branch);
      anyDeleted = true;
      continue;
    }
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    // 区分良性 404（远程已无此分支 = 幂等成功，无需 push 冲突顾虑）与真失败（受保护/无凭证/
    // 网络）。真失败下重跑的普通 push 会撞已存在分支 → non-fast-forward，被判可恢复反复重试整
    // 条流水线 5 轮才 failed，根因对用户完全不可见（RERUN-07）。真失败 ERROR 级日志 + 回传
    // failed 让调用方 surface 到需求页。
    if (isBenignBranchDeleteError(stderr)) {
      log.info("删远程交付分支：远程已无此分支（幂等，重跑可继续）[task=%s %sbranch=%s]", taskId, tag, t.branch);
      continue;
    }
    log.error("删远程交付分支真失败（非 404；重跑后 push 可能因分支已存在冲突）[task=%s %sbranch=%s]: %s",
      taskId, tag, t.branch, stderr.slice(0, 200));
    errors.push(`${tag}${stderr.slice(0, 150)}`);
  }

  if (errors.length > 0) {
    return { deleted: anyDeleted, branch: meta.branch, failed: true, error: errors.join("; ").slice(0, 300) };
  }
  return { deleted: anyDeleted, branch: meta.branch };
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
/** 沙盒浏览的两个根：artifacts = 阶段产物归档；workspace = 代码 clone（agent 实际改代码的工作树）。 */
export type SandboxRoot = "artifacts" | "workspace";

export function resolveSandboxPath(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): string | null {
  const base = rootKind === "workspace" ? getTaskSandbox(taskId) : getTaskArtifactsDir(taskId);
  const root = resolve(base);
  if (relPath.includes("\0")) return null;
  const trimmed = relPath.replace(/^[/\\]+/, "");
  const candidate = resolve(root, trimmed || ".");
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * 列目录直接子项（单层，按名称字典序）。目录不存在时抛错。
 */
export function listSandboxDir(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): SandboxEntry[] {
  const abs = resolveSandboxPath(taskId, relPath, rootKind);
  if (!abs) throw new Error("非法路径");
  if (!existsSync(abs)) throw new Error("路径不存在");
  const info = statSync(abs);
  if (!info.isDirectory()) throw new Error("不是目录");

  const entries: SandboxEntry[] = [];
  for (const name of readdirSync(abs)) {
    // 代码树里隐藏 .git（巨大且无浏览价值；多库布局下各子目录层也适用；改动统计走验收 diff 视图）
    if (rootKind === "workspace" && name === ".git") continue;
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
export function readSandboxFile(taskId: string, relPath: string, rootKind: SandboxRoot = "artifacts"): SandboxFileInfo {
  const abs = resolveSandboxPath(taskId, relPath, rootKind);
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
  const ws = getTaskArtifactsDir(taskId);
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
  const ws = getTaskArtifactsDir(taskId);
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
 * 释放任务沙盒产物，回收磁盘。返回是否真的删除过任何内容。
 *
 * 共用沙盒模型下占盘的是 workspace/（共用代码 clone）与 artifacts/（产物文档）；.agent-runs/
 * 是旧即焚残留（已无人写，兼容删除）。logs / events / agent-calls / manifest 等元数据不受影响
 * （保留在 runtime/tasks/<id>/ 顶层）。
 *
 * 注意：会删 workspace/（共用代码 clone）。调用方（releaseTaskSandboxAction）须保证仅对终态任务
 * 执行，否则会删掉运行中任务正在改的代码。
 */
export function deleteTaskSandbox(taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  // 旧 worktree task：先 git worktree remove --force 让源仓库干净（独立 clone 模式下 no-op）。
  let removed = removeTaskWorktree(taskId);
  const taskRoot = join(AUTOPILOT_HOME, "runtime", "tasks", taskId);
  for (const target of [
    getTaskSandbox(taskId),       // workspace/（共用代码 clone）
    getTaskArtifactsDir(taskId),  // artifacts/（沙盒 tab 展示的产物文档）
    join(taskRoot, ".agent-runs"), // 旧即焚副本残留（兼容删除）
  ]) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
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
 * 清理任务的运行产物文件（logs 目录 / events / agent-calls），用于重跑重置。
 * 不动 sandbox（重跑单独 delete+rebuild）与 task-manifest.json。
 */
export function clearTaskRunArtifacts(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  const taskDir = join(AUTOPILOT_HOME, "runtime", "tasks", taskId);
  for (const name of ["logs", "agent-calls.jsonl", "events.jsonl"]) {
    const p = join(taskDir, name);
    try { if (existsSync(p)) rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
