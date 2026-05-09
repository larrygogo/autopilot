import type { Server } from "bun";
import { handleRequest } from "./routes";
import { wsManager } from "./ws";

// ──────────────────────────────────────────────
// Bun.serve() — HTTP + WebSocket 统一服务
// ──────────────────────────────────────────────

export async function startServerWithRetry(opts: { host: string; port: number }): Promise<Server<undefined>> {
  // Windows 上 daemon 异常退出后 TCP 表会保留 stale socket（PID 已死但 LISTENING 仍显示），
  // 通常 30~120s 自然收敛。重试 6 次 × 5s = 30s 给一个合理的窗口。
  const maxAttempts = 6;
  const retryDelayMs = 5000;
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return startServer(opts);
    } catch (e: unknown) {
      lastErr = e;
      const msg = (e as Error)?.message ?? String(e);
      if (!/EADDRINUSE|in use/i.test(msg) || i === maxAttempts) throw e;
      console.warn(`[daemon] 端口 ${opts.port} 被占用（可能是 Windows stale socket），${retryDelayMs / 1000}s 后第 ${i + 1}/${maxAttempts} 次重试…`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

export function startServer(opts: { host: string; port: number }): Server<undefined> {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    // Bun 默认 10s，对空闲 keep-alive 连接过于激进，拉长到 120s
    idleTimeout: 120,

    async fetch(req, server) {
      // WebSocket 升级
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const success = server.upgrade(req);
        if (success) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return handleRequest(req);
    },

    websocket: {
      open(ws) {
        wsManager.register(ws);
      },
      close(ws) {
        wsManager.unregister(ws);
      },
      message(ws, message) {
        wsManager.handleMessage(ws, message as string | Buffer);
      },
    },
  });

  return server;
}
