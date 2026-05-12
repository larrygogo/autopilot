import type { Aggregator } from "../core/now-aggregator";
import { dismissCard } from "../core/now-dismiss";

let _aggregator: Aggregator | null = null;

/** 由 daemon 启动逻辑注入；测试也用此注入 fake aggregator。 */
export function setNowAggregator(agg: Aggregator | null): void {
  _aggregator = agg;
}

/**
 * 处理 /api/now/* 路由。返回 null 表示路径不归本模块管，让上层继续路由。
 */
export async function handleNowRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith("/api/now/")) return null;

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  // GET /api/now/cards
  if (method === "GET" && path === "/api/now/cards") {
    if (!_aggregator) return json({ cards: [] });
    return json({ cards: _aggregator.getCards() });
  }

  // POST /api/now/cards/:id/dismiss
  const dismissMatch = path.match(/^\/api\/now\/cards\/([^/]+)\/dismiss$/);
  if (method === "POST" && dismissMatch) {
    const cardId = decodeURIComponent(dismissMatch[1]);
    // 持久化 dismiss
    dismissCard(cardId);
    // 同步 aggregator 内存状态（也会 emit now:card_removed）
    if (_aggregator) _aggregator.markDismissed(cardId);
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}
