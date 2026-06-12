import { getDb } from "./db";
import type {
  Notification,
  NotificationAction,
  NotificationContext,
  NotificationRelatedType,
  NotificationType,
} from "./notification-types";
import { SEVERITY_OF } from "./notification-types";

/**
 * notifications 表的唯一写入者（single-writer 白名单成员）+ 查询。
 * SQLite 即权威源，无 manifest 同步需求。
 *
 * 写入方：daemon 的 notification-recorder（订阅 event-bus 把领域事件翻译成通知行）。
 * 本模块不 emit 事件 —— WS 广播由调用方（recorder / RPC handler）负责，
 * 保持 core 对事件总线零依赖的方向。
 */

interface NotificationRow {
  id: number;
  type: string;
  severity: string;
  title: string;
  body: string;
  related_type: string | null;
  related_id: string | null;
  context_json: string | null;
  actions_json: string | null;
  read_at: number | null;
  dismissed_at: number | null;
  created_at: number;
}

function rowToNotification(row: NotificationRow): Notification {
  let context: NotificationContext | null = null;
  let actions: NotificationAction[] = [];
  try {
    context = row.context_json ? (JSON.parse(row.context_json) as NotificationContext) : null;
  } catch { /* 脏行容忍：context 缺失不阻断展示 */ }
  try {
    actions = row.actions_json ? (JSON.parse(row.actions_json) as NotificationAction[]) : [];
  } catch { /* 同上 */ }
  return {
    id: row.id,
    type: row.type as Notification["type"],
    severity: row.severity as Notification["severity"],
    title: row.title,
    body: row.body,
    related_type: (row.related_type as NotificationRelatedType | null) ?? null,
    related_id: row.related_id,
    context,
    actions,
    read_at: row.read_at,
    dismissed_at: row.dismissed_at,
    created_at: row.created_at,
  };
}

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  related?: { type: NotificationRelatedType; id: string };
  context?: NotificationContext;
  actions?: NotificationAction[];
}

export function createNotification(input: CreateNotificationInput): Notification {
  const now = Date.now();
  const result = getDb().run(
    `INSERT INTO notifications
       (type, severity, title, body, related_type, related_id, context_json, actions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.type,
      SEVERITY_OF[input.type],
      input.title,
      input.body ?? "",
      input.related?.type ?? null,
      input.related?.id ?? null,
      input.context ? JSON.stringify(input.context) : null,
      input.actions && input.actions.length > 0 ? JSON.stringify(input.actions) : null,
      now,
    ],
  );
  const id = Number(result.lastInsertRowid);
  return getNotification(id)!;
}

export function getNotification(id: number): Notification | null {
  const row = getDb()
    .query<NotificationRow, [number]>("SELECT * FROM notifications WHERE id = ?")
    .get(id);
  return row ? rowToNotification(row) : null;
}

export interface ListNotificationsOptions {
  limit?: number;
  /** id 倒序游标：只取 id < before_id 的行 */
  before_id?: number;
  unread_only?: boolean;
  include_dismissed?: boolean;
}

export function listNotifications(
  opts: ListNotificationsOptions = {},
): { items: Notification[]; next_before_id: number | null } {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const where: string[] = [];
  const params: number[] = [];
  if (!opts.include_dismissed) where.push("dismissed_at IS NULL");
  if (opts.unread_only) where.push("read_at IS NULL");
  if (opts.before_id != null) {
    where.push("id < ?");
    params.push(opts.before_id);
  }
  const sql = `SELECT * FROM notifications
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC LIMIT ?`;
  const rows = getDb().query<NotificationRow, number[]>(sql).all(...params, limit);
  const items = rows.map(rowToNotification);
  // 取满 limit 才可能有下一页；游标值由调用方传回 before_id
  const next = items.length === limit ? items[items.length - 1].id : null;
  return { items, next_before_id: next };
}

export function unreadCount(): number {
  const row = getDb()
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL",
    )
    .get();
  return row?.n ?? 0;
}

/** 幂等：只更新仍为 NULL 的行；返回实际更新行数 */
export function markRead(ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = getDb().run(
    `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
    [Date.now(), ...ids],
  );
  return Number(result.changes);
}

/**
 * 按关联实体批量已读（幂等），返回实际被清掉的通知 id（供调用方广播
 * notification:read 增量事件）。用途：用户点进任务/需求详情页 = 已经看到
 * 该实体的最新状态，相关未读通知自动消化。
 */
export function markReadByRelated(relatedType: NotificationRelatedType, relatedId: string): number[] {
  const rows = getDb()
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM notifications WHERE read_at IS NULL AND related_type = ? AND related_id = ?",
    )
    .all(relatedType, relatedId);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  markRead(ids);
  return ids;
}

export function markAllRead(): number {
  const result = getDb().run(
    "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND dismissed_at IS NULL",
    [Date.now()],
  );
  return Number(result.changes);
}

/** 幂等；返回是否存在该通知 */
export function dismissNotification(id: number): boolean {
  if (!getNotification(id)) return false;
  getDb().run(
    "UPDATE notifications SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL",
    [Date.now(), id],
  );
  return true;
}

export interface PruneOptions {
  retention_days?: number;
  max_rows?: number;
}

/** 保留策略：默认 30 天 + 上限 500 行（先按天删，再删溢出的最旧行） */
export function pruneNotifications(opts: PruneOptions = {}): number {
  const days = opts.retention_days ?? 30;
  const maxRows = opts.max_rows ?? 500;
  const cutoff = Date.now() - days * 24 * 3600_000;
  const db = getDb();
  const byAge = db.run("DELETE FROM notifications WHERE created_at < ?", [cutoff]);
  const byCount = db.run(
    `DELETE FROM notifications WHERE id IN (
       SELECT id FROM notifications ORDER BY id DESC LIMIT -1 OFFSET ?
     )`,
    [maxRows],
  );
  return Number(byAge.changes) + Number(byCount.changes);
}
