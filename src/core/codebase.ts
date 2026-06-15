import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";
import { buildAuthUrl, resolveGitToken, GIT_NONINTERACTIVE_ENV } from "./workspace-health";
import { finalizeDeliveryClone } from "./git-clone";

// ──────────────────────────────────────────────
// 需求级 codebase —— 「一件工作一份 clone」（需求中心架构 v2 R4）
//
//   runtime/requirements/<reqId>/codebase/<alias>/   ← 唯一一份代码 clone
//   runtime/requirements/<reqId>/.codebase.json      ← 清单（真相：每库 fidelity/branch/base）
//
// 澄清浅 clone（fidelity=shallow）与执行完整 clone（fidelity=full + 交付分支）统一由
// ensureCodebase 供给：
//   - 浅→全升级 = **整库删除重 clone**（不做 --unshallow 原地升级——bypassPermissions agent
//     可能弄脏浅 clone，重 clone 无需证明干净）
//   - full 幂等命中（fidelity + 交付分支匹配）= 复用 —— fix run 在交付分支工作树原地续作、
//     零重 clone 的关键
//   - shallow 请求遇到既有 full clone = 复用（failed 重澄清可能站在交付分支脏树上，
//     由调用方在 prompt 里如实声明，不静默 reset）
// 零痕迹原则不变：远程 clone、token 注入后立刻抹除 origin、不碰用户源仓库。
// 并发：上层「活跃 run 唯一 + 澄清/执行状态互斥」保证单写者；本模块再按 reqId 串行化
// 进程内调用作纯防御。
// ──────────────────────────────────────────────

const REQ_ID_RE = /^[\w.\-]+$/;
const SAFE_DIR_RE = /^[\w.\-]+$/;
const DEFAULT_SHALLOW_TIMEOUT_MS = 120_000;
const CODEBASE_MANIFEST = ".codebase.json";

/** AUTOPILOT_HOME 动态读 env（兜底 import 时常量）：与 sandbox.ts 双根解析同口径，测试可注入。 */
function autopilotHomeDir(): string {
  return process.env.AUTOPILOT_HOME || AUTOPILOT_HOME;
}

/** 需求运行时根目录 runtime/requirements/<reqId>/。 */
export function getRequirementDir(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error(`非法 requirement ID：${reqId}`);
  return join(autopilotHomeDir(), "runtime", "requirements", reqId);
}

/** 需求级 codebase 根目录 runtime/requirements/<reqId>/codebase/。 */
export function getRequirementCodebaseRoot(reqId: string): string {
  return join(getRequirementDir(reqId), "codebase");
}

function manifestPath(reqId: string): string {
  return join(getRequirementDir(reqId), CODEBASE_MANIFEST);
}

export type CodebaseFidelity = "shallow" | "full";

export interface CodebaseRepoMeta {
  alias: string;
  /** 相对 codebase/ 根的子目录名（alias 白名单化而来） */
  dir: string;
  ws_id: string;
  fidelity: CodebaseFidelity;
  /** 当前 checkout 的分支（shallow=默认分支；full=交付分支） */
  branch: string;
  /** 派生 base 分支 */
  base: string;
  remote_url: string | null;
}

export interface CodebaseManifest {
  version: 1;
  updated_at: number;
  repos: CodebaseRepoMeta[];
}

export function readCodebaseManifest(reqId: string): CodebaseManifest | null {
  const p = manifestPath(reqId);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as CodebaseManifest;
    if (!Array.isArray(raw.repos)) return null;
    return raw;
  } catch { return null; }
}

function writeCodebaseManifest(reqId: string, repos: CodebaseRepoMeta[]): void {
  const p = manifestPath(reqId);
  mkdirSync(getRequirementDir(reqId), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, updated_at: Date.now(), repos } satisfies CodebaseManifest, null, 2));
}

/** ensureCodebase 接受的最小 workspace 形状（测试夹具友好） */
export interface CodebaseWorkspaceRef {
  id: string;
  remote_url: string | null;
  default_branch: string;
  alias?: string | null;
}

