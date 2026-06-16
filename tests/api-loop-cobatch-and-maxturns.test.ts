import { describe, it, expect } from "bun:test";
import { ApiAgentLoop } from "../src/agents/providers/api/loop";
import type { ProviderAdapter, AdapterResponse, MessageParam, AdapterOptions } from "../src/agents/providers/api/types";
import type { ToolExecutor } from "../src/agents/providers/api/tools";

// 最小 fake executor：只记录被执行的工具名（loop 只用 getToolDefinitions + execute）
function fakeExecutor(executed: string[]): ToolExecutor {
  return {
    getToolDefinitions: () => [],
    execute: async ({ name }: { name: string }) => {
      executed.push(name);
      return { output: `ok:${name}`, is_error: false };
    },
  } as unknown as ToolExecutor;
}

function mockAdapter(responses: AdapterResponse[]): ProviderAdapter {
  let i = 0;
  return {
    name: "mock",
    async completeStream(_m: MessageParam[], _o: AdapterOptions): Promise<AdapterResponse> {
      return responses[i++] ?? responses[responses.length - 1];
    },
  };
}

describe("ApiAgentLoop #1：task_complete 与其它工具同轮返回时不丢工具", () => {
  it("同轮 [write_file, task_complete] → write_file 必被执行，再返回 summary", async () => {
    const executed: string[] = [];
    const adapter = mockAdapter([
      {
        text: "我改完了，收尾",
        toolCalls: [
          { id: "c1", name: "write_file", input: { path: "a.txt", content: "x" } },
          { id: "c2", name: "task_complete", input: { summary: "已完成：文件已写" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stopReason: "tool_use",
      },
    ]);
    const loop = new ApiAgentLoop({ adapter, toolExecutor: fakeExecutor(executed), model: "m", maxTurns: 5 });
    const r = await loop.run("做点事并完成");

    // 关键：write_file 不能被 task_complete 短路丢弃
    expect(executed).toContain("write_file");
    // task_complete 本身不作为普通工具执行
    expect(executed).not.toContain("task_complete");
    // summary 作为最终文本返回
    expect(r.text).toBe("已完成：文件已写");
  });

  it("纯 task_complete 一轮 → 不执行任何工具，直接返回 summary（行为不回归）", async () => {
    const executed: string[] = [];
    const adapter = mockAdapter([
      { text: "", toolCalls: [{ id: "c1", name: "task_complete", input: { summary: "done" } }], usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" },
    ]);
    const loop = new ApiAgentLoop({ adapter, toolExecutor: fakeExecutor(executed), model: "m", maxTurns: 5 });
    const r = await loop.run("完成");
    expect(executed).toHaveLength(0);
    expect(r.text).toBe("done");
  });
});

describe("ApiAgentLoop #22：tool_call args 被截断（_raw）时拦在执行前回 is_error", () => {
  it("同轮 [write_file(_raw 截断), list_directory(正常)] → 只执行正常工具，截断的不进 execute", async () => {
    const executed: string[] = [];
    const adapter = mockAdapter([
      {
        text: "",
        toolCalls: [
          // adapter 对 JSON.parse 失败的 args 回退成 {_raw:原始串}（典型成因 finish_reason=length 截断）
          { id: "c1", name: "write_file", input: { _raw: '{"path":"a.txt","content":"被截断的超长内容' } },
          { id: "c2", name: "list_directory", input: { path: "." } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stopReason: "tool_use",
      },
      { text: "", toolCalls: [{ id: "c3", name: "task_complete", input: { summary: "done" } }], usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" },
    ]);
    const loop = new ApiAgentLoop({ adapter, toolExecutor: fakeExecutor(executed), model: "m", maxTurns: 5 });
    const r = await loop.run("写文件并列目录");

    // _raw 截断工具拦在执行前、不进 execute；同批正常工具照常执行（选择性拦截，不误伤）
    expect(executed).not.toContain("write_file");
    expect(executed).toContain("list_directory");
    // 截断工具回了 is_error 反馈，循环继续到 task_complete
    expect(r.text).toBe("done");
  });
});

describe("ApiAgentLoop #3：maxTurns 耗尽且末轮纯工具调用时不返回空 text", () => {
  it("每轮 {text:'', toolCalls:[bash]} 撞 maxTurns → result.text 非空兜底", async () => {
    const executed: string[] = [];
    const adapter = mockAdapter([
      { text: "", toolCalls: [{ id: "c1", name: "bash", input: { command: "echo 1" } }], usage: { input_tokens: 5, output_tokens: 0 }, stopReason: "tool_use" },
    ]);
    const loop = new ApiAgentLoop({ adapter, toolExecutor: fakeExecutor(executed), model: "m", maxTurns: 2 });
    const r = await loop.run("一直调工具");

    expect(r.text.trim().length).toBeGreaterThan(0); // 不再是空串
    expect(r.text).toContain("最大轮次"); // 明确的截断兜底文案
  });
});
