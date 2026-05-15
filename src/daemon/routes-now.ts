import type { Aggregator } from "../core/now-aggregator";

let _aggregator: Aggregator | null = null;

/** 由 daemon 启动逻辑注入；测试也用此注入 fake aggregator。 */
export function setNowAggregator(agg: Aggregator | null): void {
  _aggregator = agg;
}

/** 给 rpc-methods.ts 用 — daemon 未启动 / 测试未注入时返回 null */
export function getNowAggregator(): Aggregator | null {
  return _aggregator;
}

/**
 * Legacy HTTP /api/now/* 路由已完全移除。所有 now 域操作走 WS RPC method
 * （now.cards / now.dismissCard）。
 *
 * 这个函数保留 export 用作 routes.ts 调用兼容点，让上层继续把请求往下传。
 * 实际命中 /api/now/* 的请求会返回 410 Gone。
 */
export async function handleNowRequest(_req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/now/")) return null;
  return new Response(
    JSON.stringify({ error: "Removed: use WS RPC method `now.cards` / `now.dismissCard`" }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  );
}
