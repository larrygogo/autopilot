import { getDb } from "./db";
import { listRequirements, deleteRequirement } from "./requirements";
import { listCodebases, deleteCodebase } from "./codebases";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: number; // epoch ms
  updated_at: number;
}

export interface CreateProjectOpts {
  id: string;
  name: string;
  description?: string | null;
}

export interface UpdateProjectOpts {
  name?: string;
  description?: string | null;
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

export function createProject(opts: CreateProjectOpts): Project {
  const db = getDb();
  const ts = nowMs();
  db.run(
    "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [opts.id, opts.name, opts.description ?? null, ts, ts]
  );
  return getProjectById(opts.id) as Project;
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  const row = db
    .query<Project, [string]>("SELECT * FROM projects WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function listProjects(): Project[] {
  const db = getDb();
  return db
    .query<Project, []>("SELECT * FROM projects ORDER BY created_at ASC")
    .all();
}

export function updateProject(id: string, opts: UpdateProjectOpts): Project | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];

  if (opts.name !== undefined) {
    fields.push("name = ?");
    vals.push(opts.name);
  }
  if (opts.description !== undefined) {
    fields.push("description = ?");
    vals.push(opts.description);
  }

  if (fields.length === 0) return getProjectById(id);

  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);

  db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getProjectById(id);
}

export function deleteProject(id: string): void {
  const db = getDb();
  // 注意：deleteRequirement 和 deleteCodebase 各自已是 transaction；嵌套 transaction 在 bun:sqlite 中是 savepoint，安全。
  db.transaction(() => {
    // 1. 删所有 requirements（级联清问题/回复/反馈/sub_prs/codebase 关联）
    const reqs = listRequirements({ project_id: id });
    for (const r of reqs) deleteRequirement(r.id);

    // 2. 删所有顶层 codebases（deleteCodebase 内部处理子 codebase + requirement 引用置 NULL + join 清理）
    const cbs = listCodebases({ projectId: id, includeSubmodules: false });
    for (const c of cbs) deleteCodebase(c.id);

    // 3. 删 project 自身
    db.run("DELETE FROM projects WHERE id = ?", [id]);
  })();
}

/**
 * 生成下一个 project id，格式 "proj-NNN"。
 * 简化方案：扫现有最大编号 +1，靠 PK 兜底并发冲突。
 *
 * TODO: 当 projects 数 > 999 时，3 位 padding 会让 lex 排序出错（"proj-1000" < "proj-999"），
 * 需要改成更宽 padding 或用 CAST(SUBSTR(id,6) AS INTEGER) 数字排序。Phase 1 不会触发。
 */
export function nextProjectId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM projects WHERE id LIKE 'proj-%' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "proj-001";
  const last = rows[0].id.replace("proj-", "");
  const n = parseInt(last, 10) + 1;
  return `proj-${String(n).padStart(3, "0")}`;
}
