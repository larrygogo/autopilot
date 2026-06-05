import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateWorkspaceOpts {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}

export interface UpdateWorkspaceOpts {
  alias?: string;
  path?: string;
  default_branch?: string;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_workspace_id?: string | null;
  submodule_path?: string | null;
}

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

/**
 * 项目是否已有顶层工作区（submodule 不计入）。
 * 1:1 约束是产品/UX 规则，放在用户面 RPC 入口校验，不污染 core 原语
 * （测试夹具/内部仍可用 createWorkspace 自由建多顶层）。DB 部分唯一索引（迁移 025）兜底。
 */
export function projectHasTopWorkspace(projectId: string): boolean {
  return getTopWorkspaceForProject(projectId) != null;
}

/**
 * 取项目的顶层工作区（submodule 不计入）。项目:工作区 1:1 约束下最多一个；
 * 若历史脏数据存在多个，取最早建的。无则返回 null。
 * 供「新建需求自动派生 workspace_id」等场景免去用户手动选工作区。
 */
export function getTopWorkspaceForProject(projectId: string): Workspace | null {
  const db = getDb();
  const row = db
    .query<Workspace, [string]>(
      "SELECT * FROM workspaces WHERE project_id = ? AND parent_workspace_id IS NULL ORDER BY created_at ASC LIMIT 1",
    )
    .get(projectId);
  return row ?? null;
}

export function createWorkspace(opts: CreateWorkspaceOpts): Workspace {
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, default_branch, github_owner, github_repo, parent_workspace_id, submodule_path, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.project_id,
      opts.alias,
      opts.path,
      opts.default_branch ?? "main",
      opts.github_owner ?? null,
      opts.github_repo ?? null,
      opts.parent_workspace_id ?? null,
      opts.submodule_path ?? null,
      ts,
      ts,
    ]
  );
  return getWorkspaceById(opts.id) as Workspace;
}

export function getWorkspaceById(id: string): Workspace | null {
  const db = getDb();
  const row = db
    .query<Workspace, [string]>("SELECT * FROM workspaces WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function getWorkspaceByAlias(projectId: string, alias: string): Workspace | null {
  const db = getDb();
  const row = db
    .query<Workspace, [string, string]>(
      "SELECT * FROM workspaces WHERE project_id = ? AND alias = ?"
    )
    .get(projectId, alias);
  return row ?? null;
}

/**
 * 列出 workspaces。
 *  - 不传 projectId：列出全部
 *  - 传 projectId：限定到该项目
 *  - 默认仅顶级父，传 includeSubmodules=true 列全部（含子模块）
 */
export function listWorkspaces(opts: {
  projectId?: string;
  includeSubmodules?: boolean;
} = {}): Workspace[] {
  const db = getDb();
  const conds: string[] = [];
  const vals: string[] = [];

  if (opts.projectId !== undefined) {
    conds.push("project_id = ?");
    vals.push(opts.projectId);
  }
  if (!opts.includeSubmodules) {
    conds.push("parent_workspace_id IS NULL");
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return db
    .query<Workspace, typeof vals>(`SELECT * FROM workspaces ${where} ORDER BY created_at ASC`)
    .all(...vals);
}

export function updateWorkspace(id: string, opts: UpdateWorkspaceOpts): Workspace | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];

  if (opts.alias !== undefined) { fields.push("alias = ?"); vals.push(opts.alias); }
  if (opts.path !== undefined) { fields.push("path = ?"); vals.push(opts.path); }
  if (opts.default_branch !== undefined) { fields.push("default_branch = ?"); vals.push(opts.default_branch); }
  if (opts.github_owner !== undefined) { fields.push("github_owner = ?"); vals.push(opts.github_owner); }
  if (opts.github_repo !== undefined) { fields.push("github_repo = ?"); vals.push(opts.github_repo); }
  if (opts.parent_workspace_id !== undefined) { fields.push("parent_workspace_id = ?"); vals.push(opts.parent_workspace_id); }
  if (opts.submodule_path !== undefined) { fields.push("submodule_path = ?"); vals.push(opts.submodule_path); }

  if (fields.length === 0) return getWorkspaceById(id);

  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);

  db.run(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getWorkspaceById(id);
}

export function deleteWorkspace(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // 1. 把所有 requirement.workspace_id == id 的引用置 NULL（保留 requirement，不删）
    db.run("UPDATE requirements SET workspace_id = NULL, updated_at = ? WHERE workspace_id = ?", [Date.now(), id]);

    // 2. 删 requirement_workspaces 关联表中以此 workspace 为目标的所有条目
    db.run("DELETE FROM requirement_workspaces WHERE workspace_id = ?", [id]);

    // 3. 删此 workspace 的所有子 workspace（一级递归，匹配现有行为）
    //    子 workspace 也可能被 requirements 引用 → 先把它们的引用清掉
    const children = db.query<{ id: string }, [string]>(
      "SELECT id FROM workspaces WHERE parent_workspace_id = ?"
    ).all(id);
    for (const child of children) {
      db.run("UPDATE requirements SET workspace_id = NULL, updated_at = ? WHERE workspace_id = ?", [Date.now(), child.id]);
      db.run("DELETE FROM requirement_workspaces WHERE workspace_id = ?", [child.id]);
    }
    db.run("DELETE FROM workspaces WHERE parent_workspace_id = ?", [id]);

    // 4. 删自身
    db.run("DELETE FROM workspaces WHERE id = ?", [id]);
  })();
}

/**
 * 生成下一个 workspace id，格式 "ws-NNN"。
 *
 * TODO: 当 workspaces 数 > 999 时，3 位 padding 会让 lex 排序出错（"ws-1000" < "ws-999"），
 * 需要改成更宽 padding 或用 CAST(SUBSTR(id,4) AS INTEGER) 数字排序。P1 不会触发。
 */
export function nextWorkspaceId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM workspaces WHERE id LIKE 'ws-%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "ws-001";
  const last = rows[0].id.replace("ws-", "");
  const n = parseInt(last, 10) + 1;
  return `ws-${String(n).padStart(3, "0")}`;
}