export interface EnsureCodebaseOpts {
  fidelity: CodebaseFidelity;
  /** full 必填：交付分支名（checkout -B <branch> origin/<base>，或 checkoutExisting 模式续作） */
  deliverBranch?: string;
  /** full：checkout 既有远程交付分支（fix run 续作）；远程无此分支则停在默认分支只读参考 */
  checkoutExisting?: boolean;
  /** full：覆盖派生 base（workflow sandbox.base 配置），缺省 workspace.default_branch */
  base?: string;
  /** shallow clone 超时（默认 120s）；full clone 不限时 */
  timeoutMs?: number;
}

export interface CodebaseRepoState<W extends CodebaseWorkspaceRef> {
  ws: W;
  alias: string;
  dir: string;
  /** 该库 clone 的绝对路径 */
  path: string;
  fidelity: CodebaseFidelity;
  branch: string;
  base: string;
  /** true = 幂等命中复用既有 clone（fix run 零重 clone） */
  reused: boolean;
}

/** alias → 安全子目录名：白名单字符，非法/为空时回退 workspace id。 */
export function safeAliasDir(alias: string, workspaceId: string): string {
  const cleaned = alias.replace(/[^\w.-]/g, "");
  if (cleaned && SAFE_DIR_RE.test(cleaned) && cleaned !== "." && cleaned !== "..") return cleaned;
  return workspaceId;
}

// 进程内按 reqId 串行化（防御并发调用交错写同一 codebase）
const _chains = new Map<string, Promise<unknown>>();

