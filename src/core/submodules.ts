import { existsSync, statSync } from "fs";
import { join } from "path";
import { getDb } from "./db";
import { getRepoById, createRepo, listRepos, nextRepoId, type Repo } from "./repos";
import { parseGitmodulesFile } from "./gitmodules-parser";
import { parseGithubFromRemote } from "./repo-health";
import { log } from "./logger";

export interface DiscoverResult {
  added: Repo[];      // 本次新增的子模块
  existing: Repo[];   // 已存在的子模块（不动）
  warnings: string[]; // .gitmodules 里有但跳过的（非 GitHub url、path 不存在等）
}

/**
 * 列出某父 repo 的所有子模块（DB 中 parent_repo_id 匹配的行）。
 */
export function listSubmodules(parentRepoId: string): Repo[] {
  const db = getDb();
  return db
    .query<Repo, [string]>(
      "SELECT * FROM repos WHERE parent_repo_id = ? ORDER BY submodule_path ASC",
    )
    .all(parentRepoId);
}

/**
 * 解析父 repo 的 .gitmodules，把发现的子模块同步到 DB。
 *
 * 算法（增量）：
 *   1. 校验 parentRepoId 存在 + 自身不是子模块（不支持嵌套）
 *   2. 解析 .gitmodules 拿 entries
 *   3. 对每个 entry：
 *      - 物理路径不存在 / 非目录 → warnings
 *      - URL 非 GitHub → warnings
 *      - 已存在（按 submodule_path 比对）→ existing
 *      - 否则：pickUniqueAlias → createRepo（含 parent_repo_id）→ added
 *   4. DB 中存在但 .gitmodules 已无的子模块 → warnings（不自动删，避免破坏关联 requirements）
 *
 * 子模块 default_branch 解析：.gitmodules branch 字段优先 → 兜底 main
 * （gh CLI 探测远端默认分支留给 follow-up）
 */
export function discoverSubmodules(parentRepoId: string): DiscoverResult {
  const result: DiscoverResult = { added: [], existing: [], warnings: [] };

  const parent = getRepoById(parentRepoId);
  if (!parent) throw new Error(`repo not found: ${parentRepoId}`);
  if (parent.parent_repo_id) {
    throw new Error(`不支持嵌套子模块：repo ${parentRepoId} 自身就是子模块`);
  }

  const entries = parseGitmodulesFile(parent.path);
  const existing = listSubmodules(parentRepoId);
  const existingByPath = new Map(existing.map((r) => [r.submodule_path, r]));

  for (const entry of entries) {
    // 已存在 → 跳过
    const found = existingByPath.get(entry.path);
    if (found) {
      result.existing.push(found);
      existingByPath.delete(entry.path);
      continue;
    }

    // 校验子模块物理路径
    const submoduleAbs = join(parent.path, entry.path);
    if (!existsSync(submoduleAbs)) {
      result.warnings.push(`子模块 ${entry.name} 路径 ${entry.path} 不存在或不是目录，跳过`);
      continue;
    }
    let isDir = false;
    try { isDir = statSync(submoduleAbs).isDirectory(); } catch (e: unknown) { /* ignore */ }
    if (!isDir) {
      result.warnings.push(`子模块 ${entry.name} 路径 ${entry.path} 不存在或不是目录，跳过`);
      continue;
    }

    // 校验 GitHub URL（P5 仅支持 github.com）
    const parsed = parseGithubFromRemote(entry.url);
    if (!parsed) {
      result.warnings.push(`子模块 ${entry.name} url=${entry.url} 不是 GitHub，P5 暂不支持，跳过`);
      continue;
    }

    // 选 alias，冲突时加后缀
    const alias = pickUniqueAlias(entry.name);

    // 默认分支
    const defaultBranch = entry.branch ?? "main";

    const newId = nextRepoId();
    const newRepo = createRepo({
      id: newId,
      alias,
      path: submoduleAbs,
      default_branch: defaultBranch,
      github_owner: parsed.owner,
      github_repo: parsed.repo,
      parent_repo_id: parentRepoId,
      submodule_path: entry.path,
    });
    result.added.push(newRepo);
  }

  // existingByPath 还剩的 = DB 有但 .gitmodules 没
  for (const orphan of existingByPath.values()) {
    result.warnings.push(
      `DB 中有子模块 ${orphan.alias}（${orphan.submodule_path}）但 .gitmodules 已无对应条目；不自动删除（避免破坏关联 requirements），需要时请手动 deleteRepo`,
    );
  }

  log.info(
    "discoverSubmodules: parent=%s added=%s existing=%s warnings=%s",
    parentRepoId,
    String(result.added.length),
    String(result.existing.length),
    String(result.warnings.length),
  );
  return result;
}

/** 选一个未被占用的 alias（输入冲突时加 -2 / -3 等后缀） */
function pickUniqueAlias(base: string): string {
  const all = listRepos({ includeSubmodules: true });
  const used = new Set(all.map((r) => r.alias));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 分配唯一 alias`);
}
