import type { Server } from "bun";
import { handleRequest } from "./routes";
import { wsManager } from "./ws";

// ──────────────────────────────────────────────
// Bun.serve() — HTTP + WebSocket 统一服务
// ──────────────────────────────────────────────

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
