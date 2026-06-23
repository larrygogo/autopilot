/**
 * 红线守卫：executor 目录不得耦合状态机 / 调度器 / DB / task 事件系统。
 *
 * 精确策略：
 *   1. 先剥注释（行注释 + 块注释），再对剩余代码跑正则。
 *      — 防止注释里出现 createTask(...) 示例被误判为违规。
 *   2. 禁止 import 路径：检测 import 语句的 from 'path' 里出现受限模块名。
 *   3. 禁止真实调用：createTask( 或 emit( 出现在非注释代码中。
 */

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/** 剥 JS/TS 注释（行注释 + 块注释），返回纯代码字符串。 */
function stripComments(src: string): string {
  // 先剥块注释（/* ... */），再剥行注释（// ...）
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("executor 不得 import 状态机/调度器/db、不得调用 createTask/emit", () => {
  const dir = join(import.meta.dir, "..", "src", "core", "executor");

  /**
   * import 路径红线：from '...' 里不得含以下模块名。
   * 覆盖：相对路径（../../state-machine）、别名路径均能匹配。
   */
  const bannedImportPattern =
    /from\s+['"][^'"]*(?:state-machine|requirement-scheduler|run-outcome|requirement-task-bridge|\/db)['"]/;

  /**
   * 调用红线：createTask( 或 emit( 出现在非注释代码中。
   * \b 确保前缀不是字母/数字（避免 ensureCodebase 中的 emit 变体误匹配）。
   */
  const bannedCallPattern = /\b(?:createTask|emit)\s*\(/;

  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length, "executor 目录应有至少 1 个 .ts 文件").toBeGreaterThan(0);

  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const code = stripComments(raw);

    expect(
      bannedImportPattern.test(code),
      `[${f}] 不得 import state-machine / requirement-scheduler / run-outcome / requirement-task-bridge / core/db`,
    ).toBe(false);

    expect(
      bannedCallPattern.test(code),
      `[${f}] 不得调用 createTask() 或 emit()`,
    ).toBe(false);
  }
});
