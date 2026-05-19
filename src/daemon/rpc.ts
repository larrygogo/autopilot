/**
 * RPC 注册表 — 让 WS 和 HTTP 共用同一组业务 handler。
 *
 * 参考 OpenClaw Gateway 协议：客户端发 `{type:"req", id, method, params}`，
 * 服务端按 method 路由到 handler，返回 `{type:"res", id, ok, payload|error}`。
 *
 * 当前阶段：
 *   - 提供注册 / 查找 / 调用 + 错误标准化能力
 *   - 不替换 HTTP routes（保留 CLI 兼容）；HTTP 和 WS 共用注册的方法
 *   - method 命名约定：`<resource>.<verb>`（如 `tasks.list` / `workflows.get`）
 *
 * 错误模型：handler 抛 RpcError 时直接透传 code/message；抛普通 Error
 * 包成 INTERNAL；未注册的 method 报 METHOD_NOT_FOUND。
 */

import type { ServerWebSocket } from "bun";
import type { RpcError as RpcErrorShape } from "./protocol";

/** RPC 调用上下文 — 让 handler 能拿到底层连接（subscribe / unsubscribe 等 connection-scoped method 用） */
export interface RpcContext {
  /** WS 调用走 ws transport 时填；HTTP transport 不填 */
  ws?: ServerWebSocket<unknown>;
}

export type RpcHandler = (params: unknown, ctx?: RpcContext) => Promise<unknown> | unknown;

export interface RpcRegistration {
  /** method 名，如 "tasks.list" */
  method: string;
  /** 业务处理函数 */
  handler: RpcHandler;
  /** 简短描述，便于未来生成 schema / 文档 */
  description?: string;
}

/** 业务方可抛此错误显式控制返回的 code/message；其他错误一律包成 INTERNAL */
export class RpcError extends Error implements RpcErrorShape {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

const registry = new Map<string, RpcRegistration>();

/** 注册一个 method handler。重复注册会抛错（避免静默覆盖）。 */
export function registerRpcMethod(reg: RpcRegistration): void {
  if (registry.has(reg.method)) {
    throw new Error(`RPC method 重复注册: ${reg.method}`);
  }
  registry.set(reg.method, reg);
}

/** 查询某个 method 是否注册（主要给测试用） */
export function hasRpcMethod(method: string): boolean {
  return registry.has(method);
}

/** 已注册的所有 method 名 — 用于生成自描述 listMethods response */
export function listRpcMethods(): string[] {
  return [...registry.keys()].sort();
}

/**
 * 调用一个 RPC method。永不抛——成功返回 { ok: true, payload }，失败返回
 * { ok: false, error: { code, message } }。调用方按需把结果裹成 `res` frame 即可。
 * ctx 是可选的；走 ws transport 时传 { ws }，handler 能拿到底层连接做
 * connection-scoped 操作（如 channels.subscribe）。
 */
export async function invokeRpcMethod(
  method: string,
  params: unknown,
  ctx?: RpcContext,
): Promise<{ ok: true; payload: unknown } | { ok: false; error: RpcErrorShape }> {
  const reg = registry.get(method);
  if (!reg) {
    return {
      ok: false,
      error: { code: "METHOD_NOT_FOUND", message: `未注册的 method: ${method}` },
    };
  }
  try {
    const payload = await reg.handler(params, ctx);
    return { ok: true, payload };
  } catch (e: unknown) {
    // dogfood-bug32：所有 handler 错误自动加 method 前缀让客户端 toast 时
    // 一眼看出"哪个 API 报的"。例如 "需要 id" → "[tasks.cancel] 需要 id"。
    // 截图给开发排错时不必再追问"你调的哪个接口"。
    if (e instanceof RpcError) {
      return { ok: false, error: { code: e.code, message: `[${method}] ${e.message}` } };
    }
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: { code: "INTERNAL", message: `[${method}] ${raw}` },
    };
  }
}

/** 单测专用：清空注册表，避免跨用例污染 */
export function _resetRpcRegistryForTest(): void {
  registry.clear();
}