async function serialized<T>(reqId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _chains.get(reqId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  _chains.set(reqId, settled);
  void settled.then(() => {
    if (_chains.get(reqId) === settled) _chains.delete(reqId);
  });
  return run;
}

/**
 * 确保需求 codebase 满足请求的 fidelity（逐库幂等；按库降级进 failed，不拖垮其余库——
 * 执行路径要求全集成功时由调用方检查 failed 自行整体退化）。
 *
 * 复用/重建判定（清单 .codebase.json 是真相，目录非空才算数）：
 *   - want full：清单 full 且交付分支一致 → 复用；否则删了重 clone（含浅→全升级）
 *   - want shallow：目录非空即复用（full 也复用——重澄清如实声明交付分支现场）；
 *     无清单条目的非空目录按 .git/shallow 探测 fidelity 回填清单
 */
export async function ensureCodebase<W extends CodebaseWorkspaceRef>(
  reqId: string,
  wsList: W[],
  opts: EnsureCodebaseOpts,
): Promise<{ root: string; repos: Array<CodebaseRepoState<W>>; failed: W[] }> {
  if (opts.fidelity === "full" && !opts.deliverBranch?.trim()) {
    throw new Error("ensureCodebase: fidelity=full 必须指定 deliverBranch");
  }
  return serialized(reqId, () => ensureCodebaseInner(reqId, wsList, opts));
}

async function ensureCodebaseInner<W extends CodebaseWorkspaceRef>(
  reqId: string,
  wsList: W[],
  opts: EnsureCodebaseOpts,
): Promise<{ root: string; repos: Array<CodebaseRepoState<W>>; failed: W[] }> {
  const root = getRequirementCodebaseRoot(reqId);

  // 旧需求级浅 clone 布局 runtime/requirements/<reqId>/workspace/（R4 前的澄清快照）：
  // 暂态缓存，整目录删除重建（不写双格式 reader）
  const legacyCloneDir = join(getRequirementDir(reqId), "workspace");
  if (existsSync(legacyCloneDir)) {
    log.info("需求 codebase：检测到旧 workspace/ 浅 clone 布局，删除重建 [req=%s]", reqId);
    rmSync(legacyCloneDir, { recursive: true, force: true });
  }
  // 旧平铺布局（根自身是仓库根）→ 整目录重建
  if (existsSync(join(root, ".git"))) {
    log.info("需求 codebase：检测到旧平铺布局，整目录重建 [req=%s]", reqId);
    rmSync(root, { recursive: true, force: true });
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const manifest = readCodebaseManifest(reqId);
  const byWsId = new Map((manifest?.repos ?? []).map((r) => [r.ws_id, r]));

  // 子目录名先顺序分配定死（撞名回退 ws.id），再并行处理
  const usedDirs = new Set<string>();
  const entries = wsList.map((ws) => {
    let dir = safeAliasDir(ws.alias ?? ws.id, ws.id);
    if (usedDirs.has(dir)) dir = ws.id;
    usedDirs.add(dir);
    return { ws, dir, dest: join(root, dir) };
  });

  const okRepos: Array<CodebaseRepoState<W>> = [];
  const failed: W[] = [];

  await Promise.all(entries.map(async ({ ws, dir, dest }) => {
    const alias = ws.alias ?? ws.id;
    const populated = existsSync(dest) && readdirSync(dest).length > 0;
    let entry = byWsId.get(ws.id) ?? null;

    // 无清单条目的非空目录：按 .git/shallow 探测 fidelity 回填（崩溃后自愈）
    if (populated && (!entry || entry.dir !== dir)) {
      entry = {
        alias, dir, ws_id: ws.id,
        fidelity: existsSync(join(dest, ".git", "shallow")) ? "shallow" : "full",
        branch: probeHeadBranch(dest) ?? ws.default_branch,
        base: ws.default_branch,
        remote_url: ws.remote_url,
      };
    }

    if (opts.fidelity === "shallow") {
      if (populated && entry) {
        okRepos.push({ ws, alias, dir, path: dest, fidelity: entry.fidelity, branch: entry.branch, base: entry.base, reused: true });
        byWsId.set(ws.id, entry);
        return;
      }
      const ok = await cloneRepo(reqId, ws, dest, {
        fidelity: "shallow",
        branch: ws.default_branch,
        base: ws.default_branch,
        timeoutMs: opts.timeoutMs ?? DEFAULT_SHALLOW_TIMEOUT_MS,
      });
      if (!ok) { failed.push(ws); byWsId.delete(ws.id); return; }
      const meta: CodebaseRepoMeta = { alias, dir, ws_id: ws.id, fidelity: "shallow", branch: ws.default_branch, base: ws.default_branch, remote_url: ws.remote_url };
      byWsId.set(ws.id, meta);
      okRepos.push({ ws, alias, dir, path: dest, fidelity: "shallow", branch: meta.branch, base: meta.base, reused: false });
      return;
    }

    // want full
    const branch = opts.deliverBranch!.trim();
    const base = opts.base ?? ws.default_branch;
    if (populated && entry && entry.fidelity === "full" && entry.branch === branch) {
      // 幂等命中：交付分支工作树原地复用（fix run 零重 clone）
      okRepos.push({ ws, alias, dir, path: dest, fidelity: "full", branch, base: entry.base, reused: true });
      byWsId.set(ws.id, entry);
      return;
    }
    // 浅→全升级 / 分支不匹配 / 无账目录：整库删除重 clone
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    const ok = await cloneRepo(reqId, ws, dest, {
      fidelity: "full", branch, base,
      checkoutExisting: opts.checkoutExisting === true,
      timeoutMs: opts.timeoutMs,
    });
    if (!ok) { failed.push(ws); byWsId.delete(ws.id); return; }
    const meta: CodebaseRepoMeta = { alias, dir, ws_id: ws.id, fidelity: "full", branch, base, remote_url: ws.remote_url };
    byWsId.set(ws.id, meta);
    okRepos.push({ ws, alias, dir, path: dest, fidelity: "full", branch, base, reused: false });
  }));

  // 并行完成顺序不定 → 按入参顺序回排，调用方拿到稳定布局
  const order = new Map(entries.map((e, i) => [e.ws.id, i]));
  okRepos.sort((a, b) => (order.get(a.ws.id) ?? 0) - (order.get(b.ws.id) ?? 0));
  failed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // 清单写回：本次请求的库替换/新增；wsList 之外的旧条目保留（目录仍在，仍是事实）
  writeCodebaseManifest(reqId, [...byWsId.values()]);

  return { root, repos: okRepos, failed };
}

/** 探测工作树当前分支名；探不到返回 null。 */
function probeHeadBranch(dest: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", dest, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    const out = new TextDecoder().decode(p.stdout).trim();
    return out || null;
  } catch { return null; }
}

/**
 * clone 单库到 dest：token 注入 → clone（shallow 限时 / full 不限）→ 去 token 覆盖 origin →
 * full 时建/续交付分支 + 写 .git/info/exclude。失败清残留目录返回 false。
 */
async function cloneRepo(
  reqId: string,
  ws: CodebaseWorkspaceRef,
  dest: string,
  opts: { fidelity: CodebaseFidelity; branch: string; base: string; checkoutExisting?: boolean; timeoutMs?: number },
): Promise<boolean> {
  if (!ws.remote_url) return false;
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

  let cloneUrl = ws.remote_url;
  const cleanUrl = ws.remote_url;
  try {
    const gitToken = resolveGitToken(); // config git.token > gh auth token 兜底（私有仓库）
    if (gitToken) cloneUrl = buildAuthUrl(ws.remote_url, gitToken);
  } catch (e: unknown) {
    log.warn("解析 git token 失败，将尝试无凭证 clone [req=%s ws=%s]: %s",
      reqId, ws.id, e instanceof Error ? e.message : String(e));
  }

  const args = opts.fidelity === "shallow"
    ? ["git", "clone", "--depth", "1", "--single-branch", "-b", ws.default_branch, cloneUrl, dest]
    : ["git", "clone", cloneUrl, dest];

  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe", stderr: "pipe",
      // 非交互：凭证缺失快速失败，不挂死等终端/弹窗
      env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      killTimer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, opts.timeoutMs);
    }
    const exit = await proc.exited;
    if (killTimer) clearTimeout(killTimer);
    if (exit !== 0) {
      const stderr = (await new Response(proc.stderr).text()).replaceAll(cloneUrl, cleanUrl); // 脱敏
      log.warn("需求 codebase clone 失败 [req=%s ws=%s fidelity=%s exit=%d]: %s",
        reqId, ws.id, opts.fidelity, exit, stderr.slice(0, 300));
      rmSync(dest, { recursive: true, force: true });
      return false;
    }
  } catch (e: unknown) {
    log.warn("需求 codebase clone 异常 [req=%s ws=%s]: %s", reqId, ws.id, e instanceof Error ? e.message : String(e));
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }

  // 去 token 覆盖 origin，防凭证明文持久化在 .git/config
  if (cloneUrl !== cleanUrl) {
    Bun.spawnSync(["git", "-C", dest, "remote", "set-url", "origin", cleanUrl], { stderr: "pipe" });
  }

  if (opts.fidelity === "full") {
    // 建/续交付分支 + 写 exclude（与 sandbox.ts legacy 路径共用 finalizeDeliveryClone）
    finalizeDeliveryClone(dest, {
      base: opts.base,
      branch: opts.branch,
      checkoutExisting: opts.checkoutExisting,
      logCtx: `req=${reqId} ws=${ws.id}`,
    });
  }

  log.info("需求 codebase clone 创建 [req=%s ws=%s fidelity=%s branch=%s]", reqId, ws.id, opts.fidelity,
    opts.fidelity === "shallow" ? ws.default_branch : opts.branch);
  return true;
}

