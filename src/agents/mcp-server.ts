// ──────────────────────────────────────────────
// 手写最小 MCP HTTP server（Streamable HTTP transport）
//
// 取代 SDK 的 `createSdkMcpServer`：MCP 现在作为 daemon 的一条 HTTP 路由 /mcp，
// claude code CLI 通过 `--mcp-config` 连入。stateless，零依赖（zod 已存在）。
//
// 实测 claude code 2.1.141 客户端行为（详见 jobs/.../echo.err）：
//   1. POST /mcp `initialize`        → 200 JSON-RPC response
//   2. POST /mcp `notifications/initialized` (no id) → 202 Accepted
//   3. GET  /mcp Accept: text/event-stream → SSE keep-alive（不发数据也行）
//   4. POST /mcp `tools/list`        → 200 JSON-RPC response
//   5. POST /mcp `tools/call`        → 200 JSON-RPC response
//
// 客户端 **不发** `mcp-session-id` header，所以 server 完全可以 stateless。
// ──────────────────────────────────────────────

import type { RegisteredTool } from "./mcp-tools";
import { createLogger } from "../core/logger";

const log = createLogger("mcp-server");

export interface McpServerOptions {
  /** 已注册工具列表（每次请求重新拉取，支持运行时增删；可异步以支持懒构建） */
  getTools: () => RegisteredTool[] | Promise<RegisteredTool[]>;
  /** 鉴权 token；空字符串表示不鉴权（仅本地测试用） */
  token: string;
  serverName?: string;
  serverVersion?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string; data?: unknown } };

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function checkAuth(req: Request, token: string): boolean {
  if (!token) return true;
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") && auth.slice(7) === token;
}

/**
 * 处理单条 JSON-RPC 请求。
 *
 * 返回 null 表示该 RPC 是 notification（无 id），调用方应回 202。
 */
async function handleRpc(
  rpc: JsonRpcRequest,
  opts: McpServerOptions
): Promise<JsonRpcResponse | null> {
  const { method, params, id } = rpc;

  // notifications：无 id，无需响应
  if (id === undefined || method?.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        // 复用客户端的版本号，避免协议协商失败
        protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: {
          name: opts.serverName ?? "autopilot",
          version: opts.serverVersion ?? "1.0.0",
        },
      },
    };
  }

  if (method === "tools/list") {
    const allTools = await opts.getTools();
    const tools = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { jsonrpc: "2.0", id, result: { tools } };
  }

  if (method === "tools/call") {
    const toolName = (params?.["name"] as string | undefined) ?? "";
    const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
    const allTools = await opts.getTools();
    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      return rpcError(id, -32601, `Tool not found: ${toolName}`);
    }
    try {
      const result = await tool.handler(args);
      return { jsonrpc: "2.0", id, result };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("tool call failed: tool=%s err=%s", toolName, msg);
      return rpcError(id, -32603, msg);
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * 处理 MCP HTTP 请求。挂到 daemon 的 /mcp 路由。
 */
export async function handleMcpHttp(req: Request, opts: McpServerOptions): Promise<Response> {
  if (!checkAuth(req, opts.token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // GET：SSE keep-alive。我们不主动 push 任何 server-initiated 通知，
  // 但若返回非 SSE，客户端会每秒重连一次（不影响功能，但污染日志）。
  if (req.method === "GET") {
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // SSE 注释行作 keep-alive ping，每 30s 一次，防止 idle 关连接
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(": connected\n\n"));
        pingTimer = setInterval(() => {
          try { controller.enqueue(enc.encode(": ping\n\n")); }
          catch { /* stream 已关 */ }
        }, 30_000);
      },
      cancel() {
        if (pingTimer) clearInterval(pingTimer);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 支持 batch（spec 允许 array），但 claude 实测发的是单个对象
    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((rpc) => handleRpc(rpc as JsonRpcRequest, opts))
      );
      const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
      if (filtered.length === 0) return new Response(null, { status: 202 });
      return Response.json(filtered);
    }

    const response = await handleRpc(body as JsonRpcRequest, opts);
    if (response === null) return new Response(null, { status: 202 });
    return Response.json(response);
  }

  return new Response("Method Not Allowed", { status: 405 });
}
