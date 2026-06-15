import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { loadConfig } from "./config";
import { buildAuthUrl, resolveGitToken, GIT_NONINTERACTIVE_ENV } from "./workspace-health";
import { ensureCodebase, getRequirementCodebaseRoot, safeAliasDir } from "./codebase";
import { finalizeDeliveryClone } from "./git-clone";

// alias → 安全子目录名的实现已随 codebase 原语迁到 codebase.ts；保留 re-export 兼容既有 import
export { safeAliasDir } from "./codebase";

// ──────────────────────────────────────────────
// 任务 sandbox —— 每次任务独立的沙盒目录
//
// 布局（v2 R2 双根，getTaskRoot 解析）：
//   AUTOPILOT_HOME/
//     runtime/tasks/<task-id>/                          ← legacy 根（存量任务只读，零迁移）
//     runtime/requirements/<req-id>/
//       ├── codebase/<alias>/  ← v2 R4：代码 clone 归需求所有（ensureCodebase，codebase.ts）
//       ├── .codebase.json     ← clone 清单（真相）
//       └── runs/<task-id>/    ← 新根（2026-06-12 起新任务落此）
//           ├── workspace/     ← 非 git 工作流的沙盒目录（git 任务的沙盒根 = 需求级 codebase/，
//           │                     经 .worktree.json 的 repos_root="codebase" 重定向）
//           └── .worktree.json ← git clone 元数据镜像（repos[].dir 相对沙盒根，旧 reader 兼容）
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

/** AUTOPILOT_HOME 动态读 env（兜底 import 时常量）：保持 manifest / task-logs 等调用方的测试可注入性。 */
function autopilotHomeDir(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

/**
 * tasks 旧根目录（目录遍历 / retention 扫描的 legacy root）。
 * v2 R2 起为双根之一：存量任务原地只读；新任务落 requirements/<reqId>/runs/ 新根。
 */
function tasksRootDir(): string {
  return join(autopilotHomeDir(), "runtime", "tasks");
}

/** requirements 根目录（新根遍历入口：runtime/requirements/<reqId>/runs/<taskId>/）。 */
function requirementsRootDir(): string {
  return join(autopilotHomeDir(), "runtime", "requirements");
}

/** 某需求的 runs 目录（执行历史落点，v2 R2）。 */
function requirementRunsDir(reqId: string): string {
  return join(requirementsRootDir(), reqId, "runs");
}

/**
 * taskId → 运行时根目录缓存。任务目录归属不变（旧根存量只读、新根创建后不迁移），
 * 缓存安全；key 带 home 前缀防测试切换 AUTOPILOT_HOME 后串根。
 */
const taskRootCache = new Map<string, string>();

function rootCacheKey(taskId: string): string {
  return autopilotHomeDir() + "|" + taskId;
}

/** 仅测试用：清空 taskId→root 缓存。 */
export function _clearTaskRootCacheForTest(): void {
  taskRootCache.clear();
}

/**
 * 反查 task 的 requirement_id（getTaskRoot 新根定位用）。
 * 用惰性 require 而非顶层 import：静态 sandbox→db 会闭合 db→manifest→core/registry→
 * prompt-runner→agents/registry 的大环，模块初始化期触发 TDZ（实测全量测试炸 464 例）。
 * 首次调用时（模块图早已加载完）再解析，绕开初始化环；DB 不可用时返回 null 兜底 legacy。
 */
function lookupRequirementId(taskId: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require("./db") as typeof import("./db");
    return db.getTask(taskId)?.requirement_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 新 run 的目录归属种子（v2 R2）：把 taskId 的运行时根登记为
 * runtime/requirements/<reqId>/runs/<taskId>/。
 *
 * 必须在任务文件首次落盘**之前**调用（startTaskFromTemplate 里 ensureTaskSandbox 先于
 * createTask 执行，此刻 task 行还不在 DB，getTaskRoot 反查不到 requirement_id）。
 * legacy 根已存在时（存量任务）优先 legacy——两根互斥、存量只读零迁移。
 */
export function bindTaskRunRoot(taskId: string, reqId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`非法 task ID：${taskId}`);
  if (!TASK_ID_RE.test(reqId)) throw new Error(`非法 requirement ID：${reqId}`);
  const legacy = join(tasksRootDir(), taskId);
  if (existsSync(legacy)) {
    taskRootCache.set(rootCacheKey(taskId), legacy);
    return legacy;
  }
  const root = join(requirementRunsDir(reqId), taskId);
  taskRootCache.set(rootCacheKey(taskId), root);
  return root;
}

/**
 * 任务运行时根目录（v2 R2 双根解析，spec 2026-06-12-requirement-centric-runtime E1）：
 *   1. legacy 根 runtime/tasks/<id>/ 存在 → 用旧根（存量只读，零文件迁移）
 *   2. 否则按 task.requirement_id 落新根 runtime/requirements/<reqId>/runs/<id>/
 *   3. 反查不到（task 行未入库 / 无需求关联的历史游离任务）→ 兜底 legacy（不缓存，
 *      状态可能马上变化——新任务创建路径由 bindTaskRunRoot 显式种子，不依赖此兜底）
 */
export function getTaskRoot(taskId: string): string {
  const key = rootCacheKey(taskId);
  const cached = taskRootCache.get(key);
  if (cached) return cached;

  const legacy = join(tasksRootDir(), taskId);
  if (existsSync(legacy)) {
    taskRootCache.set(key, legacy);
    return legacy;
  }

  const reqId = lookupRequirementId(taskId);
  if (reqId && TASK_ID_RE.test(reqId)) {
    const root = join(requirementRunsDir(reqId), taskId);
    taskRootCache.set(key, root);
    return root;
  }
  return legacy;
}

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
  /** = 集合第一个（纯位置语义，主库概念已废除）；保留字段名防破坏存量 reader */
  primary?: boolean;
}

