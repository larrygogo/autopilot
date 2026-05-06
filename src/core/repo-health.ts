import { existsSync, statSync } from "fs";

export interface RepoHealth {
  healthy: boolean;
  issues: string[];
  github_owner: string | null;
  github_repo: string | null;
}

/**
 * 检查仓库健康度：
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
export async function checkRepoHealth(path: string): Promise<RepoHealth> {
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
