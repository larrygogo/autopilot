import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Repo {
  id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  created_at: number; // epoch ms（注意：跟 tasks/schedules 用 TEXT 不同）
  updated_at: number;
}

export interface CreateRepoOpts {
  id: string;
  alias: string;
  path: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
}

export interface UpdateRepoOpts {
  alias?: string;
  path?: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
}

// ──────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function createRepo(opts: CreateRepoOpts): Repo {
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO repos (id, alias, path, default_branch, github_owner, github_repo, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.alias,
      opts.path,
      opts.default_branch ?? "main",
      opts.github_owner ?? null,
      opts.github_repo ?? null,
      ts,
      ts,
    ]
  );
  return getRepoById(opts.id) as Repo;
}

export function getRepoById(id: string): Repo | null {
  const db = getDb();
  const row = db
    .query<Repo, [string]>("SELECT * FROM repos WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function getRepoByAlias(alias: string): Repo | null {
  const db = getDb();
  const row = db
    .query<Repo, [string]>("SELECT * FROM repos WHERE alias = ?")
    .get(alias);
  return row ?? null;
}

export function listRepos(): Repo[] {
  const db = getDb();
  return db
    .query<Repo, []>("SELECT * FROM repos ORDER BY created_at ASC")
    .all();
}

export function updateRepo(id: string, opts: UpdateRepoOpts): Repo | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];

  if (opts.alias !== undefined) {
    fields.push("alias = ?");
    vals.push(opts.alias);
  }
  if (opts.path !== undefined) {
    fields.push("path = ?");
    vals.push(opts.path);
  }
  if (opts.default_branch !== undefined) {
    fields.push("default_branch = ?");
    vals.push(opts.default_branch);
  }
  if (opts.github_owner !== undefined) {
    fields.push("github_owner = ?");
    vals.push(opts.github_owner);
  }
  if (opts.github_repo !== undefined) {
    fields.push("github_repo = ?");
    vals.push(opts.github_repo);
  }

  if (fields.length === 0) return getRepoById(id);

  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);

  db.run(`UPDATE repos SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getRepoById(id);
}

export function deleteRepo(id: string): void {
  const db = getDb();
  db.run("DELETE FROM repos WHERE id = ?", [id]);
}

/**
 * 生成下一个 repo id，格式 "repo-NNN"。
 * 简化方案：扫现有最大编号 +1，靠 PK 兜底并发冲突。
 *
 * TODO: 当 repos 数 > 999 时，3 位 padding 会让 lex 排序出错（"repo-1000" < "repo-999"），
 * 需要改成更宽 padding 或用 CAST(SUBSTR(id,6) AS INTEGER) 数字排序。Phase 1 不会触发。
 */
export function nextRepoId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM repos WHERE id LIKE 'repo-%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "repo-001";
  const last = rows[0].id.replace("repo-", "");
  const n = parseInt(last, 10) + 1;
  return `repo-${String(n).padStart(3, "0")}`;
}
