/**
 * 地基：per-task MCP taskId 透传。
 *
 * 实证 ALS 不跨 HTTP 边界（probe 已坐实工具 handler 拿不到 taskId）后的修复：
 * ① writePerTaskMcpConfig 把 taskId/phase 注入 mcp-config headers；
 * ② mcp-server 的 wrapCall（routes 用 runWithTaskContext 实现）让工具 handler
 *    的 getTaskContext() 在 inbound 路径下正确归位。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { writePerTaskMcpConfig } from "../src/agents/mcp-task-config";
import { handleMcpHttp } from "../src/agents/mcp-server";
import { runWithTaskContext, getTaskContext } from "../src/core/task/context";
import type { RegisteredTool } from "../src/agents/mcp-tools";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `autopilot-geba-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("writePerTaskMcpConfig 注入 task 标识 header", () => {
  it("从全局 config 派生，注入 X-Autopilot-Task / X-Autopilot-Phase，保留原 Authorization", () => {
    const base = join(tmpDir, "mcp-config.json");
    writeFileSync(
      base,
      JSON.stringify({
        mcpServers: { autopilot: { type: "http", url: "http://127.0.0.1:6180/mcp", headers: { Authorization: "Bearer abc" } } },
      }),
      "utf-8",
    );
    const outDir = join(tmpDir, "mcp-task-configs");

    const out = writePerTaskMcpConfig(base, "task1234", "develop", outDir);
    const derived = JSON.parse(readFileSync(out, "utf-8"));
    const headers = derived.mcpServers.autopilot.headers;
    expect(headers["Authorization"]).toBe("Bearer abc");
    expect(headers["X-Autopilot-Task"]).toBe("task1234");
    expect(headers["X-Autopilot-Phase"]).toBe("develop");
    expect(out.endsWith("task1234.json")).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  it("基础 config 无 headers 段也能派生（容错）", () => {
    const base = join(tmpDir, "mcp-config.json");
    writeFileSync(base, JSON.stringify({ mcpServers: { autopilot: { type: "http", url: "x" } } }), "utf-8");
    const out = writePerTaskMcpConfig(base, "t5", "p", join(tmpDir, "out"));
    const headers = JSON.parse(readFileSync(out, "utf-8")).mcpServers.autopilot.headers;
    expect(headers["X-Autopilot-Task"]).toBe("t5");
  });
});

describe("wrapCall 让工具 handler 在 inbound 路径拿到 task 上下文", () => {
  // 一个直接读 getTaskContext() 的探针工具（与 ask_user / submit_decision 同款依赖）
  const probeTool: RegisteredTool = {
    name: "probe_ctx",
    description: "返回当前 task 上下文",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const ctx = getTaskContext();
      return { content: [{ type: "text", text: JSON.stringify({ taskId: ctx?.taskId ?? null, phase: ctx?.phase ?? null }) }] };
    },
  };

  async function callProbe(opts: Parameters<typeof handleMcpHttp>[1]): Promise<{ taskId: string | null; phase: string | null }> {
    const req = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe_ctx", arguments: {} } }),
    });
    const res = await handleMcpHttp(req, opts);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    return JSON.parse(body.result.content[0].text);
  }

  it("无 wrapCall（现状）→ handler 拿不到 taskId（复现 probe 结论）", async () => {
    const seen = await callProbe({ token: "", getTools: () => [probeTool] });
    expect(seen.taskId).toBeNull();
  });

  it("有 wrapCall（runWithTaskContext 重建）→ handler 正确拿到 taskId/phase", async () => {
    const seen = await callProbe({
      token: "",
      getTools: () => [probeTool],
      wrapCall: (fn) => runWithTaskContext({ taskId: "TASK-42", phase: "review" }, fn),
    });
    expect(seen.taskId).toBe("TASK-42");
    expect(seen.phase).toBe("review");
  });
});