/**
 * task sandbox 走 git worktree 时记录在 .worktree.json 的元数据。
 *
 * 这些字段是纯操作性元数据，仅用于删除时定位 git 目录（不参与任何 DB 查询/FK join），
 * codebase→workspace 改名后字段名改为 workspace_*。读取时兼容 Phase 2 之前写下的旧文件
 * （旧字段名 codebase_id/codebase_path、旧 id 前缀 cb-）见 readWorktreeMeta()。
 *
 * 统一布局（2026-06-12 主库概念废除）：新任务一律 mode=multi-clone，repos 数组是真相
 * （单库 = 长度 1），顶层 workspace_id/branch/base/remote_url 镜像 repos[0]（防御未排查
 * 的历史 reader，不读 repos 也不炸）。mode=clone 是历史单库格式，reader 全保留。
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
  /**
   * v2 R4：repos 的物理根。"codebase" = 代码 clone 归需求所有
   * （runtime/requirements/<reqId>/codebase/），本文件只是镜像投影（旧 reader 兼容），
   * getTaskSandbox 据此把沙盒根重定向到需求级 codebase。缺省 = 任务自有 workspace/。
   */
  repos_root?: "codebase";
  /** repos_root=codebase 时记录归属需求（避免回查 DB） */
  requirement_id?: string;
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
  repos_root?: "codebase";
  requirement_id?: string;
}


/**
 * 获取任务 sandbox 的绝对路径（不保证存在）。
 *
 * - v2 R4 新 git 任务（.worktree.json 的 repos_root="codebase"）：返回需求级 codebase 根
 *   runtime/requirements/<reqId>/codebase/（多库容器目录，单库也在 ./alias/ 子目录）——
 *   代码 clone 归需求所有，任务沙盒只是它的视图。
 * - 其余（存量任务 / 非 git 工作流）：任务自有 `<taskRoot>/workspace`，
 *   物理目录名保持 `workspace`，与历史磁盘布局兼容。
 */
