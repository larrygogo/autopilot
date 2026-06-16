/**
 * 流水线页纯逻辑：run 多历史过滤（v2 R2）——每需求只显示 requirement.task_id
 * 指向的最新 run，历史 run 不铺行。
 */
import { describe, it, expect } from "bun:test";
import { filterLatestRunTasks } from "../src/web/src/lib/pipeline-logic";

const t = (id: string, reqId?: string | null) => ({ id, requirement_id: reqId ?? null });

describe("filterLatestRunTasks", () => {
  it("需求有多个历史 run 时只保留 task_id 指向的最新 run", () => {
    const tasks = [t("run1", "req-1"), t("run2", "req-1"), t("run3", "req-1")];
    const reqById = { "req-1": { task_id: "run3" } };
    expect(filterLatestRunTasks(tasks, reqById).map((x) => x.id)).toEqual(["run3"]);
  });

  it("无关联需求的任务照旧显示", () => {
    const tasks = [t("orphan", null), t("run1", "req-1")];
    const reqById = { "req-1": { task_id: "run1" } };
    expect(filterLatestRunTasks(tasks, reqById).map((x) => x.id)).toEqual(["orphan", "run1"]);
  });

  it("需求不在列表（已删等）→ 任务照旧显示，不误吞", () => {
    const tasks = [t("run1", "req-gone")];
    expect(filterLatestRunTasks(tasks, {}).map((x) => x.id)).toEqual(["run1"]);
  });

  it("需求 task_id 为空 → 关联任务隐藏（需求行自己代表这件工作）", () => {
    const tasks = [t("run1", "req-1")];
    const reqById = { "req-1": { task_id: null } };
    expect(filterLatestRunTasks(tasks, reqById)).toEqual([]);
  });

  it("多需求互不影响", () => {
    const tasks = [t("a1", "req-a"), t("a2", "req-a"), t("b1", "req-b")];
    const reqById = { "req-a": { task_id: "a2" }, "req-b": { task_id: "b1" } };
    expect(filterLatestRunTasks(tasks, reqById).map((x) => x.id)).toEqual(["a2", "b1"]);
  });
});
