import type { Database } from "bun:sqlite";

/** requirements 加 workflow 列：每个需求可选择用哪个工作流执行（调度器消费，
 *  替代此前 scheduler 里硬编码的 "dev"）。NULL = 未显式选择，调度时回退默认 dev。
 *  与 title/spec 同属「审批签字内容」：审批后冻结，failed 可改后重试（换流程重跑）。 */
export function up(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirements)").all();
  if (!cols.some((c) => c.name === "workflow")) {
    db.run("ALTER TABLE requirements ADD COLUMN workflow TEXT DEFAULT NULL");
  }
}
