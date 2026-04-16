#!/usr/bin/env bun
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
