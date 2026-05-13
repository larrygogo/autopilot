import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Codebase {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_codebase_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateCodebaseOpts {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_codebase_id?: string | null;
  submodule_path?: string | null;
}

export interface UpdateCodebaseOpts {
  alias?: string;
  path?: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_codebase_id?: string | null;
  submodule_path?: string | null;
}

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function createCodebase(opts: CreateCodebaseOpts): Codebase {
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO codebases (id, project_id, alias, path, default_branch, github_owner, github_repo, parent_codebase_id, submodule_path, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.project_id,
      opts.alias,
      opts.path,
      opts.default_branch ?? "main",
      opts.github_owner ?? null,
      opts.github_repo ?? null,
      opts.parent_codebase_id ?? null,
      opts.submodule_path ?? null,
      ts,
      ts,
    ]
  );
  return getCodebaseById(opts.id) as Codebase;
}

export function getCodebaseById(id: string): Codebase | null {
  const db = getDb();
  const row = db
    .query<Codebase, [string]>("SELECT * FROM codebases WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function getCodebaseByAlias(projectId: string, alias: string): Codebase | null {
  const db = getDb();
  const row = db
    .query<Codebase, [string, string]>(
      "SELECT * FROM codebases WHERE project_id = ? AND alias = ?"
    )
    .get(projectId, alias);
  return row ?? null;
}

/**
 * 列出 codebases。
 *  - 不传 projectId：列出全部
 *  - 传 projectId：限定到该项目
 *  - 默认仅顶级父，传 includeSubmodules=true 列全部（含子模块）
 */
export function listCodebases(opts: {
  projectId?: string;
  includeSubmodules?: boolean;
} = {}): Codebase[] {
  const db = getDb();
  const conds: string[] = [];
  const vals: string[] = [];

  if (opts.projectId !== undefined) {
    conds.push("project_id = ?");
    vals.push(opts.projectId);
  }
  if (!opts.includeSubmodules) {
    conds.push("parent_codebase_id IS NULL");
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return db
    .query<Codebase, typeof vals>(`SELECT * FROM codebases ${where} ORDER BY created_at ASC`)
    .all(...vals);
}

export function updateCodebase(id: string, opts: UpdateCodebaseOpts): Codebase | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];

  if (opts.alias !== undefined) { fields.push("alias = ?"); vals.push(opts.alias); }
  if (opts.path !== undefined) { fields.push("path = ?"); vals.push(opts.path); }
  if (opts.default_branch !== undefined) { fields.push("default_branch = ?"); vals.push(opts.default_branch); }
  if (opts.github_owner !== undefined) { fields.push("github_owner = ?"); vals.push(opts.github_owner); }
  if (opts.github_repo !== undefined) { fields.push("github_repo = ?"); vals.push(opts.github_repo); }
  if (opts.parent_codebase_id !== undefined) { fields.push("parent_codebase_id = ?"); vals.push(opts.parent_codebase_id); }
  if (opts.submodule_path !== undefined) { fields.push("submodule_path = ?"); vals.push(opts.submodule_path); }

  if (fields.length === 0) return getCodebaseById(id);

  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);

  db.run(`UPDATE codebases SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getCodebaseById(id);
}

export function deleteCodebase(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // 1. 把所有 requirement.codebase_id == id 的引用置 NULL（保留 requirement，不删）
    db.run("UPDATE requirements SET codebase_id = NULL, updated_at = ? WHERE codebase_id = ?", [Date.now(), id]);

    // 2. 删 requirement_codebases 关联表中以此 codebase 为目标的所有条目
    db.run("DELETE FROM requirement_codebases WHERE codebase_id = ?", [id]);

    // 3. 删此 codebase 的所有子 codebase（一级递归，匹配现有行为）
    //    子 codebase 也可能被 requirements 引用 → 先把它们的引用清掉
    const children = db.query<{ id: string }, [string]>(
      "SELECT id FROM codebases WHERE parent_codebase_id = ?"
    ).all(id);
    for (const child of children) {
      db.run("UPDATE requirements SET codebase_id = NULL, updated_at = ? WHERE codebase_id = ?", [Date.now(), child.id]);
      db.run("DELETE FROM requirement_codebases WHERE codebase_id = ?", [child.id]);
    }
    db.run("DELETE FROM codebases WHERE parent_codebase_id = ?", [id]);

    // 4. 删自身
    db.run("DELETE FROM codebases WHERE id = ?", [id]);
  })();
}

/**
 * 生成下一个 codebase id，格式 "cb-NNN"。
 *
 * TODO: 当 codebases 数 > 999 时，3 位 padding 会让 lex 排序出错（"cb-1000" < "cb-999"），
 * 需要改成更宽 padding 或用 CAST(SUBSTR(id,4) AS INTEGER) 数字排序。P1 不会触发。
 */
export function nextCodebaseId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM codebases WHERE id LIKE 'cb-%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "cb-001";
  const last = rows[0].id.replace("cb-", "");
  const n = parseInt(last, 10) + 1;
  return `cb-${String(n).padStart(3, "0")}`;
}
