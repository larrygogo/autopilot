import type { Database } from "bun:sqlite";

/** requirements 表加 schedule_error 字段：调度器 tickRepo 起 task 失败（工作流加载失败 /
 *  setup 出错 / worktree 建失败等）回滚 ready 时 set 错误原因，成功起 task 时 clear。
 *  让用户在需求页直接看到「为什么反复退回 ready / 没开跑」，而不必翻 daemon.log。 */
export function up(db: Database): void {
  db.run("ALTER TABLE requirements ADD COLUMN schedule_error TEXT DEFAULT NULL");
}
