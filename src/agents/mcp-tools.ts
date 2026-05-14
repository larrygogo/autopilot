// ──────────────────────────────────────────────
// MCP 工具定义层
//
// 取代 @anthropic-ai/claude-agent-sdk 的 `tool()` API。业务代码（tools.ts）
// 使用 `defineTool(name, description, zodShape, handler)` 注册工具；
// 这里负责把 zod shape 转成 JSON Schema，并打包成 RegisteredTool。
//
// 类型推导链：z.ZodRawShape → z.ZodObject<S> → z.infer 给 handler 提供精确入参类型。
// ──────────────────────────────────────────────

import { z, type ZodRawShape, type ZodObject } from "zod";

export interface ToolContent {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * 第二个 `_extra` 参数仅为兼容 SDK 的老签名 `(args, extra)`，
 * 我们的实现里不使用；调用方可省略。
 */
export type ToolHandler<I = Record<string, unknown>> = (input: I, _extra?: unknown) => Promise<ToolContent>;

export interface RegisteredTool {
  name: string;
  description: string;
  /** JSON Schema（MCP tools/list 直接透传给客户端） */
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

/**
 * 定义一个 MCP 工具。
 *
 * 与 SDK 的 `tool(name, description, schema, handler)` 调用 shape 等价，
 * 把 zod schema 转成 JSON Schema 暴露给 MCP server。
 *
 * 调用 handler 前会用 zod `safeParse` 校验入参：失败时直接返回结构化错误
 * ToolContent（而不是让 handler 拿到错 shape 抛出，被映射成 -32603 内部错误），
 * 给 LLM 一个明确的"参数不合法 + 字段定位"提示，便于自我修正。
 */
export function defineTool<S extends ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: ToolHandler<z.infer<ZodObject<S>>>
): RegisteredTool {
  const obj = z.object(shape);
  // zod 4 内置 toJSONSchema；剥掉顶层 $schema 噪声（additionalProperties: false
  // 保留 —— 它对 LLM 是有用约束，提示不要发送 schema 外的字段）。
  const json = z.toJSONSchema(obj) as Record<string, unknown>;
  delete json["$schema"];

  const wrapped: ToolHandler = async (input, extra) => {
    const parsed = obj.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        content: [{ type: "text", text: `Invalid params: ${detail}` }],
      };
    }
    return handler(parsed.data as z.infer<ZodObject<S>>, extra);
  };

  return {
    name,
    description,
    inputSchema: json,
    handler: wrapped,
  };
}
