import type { Database } from "bun:sqlite";

/** requirements 表加 clarifier_error 字段：clarifier 失败时 set 错误原因，
 *  成功时 clear。让前端跨重启 / 跨 navigation 都能看到错误状态。 */
export function up(db: Database): void {
  db.run("ALTER TABLE requirements ADD COLUMN clarifier_error TEXT DEFAULT NULL");
}
