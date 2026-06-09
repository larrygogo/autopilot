import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask, updateTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { computeTaskOutcome, computeDiffStatFromPatch } from "../src/daemon/task-outcome";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("computeTaskOutcome", () => {
  it("非终态返回 null", async () => {
    createTask({ id: "task-001", title: "x", workflow: "dev", initialStatus: "running_design" });
    const o = await computeTaskOutcome("task-001");
    expect(o).toBeNull();
  });

  it("终态返回 outcome，包含 total_duration_ms + top_phases", async () => {
    createTask({ id: "task-002", title: "x", workflow: "dev", initialStatus: "running_design" });
    const a = startTaskPhase("task-002", "design");
    await new Promise((r) => setTimeout(r, 10));
    endTaskPhase(a, "done");
    const b = startTaskPhase("task-002", "review");
    await new Promise((r) => setTimeout(r, 20));
    endTaskPhase(b, "done");
    updateTask("task-002", { status: "done" });

    const o = await computeTaskOutcome("task-002");
    expect(o).not.toBeNull();
    expect(o!.status).toBe("done");
    expect(o!.total_duration_ms).toBeGreaterThan(0);
    expect(o!.top_phases.length).toBeGreaterThan(0);
    expect(o!.top_phases[0]!.duration_ms).toBeGreaterThanOrEqual(o!.top_phases[o!.top_phases.length - 1]!.duration_ms);
  });

  it("workspace 不存在 → diff_stat = null", async () => {
    createTask({ id: "task-003", title: "x", workflow: "dev", initialStatus: "done" });
    const o = await computeTaskOutcome("task-003");
    expect(o!.diff_stat).toBeNull();
  });

});

// 即焚模型下代码改动唯一可靠来源是 cumulative.patch（源仓库零痕迹、即焚副本已销毁）。
// 纯函数直接单测，不经 AUTOPILOT_HOME（其为 import 期冻结常量，测试改 env 不生效）。
describe("computeDiffStatFromPatch（EPH-02）", () => {
  it("解析 unified diff：files/insertions/deletions，正确排除 +++/--- 文件头", () => {
    const patchPath = join(tmpHome, "cumulative.patch");
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 000..111 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old line",
      "+new line 1",
      "+new line 2",
      "diff --git a/bar.ts b/bar.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/bar.ts",
      "@@ -0,0 +1 @@",
      "+only added",
      "",
    ].join("\n");
    writeFileSync(patchPath, patch, "utf-8");
    // files=2（两个 diff --git）；insertions=3（+ 行，排除两行 +++）；deletions=1（- 行，排除两行 ---）
    expect(computeDiffStatFromPatch(patchPath)).toEqual({ files: 2, insertions: 3, deletions: 1 });
  });

  it("空 patch → 全 0（非 null）", () => {
    const patchPath = join(tmpHome, "empty.patch");
    writeFileSync(patchPath, "", "utf-8");
    expect(computeDiffStatFromPatch(patchPath)).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("patch 文件不存在 → null", () => {
    expect(computeDiffStatFromPatch(join(tmpHome, "nope.patch"))).toBeNull();
  });
});
