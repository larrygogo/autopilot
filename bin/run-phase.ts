#!/usr/bin/env bun
import { installAutopilotResolver } from "../src/core/autopilot-resolver";
// 在任何用户工作流被 dynamic import 前安装别名解析器
installAutopilotResolver();

import { discover } from "../src/core/registry";
import { initDb } from "../src/core/db";
import { executePhase } from "../src/core/runner";

const [taskId, phase] = process.argv.slice(2);
if (!taskId || !phase) {
  console.error("用法: bun run bin/run-phase.ts <task_id> <phase>");
  process.exit(1);
}

initDb();
await discover();
await executePhase(taskId, phase);