/**
 * 清理需求 codebase（codebase/ + .codebase.json + 旧 workspace/ 浅 clone 布局）。
 * 不动 runs/ 执行历史、attachments 等轻物料——整树删除走 deleteRequirementRuntimeDir。
 *
 * @param opts.onlyIfNoFull 清单含 fidelity=full 且目录仍在的条目时跳过（cancelled 需求
 *   可能有未交付改动想救回，留给 retention 按需求终态清；纯澄清浅 clone 则即清）。
 * @returns 是否真的删了东西。
 */
export function deleteRequirementCodebase(reqId: string, opts?: { onlyIfNoFull?: boolean }): boolean {
  if (!REQ_ID_RE.test(reqId)) return false;
  const root = getRequirementCodebaseRoot(reqId);
  const legacy = join(getRequirementDir(reqId), "workspace");
  const mp = manifestPath(reqId);

  if (opts?.onlyIfNoFull) {
    const manifest = readCodebaseManifest(reqId);
    const hasLiveFull = (manifest?.repos ?? []).some(
      (r) => r.fidelity === "full" && existsSync(join(root, r.dir)),
    );
    if (hasLiveFull) return false;
  }

  let removed = false;
  try {
    for (const p of [root, legacy, mp]) {
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        removed = true;
      }
    }
  } catch (e: unknown) {
    log.warn("清理需求 codebase 失败 [req=%s]: %s", reqId, e instanceof Error ? e.message : String(e));
  }
  return removed;
}
