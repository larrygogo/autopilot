import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 所有测试在子进程里跑（AUTOPILOT_HOME 注入），避免污染主 process.env

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function runChild(script: string): Promise<string> {
  return (async () => {
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      env: { ...process.env, AUTOPILOT_HOME: tmpHome },
    });
    await proc.exited;
    return (await new Response(proc.stdout).text()).trim();
  })();
}

describe("task-logs 落盘与读取", () => {
  it("appendPhaseLog 追加行 + readPhaseLog 回读", async () => {
    const script = `
import { appendPhaseLog, readPhaseLog, listPhaseLogs } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
appendPhaseLog("t1", "step1", "first line");
appendPhaseLog("t1", "step1", "second line\\n");  // 已含换行，不重复补
appendPhaseLog("t1", "step2", "another phase");
const list = listPhaseLogs("t1");
const s1 = readPhaseLog("t1", "step1");
console.log(JSON.stringify({ list: list.map(p => p.phase).sort(), s1 }));
`;
    const out = await runChild(script);
    const { list, s1 } = JSON.parse(out);
    expect(list).toEqual(["step1", "step2"]);
    expect(s1).toContain("first line");
    expect(s1).toContain("second line");
    // 每条日志一行，且不重复换行
    expect(s1.split("\n").filter((l: string) => l).length).toBe(2);
  });

  it("readPhaseLog tail 限制", async () => {
    const script = `
import { appendPhaseLog, readPhaseLog } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
for (let i = 1; i <= 10; i++) appendPhaseLog("t2", "p", "line " + i);
const all = readPhaseLog("t2", "p", { tail: 3 });
console.log(JSON.stringify(all.trim().split("\\n")));
`;
    const out = await runChild(script);
    const lines = JSON.parse(out);
    expect(lines).toEqual(["line 8", "line 9", "line 10"]);
  });

  it("appendTaskEvent + readTaskEvents", async () => {
    const script = `
import { appendTaskEvent, readTaskEvents } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
appendTaskEvent("t3", { type: "phase-started", phase: "a" });
appendTaskEvent("t3", { type: "phase-completed", phase: "a" });
appendTaskEvent("t3", { type: "transition", from: "pending_a", to: "running_a", trigger: "start_a" });
const events = readTaskEvents("t3");
console.log(JSON.stringify(events.map(e => e.type)));
`;
    const out = await runChild(script);
    expect(JSON.parse(out)).toEqual(["phase-started", "phase-completed", "transition"]);
  });

  it("非法 phase 名被拒绝 append", async () => {
    const script = `
import { appendPhaseLog, listPhaseLogs } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
// 非法字符 —— appendFile 路径被拒时 catch 会吞错误
appendPhaseLog("t4", "bad/../name", "x");
appendPhaseLog("t4", "ok_phase", "good");
console.log(JSON.stringify(listPhaseLogs("t4").map(p => p.phase)));
`;
    const out = await runChild(script);
    expect(JSON.parse(out)).toEqual(["ok_phase"]);
  });

  it("agent calls append + list + get", async () => {
    const script = `
import { appendAgentCall, listAgentCalls, getAgentCall } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
appendAgentCall("t5", { agent: "coder", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "write hello world", result_text: "done.", elapsed_ms: 1200, usage: { input_tokens: 10, output_tokens: 20 } });
appendAgentCall("t5", { agent: "reviewer", provider: "anthropic", model: "claude-opus-4-7", prompt: "review code", error: "timeout" });
const list = listAgentCalls("t5");
const one = getAgentCall("t5", 1);
console.log(JSON.stringify({
  count: list.length,
  seqs: list.map(c => c.seq),
  firstPreview: list[0].prompt_preview,
  hasError: !!list[1].error,
  oneFullPrompt: one?.prompt,
}));
`;
    const out = await runChild(script);
    const r = JSON.parse(out);
    expect(r.count).toBe(2);
    expect(r.seqs).toEqual([1, 2]);
    expect(r.firstPreview).toContain("hello world");
    expect(r.hasError).toBe(true);
    expect(r.oneFullPrompt).toBe("write hello world");
  });

  it("没日志目录时 list/read 返回空", async () => {
    const script = `
import { listPhaseLogs, readPhaseLog, readTaskEvents } from "${join(import.meta.dir, "..", "src", "core", "task-logs")}";
// listPhaseLogs 纯检查磁盘，目录未建
console.log(JSON.stringify({
  list: listPhaseLogs("no-such"),
  // read 会触发 taskLogsDir 但不 ensure —— phaseLogPath 会 ensure,所以空串
  content: readPhaseLog("no-such-2", "phase1"),
  events: readTaskEvents("no-such-3"),
}));
`;
    const out = await runChild(script);
    const r = JSON.parse(out);
    expect(r.list).toEqual([]);
    expect(r.content).toBe("");
    expect(r.events).toEqual([]);
  });
});