export function getTaskSandbox(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  const meta = readWorktreeMeta(taskId);
  if (meta?.repos_root === "codebase") {
    const reqId = meta.requirement_id ?? lookupRequirementId(taskId);
    if (reqId && TASK_ID_RE.test(reqId)) {
      return getRequirementCodebaseRoot(reqId);
    }
  }
  return join(getTaskRoot(taskId), "workspace");
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
  const home = join(getTaskRoot(taskId), "agent-home");
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
  return join(getTaskRoot(taskId), "artifacts");
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
  opts?: {
    /**
     * checkout 既有远程交付分支（fix run 续作模式，v2 R3）：clone 后不从 base 新建分支，
     * 而是 checkout origin/<deliverBranch>；远程无此分支（该库本轮无交付）→ 停在默认分支
     * 只读参考。缺省 false = 正常模式（从 base 新建交付分支）。
     */
    checkoutExisting?: boolean;
  },
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
    // 统一布局（主库概念废除）：凡 git 模式一律 multi-clone 子目录布局（单库 = 长度 1 repos）
    const wsArr = Array.isArray(workspace) ? workspace : workspace ? [workspace] : [];
    const wt = tryCreateMultiClone(taskId, sandboxConfig, wsArr, wsPath, deliverBranch, opts?.checkoutExisting === true);
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
 * v2 R4：git 工作流任务的沙盒供给 —— 代码 clone 归需求所有。
 *
 * 经 ensureCodebase(fidelity="full") 把需求代码库集合落到
 * runtime/requirements/<reqId>/codebase/<alias>/（澄清浅 clone 原地升级 = 删除重 clone；
 * fix run 经 checkoutExisting 幂等命中交付分支工作树 = 零重 clone），然后在
 * runs/<taskId>/.worktree.json 写镜像投影（mode=multi-clone + repos_root="codebase"，
 * repos[].dir 相对 codebase 根——旧 reader / listTaskRepos 形状不变的关键）。
 *
 * 任一库失败 → 整体退化空目录（半套布局比空目录更危险）：清掉 codebase、不写 meta、
 * mkdir 任务自有空 workspace/，与既有 ensureTaskSandbox 退化语义一致。
 */
export async function ensureRunCodebaseSandbox(
  taskId: string,
  reqId: string,
  cfg: SandboxConfig,
  workspaces: Array<WorkspaceRef & { alias?: string }>,
  deliverBranch: string,
  opts?: { checkoutExisting?: boolean },
): Promise<string> {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`非法 task ID：${taskId}`);

  // 幂等重入：本 run 的镜像已写 → 直接返回（codebase 由 ensureCodebase 自身幂等保障）
  const existing = readWorktreeMeta(taskId);
  if (existing?.repos_root === "codebase") return getTaskSandbox(taskId);

  if (workspaces.length === 0) {
    log.warn("sandbox.git=true 但未提供 workspace；退化空目录 [task=%s]", taskId);
    const ws = join(getTaskRoot(taskId), "workspace");
    mkdirSync(ws, { recursive: true });
    return ws;
  }

  const res = await ensureCodebase(
    reqId,
    workspaces.map((w) => ({ id: w.id, alias: w.alias, remote_url: w.remote_url, default_branch: w.default_branch })),
    {
      fidelity: "full",
      deliverBranch,
      checkoutExisting: opts?.checkoutExisting === true,
      base: cfg.base,
    },
  );

  if (res.failed.length > 0 || res.repos.length === 0) {
    log.warn("需求 codebase 供给失败（%s/%s 库失败），任务沙盒整体退化空目录 [task=%s req=%s]",
      res.failed.length, workspaces.length, taskId, reqId);
    try { rmSync(res.root, { recursive: true, force: true }); } catch { /* ignore */ }
    const ws = join(getTaskRoot(taskId), "workspace");
    mkdirSync(ws, { recursive: true });
    return ws;
  }

  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const repos: WorktreeRepoMeta[] = res.repos.map((r, i) => ({
    workspace_id: r.ws.id,
    alias: r.alias,
    dir: r.dir,
    branch: r.branch,
    base: r.base,
    remote_url: wsById.get(r.ws.id)?.remote_url ?? r.ws.remote_url,
    primary: i === 0,
  }));
  const p = repos[0];
  writeWorktreeMeta(taskId, {
    mode: "multi-clone",
    repos_root: "codebase",
    requirement_id: reqId,
    workspace_id: p.workspace_id,  // 顶层镜像 repos[0]：旧 reader 不读 repos 也不炸
    workspace_path: "",
    branch: p.branch,
    base: p.base,
    remote_url: p.remote_url,
    created_at: Date.now(),
    repos,
  });
  log.info("任务沙盒指向需求级 codebase [task=%s req=%s repos=%s branch=%s reused=%s]",
    taskId, reqId, repos.map((r) => r.alias).join(","), deliverBranch,
    res.repos.filter((r) => r.reused).map((r) => r.alias).join(",") || "无");
  return getTaskSandbox(taskId);
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
  checkoutExisting = false,
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

  // 建/续交付分支 + 写 exclude（与 codebase.ts 生产路径共用 finalizeDeliveryClone）
  finalizeDeliveryClone(dest, { base, branch, checkoutExisting, logCtx: `task=${taskId} ws=${workspace.id}` });

  return true;
}

/**
 * 任务沙盒统一布局（单库 = 长度 1 集合）：各库 clone 到 workspace/<alias>/ 子目录，
 * 全库共用同名交付分支。
 * 任一 clone 失败 → 整体清掉退化空目录（半套布局比空目录更危险——agent 会只改一半还以为齐了）。
 * repos[0] = 集合第一个（位置语义，主库概念已废除）；顶层字段镜像 repos[0] 防御历史 reader。
 */
