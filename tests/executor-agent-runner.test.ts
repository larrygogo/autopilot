// tests/executor-agent-runner.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ghostTaskIdFor, runRoundAgent } from "../src/core/executor/agent-runner";
import { getCurrentSandboxDir, getTaskContext } from "../src/core/task/context";
import { onEvent, offEvent, enableBus, disableBus } from "../src/core/event-bus";

// 桩 Agent：实现 run(prompt) → 读 context 证明注入，返回固定文本
const stubAgent = {
  name: "stub",
  async run(_prompt: string) {
    return { text: `sandbox=${getCurrentSandboxDir() ?? "none"}`, usage: undefined };
  },
} as any;

// 桩 Agent：回读 context.taskId，用于验证幽灵 taskId 的取值
const taskIdAgent = {
  name: "stub-taskid",
  async run(_prompt: string) {
    return { text: `task=${getTaskContext()?.taskId ?? "none"}`, usage: undefined };
  },
} as any;

test("runRoundAgent：注入 sandboxDir 到 context，且不发 task:created", async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "exec-ar-"));
  let sawTaskCreated = false;
  const handler = (ev: { type: string }) => { if (ev.type === "task:created") sawTaskCreated = true; };
  enableBus();                          // 必须激活总线：emit 仅 enableBus 后生效，否则永不触发=假绿
  onEvent("task:created", handler);
  try {
    const res = await runRoundAgent(
      { sessionId: "sess-abc-1", phase: "dev", sandboxDir },
      stubAgent,
      "hi",
    );
    expect(res.text).toBe(`sandbox=${sandboxDir}`);
    expect(sawTaskCreated).toBe(false); // 幽灵 task 不建 DB 行、不发 task:created
  } finally { offEvent("task:created", handler); disableBus(); }
});

test("runRoundAgent：显式 ghostTaskId 时用它，不走 sessionId 派生", async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "exec-ar-"));
  const res = await runRoundAgent(
    { sessionId: "sess-xyz", phase: "dev", sandboxDir, ghostTaskId: "ghost-explicit-1" },
    taskIdAgent,
    "hi",
  );
  expect(res.text).toBe("task=ghost-explicit-1");
  // 反证：未传 ghostTaskId 时会走派生（rs-sess-xyz），与显式值不同
  expect("ghost-explicit-1").not.toBe(ghostTaskIdFor("sess-xyz"));
});
