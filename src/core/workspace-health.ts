import { existsSync, statSync } from "fs";

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
export async function checkWorkspaceHealth(path: string): Promise<WorkspaceHealth> {
  const issues: string[] = [];
  let owner: string | null = null;
  let repo: string | null = null;

  // 1. path 存在
  if (!existsSync(path)) {
    return { healthy: false, issues: [`路径不存在：${path}`], github_owner: null, github_repo: null };
  }
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch (e: unknown) { /* fallthrough */ }
  if (!isDir) {
    return { healthy: false, issues: [`路径不是目录：${path}`], github_owner: null, github_repo: null };
  }

  // 2. 是 git 仓库
  const isGitProc = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: path, stderr: "pipe",
  });
  if (isGitProc.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(isGitProc.stderr ?? new Uint8Array()).trim().split("\n")[0];
    issues.push(stderrText ? `不是 git 仓库（${stderrText}）` : "不是 git 仓库");
    return { healthy: false, issues, github_owner: null, github_repo: null };
  }

  // 3. origin 远端
  const remoteProc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: path, stderr: "pipe",
  });
  if (remoteProc.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(remoteProc.stderr ?? new Uint8Array()).trim().split("\n")[0];
    issues.push(stderrText ? `远端 origin 未配置（${stderrText}）` : "远端 origin 未配置");
  } else {
    const url = new TextDecoder().decode(remoteProc.stdout ?? new Uint8Array()).trim();
    const parsed = parseGithubFromRemote(url);
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
  const remoteProc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: path, stderr: "pipe" });
  if (remoteProc.exitCode === 0) {
    remote_url = decodeOut(remoteProc.stdout) || null;
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
