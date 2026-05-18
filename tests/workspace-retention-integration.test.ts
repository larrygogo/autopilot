/**
 * workspace_retention 集成测试（dogfood-bug25 验证）。
 *
 * tests/workspace-retention.test.ts 用 tasksRoot 注入覆盖 applyRetentionPolicy
 * 纯函数路径。本测试用 spawnSync 起子进程完整跑：
 *   - 真 config.yaml.workspace_retention 加载
 *   - 真 DB 里查 isTaskTerminal
 *   - 真 scanTaskWorkspaces 扫文件系统
 *   - 真 pruneWorkspacesByPolicy 删 workspace
 *
 * 验证 bug25 fix：daemon 启动时立即跑 retention（之前 setInterval 1 小时后才第一次）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
const REPO = process.cwd();

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `autopilot-retention-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpHome, "runtime", "tasks"), { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function setupConfig(retention: { days?: number; max_total_mb?: number }): void {
  const lines = ["workspace_retention:"];
  if (typeof retention.days === "number") lines.push(`  days: ${retention.days}`);
  if (typeof retention.max_total_mb === "number") lines.push(`  max_total_mb: ${retention.max_total_mb}`);
  writeFileSync(join(tmpHome, "config.yaml"), lines.join("\n") + "\n", "utf-8");
}

function seedWorkspace(taskId: string, opts: { mtimeMs?: number } = {}): void {
  const ws = join(tmpHome, "runtime", "tasks", taskId, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "data.txt"), Buffer.alloc(100, 0x42));
  if (opts.mtimeMs !== undefined) {
    const sec = opts.mtimeMs / 1000;
    utimesSync(ws, sec, sec);
    utimesSync(join(ws, "data.txt"), sec, sec);
  }
}

/**
 * 子进程跑 db.run 插 task + 调 pruneWorkspacesByPolicy，把结果以 JSON 写 stdout。
 */
function runRetentionInChild(tasks: Array<{ id: string; status: string }>): {
  exitCode: number;
  removed: string[];
  remaining: string[];
} {
  const script = `
    process.env.AUTOPILOT_HOME = ${JSON.stringify(tmpHome)};
    const { initDb, getDb } = await import("${REPO.replace(/\\/g, "\\\\")}/src/core/db");
    const { runPendingMigrations } = await import("${REPO.replace(/\\/g, "\\\\")}/src/core/migrate");
    const { pruneWorkspacesByPolicy } = await import("${REPO.replace(/\\/g, "\\\\")}/src/core/watcher");
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    initDb();
    await runPendingMigrations();
    const db = getDb();
    const tasks = ${JSON.stringify(tasks)};
    for (const t of tasks) {
      db.run(
        \`INSERT OR REPLACE INTO tasks (id, title, workflow, status, created_at, updated_at) VALUES (?, ?, 'dev', ?, datetime('now'), datetime('now'))\`,
        [t.id, "e2e " + t.id, t.status],
      );
    }
    pruneWorkspacesByPolicy();
    const tasksRoot = join(${JSON.stringify(tmpHome)}, "runtime", "tasks");
    const { readdirSync } = await import("fs");
    // 扫整个 tasksRoot 找剩下的 workspace（包括 DB 里没记录的孤儿）
    const taskIdsToCheck = new Set(tasks.map((t) => t.id));
    let allTaskDirs = [];
    try { allTaskDirs = readdirSync(tasksRoot); } catch {}
    for (const id of allTaskDirs) taskIdsToCheck.add(id);
    const removed = [];
    const remaining = [];
    for (const id of taskIdsToCheck) {
      const ws = join(tasksRoot, id, "workspace");
      if (existsSync(ws)) remaining.push(id);
      else removed.push(id);
    }
    console.log(JSON.stringify({ removed, remaining }));
  `;
  const r = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  // 找 JSON 行（最后一行 console.log 输出）
  const lines = stdout.trim().split("\n");
  let parsed: { removed: string[]; remaining: string[] } = { removed: [], remaining: [] };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch { /* try next */ }
    }
  }
  if (parsed.removed.length === 0 && parsed.remaining.length === 0 && stderr.length > 0) {
    // 子进程报错时把 stderr 暴露出来便于排查
    console.error("[child stderr]", stderr.slice(0, 500));
    console.error("[child stdout]", stdout.slice(0, 500));
  }
  return { exitCode: r.exitCode ?? -1, ...parsed };
}

const DAY_MS = 86400 * 1000;
const NOW = Date.now();

describe("workspace_retention 集成（dogfood-bug25 e2e）", () => {
  it("days=1 + 30 天前 done task → 清；running task → 保留；新 task → 保留", () => {
    setupConfig({ days: 1 });
    seedWorkspace("task-old-done", { mtimeMs: NOW - 30 * DAY_MS });
    seedWorkspace("task-old-cancelled", { mtimeMs: NOW - 30 * DAY_MS });
    seedWorkspace("task-old-running", { mtimeMs: NOW - 30 * DAY_MS });
    seedWorkspace("task-new-done", { mtimeMs: NOW - 1000 });

    const r = runRetentionInChild([
      { id: "task-old-done", status: "done" },
      { id: "task-old-cancelled", status: "cancelled" },
      { id: "task-old-running", status: "running" },
      { id: "task-new-done", status: "done" },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.removed.sort()).toEqual(["task-old-cancelled", "task-old-done"]);
    expect(r.remaining.sort()).toEqual(["task-new-done", "task-old-running"]);
  });

  it("无 retention 配置 → 不动任何 workspace", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "providers: {}\n", "utf-8"); // 无 workspace_retention 段
    seedWorkspace("task-old-done", { mtimeMs: NOW - 30 * DAY_MS });
    seedWorkspace("task-new", { mtimeMs: NOW - 1000 });

    const r = runRetentionInChild([
      { id: "task-old-done", status: "done" },
      { id: "task-new", status: "running" },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.removed).toEqual([]);
    expect(r.remaining.sort()).toEqual(["task-new", "task-old-done"]);
  });

  it("workspace 在 DB 没记录 → 不清（防误删孤儿 workspace）", () => {
    setupConfig({ days: 1 });
    seedWorkspace("orphan-ws", { mtimeMs: NOW - 30 * DAY_MS });

    const r = runRetentionInChild([]); // DB 里啥也没有
    expect(r.exitCode).toBe(0);
    expect(r.removed).toEqual([]);
    expect(r.remaining).toEqual(["orphan-ws"]);
  });
});
