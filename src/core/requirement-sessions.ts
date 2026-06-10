import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RequirementSession {
  id: string;
  requirement_id: string;
  session_type: string;
  agent_session_ref: string | null;
  messages_snapshot: ConversationTurn[];
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  requirement_id: string;
  session_type: string;
  agent_session_ref: string | null;
  messages_snapshot: string;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────

/** snapshot 最多保留条数（≈10 轮 Q&A） */
export const SNAPSHOT_MAX_TURNS = 20;

// ──────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────

function rowToSession(row: SessionRow): RequirementSession {
  let messages_snapshot: ConversationTurn[] = [];
  try {
    const parsed = JSON.parse(row.messages_snapshot);
    if (Array.isArray(parsed)) messages_snapshot = parsed as ConversationTurn[];
  } catch { /* 容错 */ }
  return { ...row, messages_snapshot };
}

/** 生成下一个 session id：sess-NNN */
function nextSessionId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirement_sessions WHERE id LIKE 'sess-%' ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "sess-001";
  const last = rows[0].id.replace("sess-", "");
  const n = parseInt(last, 10) + 1;
  return `sess-${String(n).padStart(3, "0")}`;
}

/** 截断 snapshot 到 SNAPSHOT_MAX_TURNS，确保首条为 user turn */
function truncateSnapshot(turns: ConversationTurn[]): ConversationTurn[] {
  if (turns.length <= SNAPSHOT_MAX_TURNS) return turns;
  const truncated = turns.slice(-SNAPSHOT_MAX_TURNS);
  // 确保首条是 user turn（成对完整）
  const startIdx = truncated.findIndex(t => t.role === "user");
  return startIdx > 0 ? truncated.slice(startIdx) : truncated;
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

/** 按需求 ID + 类型查 session（不存在返回 null）。type 默认 "clarifying"。 */
export function getSession(reqId: string, type: string = "clarifying"): RequirementSession | null {
  const db = getDb();
  const row = db
    .query<SessionRow, [string, string]>(
      "SELECT * FROM requirement_sessions WHERE requirement_id = ? AND session_type = ?",
    )
    .get(reqId, type);
  return row ? rowToSession(row) : null;
}

/**
 * 创建或更新 session。
 * 若已存在：只更新 updates 里提供的字段（agent_session_ref / messages_snapshot）。
 * 若不存在：用 updates 作初始值新建（未提供字段取默认）。
 * messages_snapshot 写入前自动截断至 SNAPSHOT_MAX_TURNS 最新条目。
 */
export function upsertSession(
  reqId: string,
  type: string,
  updates: { agent_session_ref?: string | null; messages_snapshot?: ConversationTurn[] },
): RequirementSession {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getSession(reqId, type);

  if (existing) {
    // 更新：只覆盖传入的字段
    const newRef = updates.agent_session_ref !== undefined
      ? updates.agent_session_ref
      : existing.agent_session_ref;
    const newSnapshot = updates.messages_snapshot !== undefined
      ? truncateSnapshot(updates.messages_snapshot)
      : existing.messages_snapshot;

    db.run(
      `UPDATE requirement_sessions
         SET agent_session_ref = ?, messages_snapshot = ?, updated_at = ?
       WHERE requirement_id = ? AND session_type = ?`,
      [
        newRef ?? null,
        JSON.stringify(newSnapshot),
        now,
        reqId,
        type,
      ],
    );
  } else {
    // 新建
    const id = nextSessionId();
    const ref = updates.agent_session_ref ?? null;
    const snapshot = updates.messages_snapshot
      ? truncateSnapshot(updates.messages_snapshot)
      : [];

    db.run(
      `INSERT INTO requirement_sessions
         (id, requirement_id, session_type, agent_session_ref, messages_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, reqId, type, ref, JSON.stringify(snapshot), now, now],
    );
  }

  return getSession(reqId, type)!;
}

/** 删除 session（终态清理 / 测试重置用）。type 默认 "clarifying"。 */
export function deleteSession(reqId: string, type: string = "clarifying"): void {
  const db = getDb();
  db.run(
    "DELETE FROM requirement_sessions WHERE requirement_id = ? AND session_type = ?",
    [reqId, type],
  );
}