function tryCreateMultiClone(
  taskId: string,
  cfg: SandboxConfig,
  workspaces: Array<WorkspaceRef & { alias?: string }>,
  wsRoot: string,
  deliverBranch?: string,
  checkoutExisting = false,
): WorktreeMeta | null {
  if (workspaces.length === 0) {
    log.warn("sandbox.git=true 但未提供 workspace（task.extra 无 workspace_id？）；退化空目录 [task=%s]", taskId);
    return null;
  }
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
    if (!cloneOneRepo(taskId, ws, dest, base, branch, checkoutExisting)) {
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
    workspace_id: p.workspace_id,  // 顶层镜像 repos[0]：旧 reader 不读 repos 也不炸
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
  /** = 集合第一个（纯位置语义，主库概念已废除） */
  primary: boolean;
}

/**
 * 列出任务的代码仓库布局。multi-clone meta（新任务统一格式，单库 = 长度 1）展开 repos；
 * 旧 mode=clone 任务返回单项指向 workspace/ 根；无 .worktree.json（非 git 工作流）返回 []。
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
  return join(getTaskRoot(taskId), WORKTREE_MANIFEST);
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
      repos_root: raw.repos_root, requirement_id: raw.requirement_id,
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
 * - clone / multi-clone 模式：**零碰源仓库** —— 只清 .worktree.json，沙盒目录交给上游 rmSync。
 *   这是"用户仓库零痕迹"的代码级护栏：独立 clone 的删除绝不跑任何 `git -C <源仓库>`。
 * - 老 worktree 数据（无 mode）：向后兼容，仍 `git worktree remove --force` 清掉源仓库的 worktree 注册。
 * - .worktree.json 不存在 → no-op 返回 false。
 */
export function removeTaskWorktree(taskId: string): boolean {
  const meta = readWorktreeMeta(taskId);
  if (!meta) return false;

  // clone / multi-clone 模式：源仓库零接触，删除纯靠 rmSync（上游 deleteTaskSandbox 做）
  if (meta.mode === "clone" || meta.mode === "multi-clone") {
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
  // meta / 沙盒路径必须在 removeTaskWorktree 之前取——它会删 .worktree.json，
  // 之后 getTaskSandbox 对 codebase 任务会丢失重定向信息。
  const meta = readWorktreeMeta(taskId);
  const sandboxPath = getTaskSandbox(taskId);
  // 旧 worktree task：先 git worktree remove --force 让源仓库干净（独立 clone 模式下 no-op）。
  let removed = removeTaskWorktree(taskId);
  const taskRoot = getTaskRoot(taskId);
  const targets = [
    getTaskArtifactsDir(taskId),   // artifacts/（沙盒 tab 展示的产物文档）
    join(taskRoot, ".agent-runs"), // 旧即焚副本残留（兼容删除）
  ];
  if (meta?.repos_root === "codebase") {
    // v2 R4：代码 clone 归需求所有（跨 run 共享）。仅当本 run 仍是需求当前 run 时随释放
    // 一并清 codebase——历史 run 的释放不能动正被新 run / fix run 使用的共享 clone。
    if (isCurrentRunOfRequirement(taskId, meta.requirement_id)) targets.unshift(sandboxPath);
  } else {
    targets.unshift(sandboxPath);  // workspace/（任务自有代码 clone）
  }
  for (const target of targets) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}

/** task 是否是其需求当前指向的 run（requirement.task_id === taskId）。DB 不可用时保守 false。 */
function isCurrentRunOfRequirement(taskId: string, reqId?: string): boolean {
  if (!reqId) return false;
  try {
    // 惰性 require：避免 sandbox→requirements 的静态环（同 lookupRequirementId 的理由）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reqs = require("./requirements") as typeof import("./requirements");
    return reqs.getRequirementById(reqId)?.task_id === taskId;
  } catch {
    return false;
  }
}

/**
 * 彻底删除任务运行时目录（经 getTaskRoot 双根解析：legacy `runtime/tasks/<id>/` 或
 * 新根 `runtime/requirements/<reqId>/runs/<id>/`，全部内容包括 sandbox、logs、events、
 * agent-calls、task-manifest.json）。用于"删除任务"路径。
 * 若 task 走 worktree，先清 worktree 让 workspace 干净。
 */
export function deleteTaskRuntimeDir(taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法 task ID：${taskId}`);
  }
  removeTaskWorktree(taskId);
  const dir = getTaskRoot(taskId);
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
  /** 任务运行时根目录绝对路径（双根：legacy runtime/tasks/<id> 或 requirements/<reqId>/runs/<id>） */
  root: string;
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

/** 需求级 codebase 的磁盘占用（retention 新轨，v2 R4） */
export interface RequirementCodebaseUsage {
  reqId: string;
  /** codebase/ 目录绝对路径 */
  path: string;
  size: number;
  mtime: number;
}

/** 扫所有需求级 codebase 大小 + mtime（runtime/requirements/<reqId>/codebase/）。 */
export function scanRequirementCodebases(requirementsRootOverride?: string): RequirementCodebaseUsage[] {
  const root = requirementsRootOverride ?? requirementsRootDir();
  const out: RequirementCodebaseUsage[] = [];
  if (!existsSync(root)) return out;
  for (const reqId of readdirSync(root)) {
    const cb = join(root, reqId, "codebase");
    if (!existsSync(cb)) continue;
    try {
      const s = statSync(cb);
      out.push({ reqId, path: cb, size: dirSizeBytes(cb), mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  return out;
}

/**
 * 应用保留策略清理 sandbox：按 (a) 超过 days (b) 总占用超 max_total_mb 清理。
 * 两条轨：
 *   - 旧轨：任务自有 workspace/（legacy runtime/tasks/ + runs/<id>/workspace，存量任务）
 *     —— 终态任务（isTerminal）才可清
 *   - 新轨（v2 R4）：需求级 codebase/（runtime/requirements/<reqId>/codebase/）
 *     —— **只清终态需求**（isRequirementTerminal；不传回调 = 永不清，fix run 的保障）
 * 返回被清理的标识列表（任务=taskId；codebase 条目带 "codebase:" 前缀）。
 * 仅清代码目录，不动 logs / agent-calls / DB 记录。
 *
 * 可注入 opts.tasksRoot / requirementsRoot 让测试用 tmpdir；生产路径不传走默认。
 */
export function applyRetentionPolicy(
  policy: RetentionPolicy,
  opts?: {
    isTerminal?: (taskId: string) => boolean;
    /** 需求是否终态（done/cancelled/failed）；不传 = 需求级 codebase 一律不清（非终态保护） */
    isRequirementTerminal?: (reqId: string) => boolean;
    now?: number;
    /** 显式指定 legacy tasks 根目录（测试用 tmpdir），默认 AUTOPILOT_HOME/runtime/tasks */
    tasksRoot?: string;
    /** 显式指定 requirements 根目录（测试用 tmpdir）；只传 tasksRoot 时不扫默认新根 */
    requirementsRoot?: string;
  },
): { removed: string[]; reclaimedBytes: number } {
  const now = opts?.now ?? Date.now();
  const injectedRoots = !!opts?.tasksRoot || !!opts?.requirementsRoot;
  const all = scanTaskSandboxes(opts?.tasksRoot, opts?.requirementsRoot)
    .filter((u) => u.exists && u.size > 0);
  // 需求级 codebase 轨：requirementsRoot 注入优先；只注入 tasksRoot 时不扫默认根（同 runs 扫描语义）
  const cbRoot = opts?.requirementsRoot ?? (opts?.tasksRoot ? null : undefined);
  const cbAll = cbRoot === null ? [] : scanRequirementCodebases(cbRoot).filter((u) => u.size > 0);

  const removed: string[] = [];
  let reclaimed = 0;

  const taskRemovable = (u: TaskSandboxUsage) => !opts?.isTerminal || opts.isTerminal(u.taskId);
  // codebase 非终态永不清：回调缺省按"非终态"处理（与任务轨"缺省可删"刻意不同——
  // codebase 是 fix run 的工作现场，宁可漏清不可误删）
  const cbRemovable = (u: RequirementCodebaseUsage) =>
    !!opts?.isRequirementTerminal && opts.isRequirementTerminal(u.reqId);

  const doRemoveTask = (u: TaskSandboxUsage) => {
    const ws = join(u.root, "workspace");
    if (!existsSync(ws)) return;
    // 若是 worktree task，先 git worktree remove --force 让 workspace 干净（spec §3.4：
    // 超过保留期还没提交就是垃圾，直接 force 干掉）。测试场景注入 tmpdir 根时
    // .worktree.json 不存在，removeTaskWorktree 是 no-op，不影响。
    if (!injectedRoots) {
      try { removeTaskWorktree(u.taskId); } catch { /* ignore */ }
    }
    try {
      rmSync(ws, { recursive: true, force: true });
      removed.push(u.taskId);
      reclaimed += u.size;
    } catch { /* ignore */ }
  };

  const doRemoveCodebase = (u: RequirementCodebaseUsage) => {
    if (!existsSync(u.path)) return;
    try {
      rmSync(u.path, { recursive: true, force: true });
      // 清单一并清：目录没了清单就是过期账本
      try { rmSync(join(u.path, "..", ".codebase.json"), { force: true }); } catch { /* ignore */ }
      removed.push(`codebase:${u.reqId}`);
      reclaimed += u.size;
    } catch { /* ignore */ }
  };

  // (a) 按天数清终态
  if (typeof policy.days === "number" && policy.days > 0) {
    const threshold = now - policy.days * 86400 * 1000;
    for (const u of all) {
      if (u.mtime && u.mtime < threshold && taskRemovable(u)) doRemoveTask(u);
    }
    for (const u of cbAll) {
      if (u.mtime && u.mtime < threshold && cbRemovable(u)) doRemoveCodebase(u);
    }
  }

  // (b) 总占用超限时，按 mtime 旧→新再删（两轨合并计算总量）
  if (typeof policy.max_total_mb === "number" && policy.max_total_mb > 0) {
    const maxBytes = policy.max_total_mb * 1024 * 1024;
    type Candidate =
      | { kind: "task"; mtime: number; size: number; u: TaskSandboxUsage }
      | { kind: "codebase"; mtime: number; size: number; u: RequirementCodebaseUsage };
    const remaining: Candidate[] = [
      ...all
        .filter((u) => !removed.includes(u.taskId))
        .map((u): Candidate => ({ kind: "task", mtime: u.mtime, size: u.size, u })),
      ...cbAll
        .filter((u) => !removed.includes(`codebase:${u.reqId}`))
        .map((u): Candidate => ({ kind: "codebase", mtime: u.mtime, size: u.size, u })),
    ];
    let total = remaining.reduce((a, it) => a + it.size, 0);
    if (total > maxBytes) {
      remaining.sort((a, b) => a.mtime - b.mtime);
      for (const c of remaining) {
        if (total <= maxBytes) break;
        if (c.kind === "task" && taskRemovable(c.u)) {
          doRemoveTask(c.u);
          total -= c.size;
        } else if (c.kind === "codebase" && cbRemovable(c.u)) {
          doRemoveCodebase(c.u);
          total -= c.size;
        }
      }
    }
  }

  return { removed, reclaimedBytes: reclaimed };
}

/**
 * 扫所有任务 sandbox 大小 + mtime（双根：legacy runtime/tasks/ + runtime/requirements/<reqId>/runs/）。
 * 可注入根目录让测试用 tmpdir；只传 rootOverride 时不扫默认新根（保持旧测试语义）。
 */
export function scanTaskSandboxes(rootOverride?: string, requirementsRootOverride?: string): TaskSandboxUsage[] {
  const out: TaskSandboxUsage[] = [];

  const scanOne = (taskRoot: string, taskId: string) => {
    const ws = join(taskRoot, "workspace");
    if (!existsSync(ws)) {
      out.push({ taskId, root: taskRoot, size: 0, mtime: 0, exists: false });
      return;
    }
    try {
      const s = statSync(ws);
      out.push({ taskId, root: taskRoot, size: dirSizeBytes(ws), mtime: s.mtimeMs, exists: true });
    } catch {
      out.push({ taskId, root: taskRoot, size: 0, mtime: 0, exists: false });
    }
  };

  // legacy 根：runtime/tasks/<taskId>/
  const legacyRoot = rootOverride ?? tasksRootDir();
  if (existsSync(legacyRoot)) {
    for (const taskId of readdirSync(legacyRoot)) {
      scanOne(join(legacyRoot, taskId), taskId);
    }
  }

  // 新根：runtime/requirements/<reqId>/runs/<taskId>/（v2 R2）
  const reqRoot = requirementsRootOverride ?? (rootOverride ? null : requirementsRootDir());
  if (reqRoot && existsSync(reqRoot)) {
    for (const reqId of readdirSync(reqRoot)) {
      const runsDir = join(reqRoot, reqId, "runs");
      if (!existsSync(runsDir)) continue;
      try {
        for (const taskId of readdirSync(runsDir)) {
          scanOne(join(runsDir, taskId), taskId);
        }
      } catch { /* skip */ }
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
