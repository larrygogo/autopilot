import { describe, it, expect } from "bun:test";
import { trimMessagesToFitContext } from "../src/agents/providers/api/loop";
import type { MessageParam } from "../src/agents/providers/api/types";

// 回归：trimMessagesToFitContext 旧实现按固定 2 条成对 splice，被首条 user 错位后会把
// tool_result 留成 orphan（其 assistant tool_call 已被丢）→ OpenAI 兼容端（kimi 等）
// 报 400「tool_call_id is not found」。实测 dev-kimi design 读大仓库致 input 超限触发
// 裁剪 → 400 → design 阶段误失败。修复后裁剪必须保留 tool_call/tool_result 配对。

function assistantToolCall(id: string): MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read_file", input: { path: "x" } }],
  } as unknown as MessageParam;
}
function bigToolResult(id: string): MessageParam {
  return {
    role: "tool_result",
    content: [{ type: "tool_result", tool_use_id: id, content: "X".repeat(40_000) }],
  } as unknown as MessageParam;
}

describe("trimMessagesToFitContext：裁剪保留 tool_call/tool_result 配对", () => {
  it("超限裁剪后不留 orphan tool_result（否则 OpenAI 兼容端 400）", () => {
    const msgs: MessageParam[] = [
      { role: "system", content: "你是架构师" },
      { role: "user", content: "任务 prompt" },
    ];
    for (let i = 0; i < 12; i++) {
      msgs.push(assistantToolCall(`call_${i}`));
      msgs.push(bigToolResult(`call_${i}`));
    }

    const out = trimMessagesToFitContext(msgs, "unknown-model", 9_999_999);

    // system + user 前缀永不裁
    expect(out[0]!.role).toBe("system");
    expect(out[1]!.role).toBe("user");
    // 确实发生了裁剪
    expect(out.length).toBeLessThan(msgs.length);
    // 第一条非前缀消息不能是 tool_result（那就是 orphan）
    expect(out[2]?.role).not.toBe("tool_result");
    // 任意 tool_result 都紧跟在 assistant 之后（无孤儿）
    for (let i = 2; i < out.length; i++) {
      if (out[i]!.role === "tool_result") {
        expect(out[i - 1]!.role).toBe("assistant");
      }
    }
  });

  it("无 system 前缀（仅 user 起头）也不留 orphan", () => {
    const msgs: MessageParam[] = [{ role: "user", content: "prompt" }];
    for (let i = 0; i < 10; i++) {
      msgs.push(assistantToolCall(`c${i}`));
      msgs.push(bigToolResult(`c${i}`));
    }
    const out = trimMessagesToFitContext(msgs, "unknown-model", 9_999_999);
    expect(out[0]!.role).toBe("user");
    expect(out[1]?.role).not.toBe("tool_result");
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.role === "tool_result") expect(out[i - 1]!.role).toBe("assistant");
    }
  });

  it("未超限时原样返回（同一引用）", () => {
    const msgs: MessageParam[] = [
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
      assistantToolCall("c1"),
      bigToolResult("c1"),
    ];
    const out = trimMessagesToFitContext(msgs, "unknown-model", 100);
    expect(out).toBe(msgs);
  });
});
