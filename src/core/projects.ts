import { getDb } from "./db";
import { listRequirements, deleteRequirement } from "./requirements";
import { listWorkspaces, deleteWorkspace } from "./workspaces";
import { forceDeleteTasksForProject } from "./task-delete";

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

/** 兜底项目稳定 id：快捷发包 / 定时任务等无显式项目维度的需求挂这里。 */
export const DEFAULT_PROJECT_ID = "proj-default";

/**
 * 确保兜底项目存在，返回其 id。幂等：不存在才建。
 */
export function ensureDefaultProject(): string {
  const existing = getProjectById(DEFAULT_PROJECT_ID);
  if (existing) return existing.id;
  return createProject({
    id: DEFAULT_PROJECT_ID,
    name: "默认 / Default",
    description: "快捷发包 / 定时任务（无显式项目）的兜底项目",
  }).id;
}

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

  // 0. 先强删项目下所有任务（含非终态）：清 task DB 记录 + runtime/锁/watcher/scheduler 引用。
  //    放在 SQL 事务之外 —— 内部有文件 IO（git worktree 清理等），不该阻塞事务也不该因文件失败回滚 DB。
  //    必须在删 requirements 之前：task 经 requirement_id 关联，先删需求就回查不到任务了。
  //    停运行中 agent 子进程由 daemon 层（RPC handler）在调用前 cancelTaskAction 负责，core 不依赖 daemon。
  forceDeleteTasksForProject(id);

  // 注意：deleteRequirement 和 deleteWorkspace 各自已是 transaction；嵌套 transaction 在 bun:sqlite 中是 savepoint，安全。
  db.transaction(() => {
    // 1. 删所有 requirements（级联清问题/回复/反馈/sub_prs/workspace 关联）
    //    这里用 core 裸 deleteRequirement 而非 deleteRequirementWithTasks —— 任务已被上面
    //    forceDeleteTasksForProject 先清完，再走 wrapper 会对每个 req 二次 purge（空树、无害但浪费且误导）。
    //    勿顺手「统一」成 deleteRequirementWithTasks。
    const reqs = listRequirements({ project_id: id });
    for (const r of reqs) deleteRequirement(r.id);

    // 2. 删所有顶层 workspaces（deleteWorkspace 内部处理子 workspace + requirement 引用置 NULL + join 清理）
    const wss = listWorkspaces({ projectId: id, includeSubmodules: false });
    for (const w of wss) deleteWorkspace(w.id);

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
  // 只看 proj-<纯数字> 的 id（用 GLOB 排除 proj-default 这类非编号兜底项目，
  // 否则 "default" 会被 parseInt 成 NaN → proj-NaN 重复冲突）。
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM projects WHERE id GLOB 'proj-[0-9]*' ORDER BY id DESC LIMIT 1"
    )
    .all();
  if (rows.length === 0) return "proj-001";
  const last = rows[0].id.replace("proj-", "");
  const n = parseInt(last, 10) + 1;
  return `proj-${String(n).padStart(3, "0")}`;
}
