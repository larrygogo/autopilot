import { existsSync, statSync } from "fs";
import { loadGitConfig } from "../config";

/**
 * git 子进程的非交互环境：凭证缺失时**快速失败**而不是等待终端输入 / 弹凭证窗——
 * daemon 子进程 stdio 全 ignore，交互等待 = 挂死到超时被杀（stderr 为空，错误不可读）。
 */
export const GIT_NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "",
} as const;

// gh auth token 兜底缓存（5 分钟）：避免每次探测/clone 都 spawn 一次 gh
let _ghTokenCache: { at: number; token: string | null } | null = null;
const GH_TOKEN_TTL_MS = 5 * 60_000;

/**
 * 解析 git 操作可用的 token：config.yaml `git.token` 优先；缺省时回退 `gh auth token`
 * （用户通常用 gh 管 GitHub 凭证而不单独配 token —— 私有仓库的探测/clone 因此可用）。
 * 两者都没有返回 null（公开仓库无需凭证）。
 */
export function resolveGitToken(): string | null {
  try {
    const cfg = loadGitConfig();
    if (cfg.token) return cfg.token;
  } catch { /* config 读取失败 → 继续尝试 gh */ }

  if (_ghTokenCache && Date.now() - _ghTokenCache.at < GH_TOKEN_TTL_MS) {
    return _ghTokenCache.token;
  }
  let token: string | null = null;
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
      if (out) token = out;
    }
  } catch { /* gh 未安装/未登录 → null */ }
  _ghTokenCache = { at: Date.now(), token };
  return token;
}

export interface WorkspaceHealth {
  healthy: boolean;
  issues: string[];
  github_owner: string | null;
  github_repo: string | null;
}

/**
 * 检查 workspace 健康度：
 *  1. path 存在且是目录
 *  2. 是 git 仓库（git rev-parse --is-inside-work-tree）
 *  3. origin 远端已配置（git remote get-url origin）
 *
 * 同时尝试解析 GitHub owner/repo（仅当 origin 是 github.com）。
 *
 * 所有外部命令统一走 Bun.spawnSync argv，**不拼接 shell 字符串**。
 *
 * 注：当前用 spawnSync 同步实现；async 签名预留未来切真异步空间，
 * 单次健康检查耗时 ms 级，不阻塞 daemon 其他处理。
 */
/**
 * 检查 workspace 健康度。
 *
 * 支持两种签名（重载）：
 *   - 传 string（旧 path 模式）：本地路径检查（内部迁移过渡用）
 *   - 传 Workspace-like 对象（新模式）：基于 remote_url 的远程可达性检查
 *
 * remote_url 为 NULL → 直接返回 unhealthy（软失效 workspace）。
 * remote_url 不为空 → 执行 git ls-remote 验证远程可达性。
 */
export async function checkWorkspaceHealth(
  workspaceOrPath: { path: string | null; remote_url: string | null; github_owner: string | null; github_repo: string | null } | string,
  token?: string | null,
): Promise<WorkspaceHealth> {
  // 旧版兼容：传字符串 path 时走原有本地逻辑（内部迁移过渡用）
  if (typeof workspaceOrPath === "string") {
    return _checkWorkspaceHealthByPath(workspaceOrPath);
  }

  const ws = workspaceOrPath;
  if (!ws.remote_url) {
    return {
      healthy: false,
      issues: ["remote_url 未填写（软失效工作区）；请用 autopilot workspace update <id> --remote <url> 补填远程地址"],
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }

  const result = probeRemote(ws.remote_url, token);
  if (!result.ok) {
    return {
      healthy: false,
      issues: [`远程不可达：${result.error ?? "git ls-remote 失败"}`],
      github_owner: ws.github_owner,
      github_repo: ws.github_repo,
    };
  }

  return {
    healthy: true,
    issues: [],
    github_owner: ws.github_owner,
    github_repo: ws.github_repo,
  };
}

/** 旧版本地路径健康检查（内部兼容用） */
async function _checkWorkspaceHealthByPath(path: string): Promise<WorkspaceHealth> {
  const issues: string[] = [];
  let owner: string | null = null;
  let repo: string | null = null;

  if (!existsSync(path)) {
    return { healthy: false, issues: [`路径不存在：${path}`], github_owner: null, github_repo: null };
  }
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch (e: unknown) { /* fallthrough */ }
  if (!isDir) {
    return { healthy: false, issues: [`路径不是目录：${path}`], github_owner: null, github_repo: null };
  }

  const isGitProc = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: path, stderr: "pipe",
  });
  if (isGitProc.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(isGitProc.stderr ?? new Uint8Array()).trim().split("\n")[0];
    issues.push(stderrText ? `不是 git 仓库（${stderrText}）` : "不是 git 仓库");
    return { healthy: false, issues, github_owner: null, github_repo: null };
  }

  const remoteProc = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
    cwd: path, stderr: "pipe",
  });
  if (remoteProc.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(remoteProc.stderr ?? new Uint8Array()).trim().split("\n")[0];
    issues.push(stderrText ? `远端 origin 未配置（${stderrText}）` : "远端 origin 未配置");
  } else {
    const url = redactRemoteUrl(new TextDecoder().decode(remoteProc.stdout ?? new Uint8Array()).trim());
    const parsed = url ? parseGithubFromRemote(url) : null;
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    }
  }

  return {
    healthy: issues.length === 0,
    issues,
    github_owner: owner,
    github_repo: repo,
  };
}

