/**
 * Phase 5 — schedule.mode=send_prompt 测试（spec §3.6）
 *
 * 覆盖：
 *   - createSchedule mode=send_prompt 必须填 target_task_id + prompt
 *   - fireSchedule(mode=send_prompt) 把 prompt 排队到 target task
 *   - 目标 task 不存在 → disable schedule
 *   - 目标 task 终态 → disable + 写 task event
 *   - mode=start_task（默认）保留原 startTaskFromTemplate 行为
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m022 } from "../src/migrations/022-schedules-send-prompt";
import { _setDbForTest, createTask, getTask } from "../src/core/db";
import { createSchedule, getSchedule } from "../src/core/schedules";
import { runScheduledTasks } from "../src/core/scheduler";

describe("schedule mode=send_prompt", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m019, m022].forEach((fn) => fn(db));
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM schedules");
    db.run("DELETE FROM tasks");
  });

  it("createSchedule mode=send_prompt 缺 target_task_id 报错", () => {
    expect(() =>
      createSchedule({
        name: "ping",
        type: "once",
        run_at: new Date(Date.now() + 60000).toISOString(),
        timezone: "UTC",
        workflow: "send_prompt",
        title: "ping",
        mode: "send_prompt",
        prompt: "ping",
      }),
    ).toThrow(/target_task_id/);
  });

  it("createSchedule mode=send_prompt 缺 prompt 报错", () => {
    expect(() =>
      createSchedule({
        name: "ping",
        type: "once",
        run_at: new Date(Date.now() + 60000).toISOString(),
        timezone: "UTC",
        workflow: "send_prompt",
        title: "ping",
        mode: "send_prompt",
        target_task_id: "t-x",
      }),
    ).toThrow(/prompt/);
  });

  it("fire mode=send_prompt → 排队到 target task", async () => {
    createTask({ id: "t-target", title: "t", workflow: "dev", initialStatus: "running_design" });
    // run_at 为过去 → 立刻到期
    const sch = createSchedule({
      name: "ping",
      type: "once",
      run_at: new Date(Date.now() - 1000).toISOString(),
      timezone: "UTC",
      workflow: "send_prompt",
      title: "ping target",
      mode: "send_prompt",
      target_task_id: "t-target",
      prompt: "周期 nudge",
    });

    await runScheduledTasks();

    const t = getTask("t-target") as unknown as { pending_prompts?: Array<{ prompt: string; source: string }> };
    expect(t.pending_prompts?.length).toBe(1);
    expect(t.pending_prompts?.[0].prompt).toBe("周期 nudge");
    expect(t.pending_prompts?.[0].source).toBe("schedule");

    // once + 已 fire → schedule disabled
    const after = getSchedule(sch.id);
    expect(after?.enabled).toBe(0);
    expect(after?.last_task_id).toBe("t-target");
  });

  it("target task 不存在 → schedule disabled，不报错", async () => {
    const sch = createSchedule({
      name: "ping-nope",
      type: "once",
      run_at: new Date(Date.now() - 1000).toISOString(),
      timezone: "UTC",
      workflow: "send_prompt",
      title: "x",
      mode: "send_prompt",
      target_task_id: "t-nope",
      prompt: "x",
    });
    await runScheduledTasks();
    expect(getSchedule(sch.id)?.enabled).toBe(0);
  });

  it("target task 终态 → schedule disabled", async () => {
    createTask({ id: "t-done", title: "x", workflow: "dev", initialStatus: "done" });
    const sch = createSchedule({
      name: "ping-done",
      type: "once",
      run_at: new Date(Date.now() - 1000).toISOString(),
      timezone: "UTC",
      workflow: "send_prompt",
      title: "x",
      mode: "send_prompt",
      target_task_id: "t-done",
      prompt: "晚了",
    });
    await runScheduledTasks();
    expect(getSchedule(sch.id)?.enabled).toBe(0);
    // task 没被加 pending_prompts（被 TASK_TERMINAL 拒绝）
    const t = getTask("t-done") as unknown as { pending_prompts?: unknown };
    expect(t.pending_prompts).toBeUndefined();
  });

  it("默认 mode=start_task 字段在 schedule 上是 'start_task'", () => {
    const sch = createSchedule({
      name: "regular",
      type: "once",
      run_at: new Date(Date.now() + 60000).toISOString(),
      timezone: "UTC",
      workflow: "dev",
      title: "regular task",
    });
    expect(sch.mode).toBe("start_task");
    expect(sch.target_task_id).toBeNull();
    expect(sch.prompt).toBeNull();
  });
});
