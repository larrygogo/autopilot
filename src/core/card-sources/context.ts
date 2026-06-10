/**
 * 卡片归属上下文解析 —— 按需求/任务 id JOIN 出需求标题、项目名、仓库别名+默认分支。
 * 各 card source 构卡时调用，查不到（实体缺失/游离任务）返回 undefined，卡片照常出。
 */

import { getDb } from "../db";
import type { NowCardContext } from "../now-types";

interface CtxRow {
  requirement_id: string;
  requirement_title: string;
  project_name: string | null;
  workspace_alias: string | null;
  branch: string | null;
}

const REQ_CTX_SELECT = `
  SELECT r.id AS requirement_id, r.title AS requirement_title,
         p.name AS project_name, w.alias AS workspace_alias, w.default_branch AS branch
  FROM requirements r
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN workspaces w ON w.id = r.workspace_id
`;

function toContext(row: CtxRow): NowCardContext {
  return {
    requirement_id: row.requirement_id,
    requirement_title: row.requirement_title,
    project_name: row.project_name ?? undefined,
    workspace_alias: row.workspace_alias ?? undefined,
    branch: row.branch ?? undefined,
  };
}

export function contextForRequirement(reqId: string): NowCardContext | undefined {
  try {
    const row = getDb()
      .query<CtxRow, [string]>(`${REQ_CTX_SELECT} WHERE r.id = ?`)
      .get(reqId);
    return row ? toContext(row) : undefined;
  } catch {
    return undefined;
  }
}

export function contextForTask(taskId: string): NowCardContext | undefined {
  try {
    const row = getDb()
      .query<CtxRow, [string]>(`
        SELECT r.id AS requirement_id, r.title AS requirement_title,
               p.name AS project_name, w.alias AS workspace_alias, w.default_branch AS branch
        FROM tasks t
        INNER JOIN requirements r ON r.id = t.requirement_id
        LEFT JOIN projects p ON p.id = r.project_id
        LEFT JOIN workspaces w ON w.id = r.workspace_id
        WHERE t.id = ?
      `)
      .get(taskId);
    return row ? toContext(row) : undefined;
  } catch {
    return undefined;
  }
}