export interface WorkspaceGitInfo {
  /** path 是否是一个 git 工作树 */
  is_git: boolean;
  /** 默认分支：优先 origin/HEAD 指向，回退当前分支；探测不到为 null（创建时再兜底 main） */
  default_branch: string | null;
  /** origin 远程地址原文（任意 host；非 github 也返回，仅 github 才解析 owner/repo） */
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
}

function decodeOut(buf: Uint8Array | undefined): string {
  return new TextDecoder().decode(buf ?? new Uint8Array()).trim();
}

/**
 * 从本地路径探测 git 信息，供「添加工作区」时自动识别默认分支 + 远程地址。
 *
 * 默认分支解析顺序：
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` → refs/remotes/origin/<branch>（最准，反映远端默认分支）
 *   2. 回退 `git rev-parse --abbrev-ref HEAD`（当前分支；detached HEAD 返回 "HEAD" 时跳过）
 *   3. 都拿不到 → null（调用方创建时兜底 "main"）
 *
 * 远程地址：`git remote get-url origin`，原文返回；github.com 域再解析 owner/repo。
 * 所有外部命令走 Bun.spawnSync argv，不拼 shell 字符串。纯读，不改仓库。
 */
export function detectWorkspaceGit(path: string): WorkspaceGitInfo {
  const none: WorkspaceGitInfo = {
    is_git: false, default_branch: null, remote_url: null, github_owner: null, github_repo: null,
  };
  if (!existsSync(path)) return none;
  try { if (!statSync(path).isDirectory()) return none; } catch (e: unknown) { return none; }

  const isGit = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: path, stderr: "pipe" });
  if (isGit.exitCode !== 0) return none;

  // 远程地址 + github owner/repo
  let remote_url: string | null = null;
  let owner: string | null = null;
  let repo: string | null = null;
  // 用 `git config --get` 取配置原文，不施加 url.<base>.insteadOf 重写
  // （后者会把宿主全局 git 配置里的 PAT 注入 URL → 泄露 + 测试不可复现，H2）。
  const remoteProc = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], { cwd: path, stderr: "pipe" });
  if (remoteProc.exitCode === 0) {
    // 即便 remote 本身配了带凭据的 URL（CI 常见），也脱敏后再返回/落库/展示。
    remote_url = redactRemoteUrl(decodeOut(remoteProc.stdout) || null);
    const parsed = remote_url ? parseGithubFromRemote(remote_url) : null;
    if (parsed) { owner = parsed.owner; repo = parsed.repo; }
  }

  // 默认分支
  let branch: string | null = null;
  const headRef = Bun.spawnSync(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: path, stderr: "pipe" });
  if (headRef.exitCode === 0) {
    const m = decodeOut(headRef.stdout).match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) branch = m[1];
  }
  if (!branch) {
    const cur = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, stderr: "pipe" });
    if (cur.exitCode === 0) {
      const b = decodeOut(cur.stdout);
      if (b && b !== "HEAD") branch = b; // 跳过 detached HEAD
    }
  }

  return { is_git: true, default_branch: branch, remote_url, github_owner: owner, github_repo: repo };
}

/**
 * 从 git remote URL 解析 GitHub owner/repo，只识别 github.com 域。
 * 支持：
 *  - https://github.com/<owner>/<repo>(.git)?(/)?
 *  - https://user:token@github.com/<owner>/<repo>(.git)?（带凭证，CI 常见）
 *  - ssh://git@github.com/<owner>/<repo>(.git)?
 *  - git://github.com/<owner>/<repo>(.git)?
 *  - git@github.com:<owner>/<repo>(.git)?（scp-style ssh）
 *  - 仓库名可含点（如 autopilot.js、autopilot.io）
 *  - 大小写不敏感
 */
/**
 * 脱敏 git remote URL：剥掉 scheme://user:pass@host 形式里的凭据（userinfo），避免把宿主
 * PAT（CI token / 全局 insteadOf 注入）随 remote_url 回传客户端 / 落库 / 在 Web UI 展示 /
 * 进日志（H2）。scp-style git@host:path 的 user 是 SSH 公开用户名（非密码），保留。
 */
export function redactRemoteUrl(url: string | null): string | null {
  if (!url) return url;
  // 仅匹配 scheme://[userinfo@]host：剥掉 host 前的 userinfo；path 里的 @ 不受影响。
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

export function parseGithubFromRemote(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const u = url.trim();
  // https / https-with-creds / ssh:// / git://
  let m = u.match(/^(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // scp-style ssh: git@github.com:owner/repo(.git)?
  m = u.match(/^[^@\s:/]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

// ──────────────────────────────────────────────
// 远程仓库探测（probeRemote）+ Token 注入（buildAuthUrl）
// ──────────────────────────────────────────────

export interface ProbeResult {
  /** 远程可达且鉴权通过 */
  ok: boolean;
  /** 探测到的默认分支（解析 HEAD 指向）；探测失败或无 HEAD 时为 null */
  defaultBranch: string | null;
  /** 失败原因（供用户提示） */
  error?: string;
}

/**
 * 探测远程 git 仓库可达性，同时解析默认分支。
 *
 * 执行：`git ls-remote --symref <url> HEAD`
 * 一次调用兼顾：
 *   - 可达性验证（非零退出码 = 不可达/鉴权失败）
 *   - 默认分支探测（解析 `ref: refs/heads/<branch>  HEAD` 行）
 *
 * token 注入：HTTP(S) URL + token 存在时，在 URL 中临时注入凭据（仅此次 git 调用，不落库）。
 */
export function probeRemote(remoteUrl: string, token?: string | null): ProbeResult {
  if (!remoteUrl || !remoteUrl.trim()) {
    return { ok: false, defaultBranch: null, error: "远程地址为空" };
  }

  // token：调用方显式传入 > config git.token > gh auth token（私有仓库兜底）
  const effectiveToken = token ?? resolveGitToken();
  const url = buildAuthUrl(remoteUrl.trim(), effectiveToken);

  const proc = Bun.spawnSync(
    ["git", "ls-remote", "--symref", url, "HEAD"],
    {
      stdout: "pipe", stderr: "pipe", timeout: 15_000,
      // 非交互：凭证缺失快速失败，不挂死等终端/弹窗（daemon stdio 全 ignore）
      env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
    },
  );

  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim();
    // 脱敏：把 token-injected URL 从错误信息中去除
    const safeErr = effectiveToken ? stderr.replace(effectiveToken, "***") : stderr;
    const firstLine = safeErr.split("\n")[0] ?? "";
    return {
      ok: false,
      defaultBranch: null,
      error: firstLine || "git ls-remote 无输出退出（疑似等待凭证超时被杀；私有仓库请配置 config.yaml git.token 或 gh auth login）",
    };
  }

  const output = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
  // 解析 "ref: refs/heads/<branch>  HEAD" 行
  const m = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
  const defaultBranch = m ? m[1] : null;

  return { ok: true, defaultBranch };
}

/**
 * 为 HTTPS URL 注入 token（临时，只用于命令行参数，不落库）。
 * SSH URL 原样返回（走系统 SSH key）。
 */
export function buildAuthUrl(url: string, token: string | null): string {
  if (!token || !token.trim()) return url;
  // 仅 https:// 协议注入；ssh:// / git:// / scp-style 不处理
  if (!url.startsWith("https://")) return url;
  // 格式：https://oauth2:<token>@<rest>
  // token 需 URL 编码：含 @/:/ 等字符时（如旧版 GitLab tokens）防止 URL 畸形
  return url.replace(/^https:\/\//, `https://oauth2:${encodeURIComponent(token)}@`);
}
