import React, { useState } from "react";
import { getApiToken, setApiToken, shouldUseToken } from "../lib/api-token";

/**
 * 局域网访问拦截：当从非 loopback 网卡进入 web 时，daemon 强制 token。
 * 首次访问 localStorage 里没 token → 渲染输入框拦住 App 加载，避免一进来就一片 401。
 *
 * 本机访问（127.0.0.1 / localhost）shouldUseToken() 返回 false，直接透传，零成本。
 */
export function TokenGate({ children }: { children: React.ReactNode }) {
  const [needsToken, setNeedsToken] = useState<boolean>(() => shouldUseToken() && !getApiToken());
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);

  if (!needsToken) return <>{children}</>;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const t = input.trim();
    if (!t) return;
    setApiToken(t);
    setNeedsToken(false);
    // 重新加载页面让 ws-singleton / useApi 用新 token 重连
    location.reload();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md border-[1.5px] border-foreground/30 bg-card p-6">
        <h1 className="font-display text-base font-bold uppercase tracking-wider mb-2">
          需要 API Token
        </h1>
        <p className="text-xs text-muted-foreground leading-relaxed mb-4">
          你正在从局域网（<span className="font-mono">{typeof location !== "undefined" ? location.host : ""}</span>）访问 autopilot daemon。
          daemon 启用了 API token 鉴权，请在本机查看 token 后贴入此处。
        </p>
        <div className="mb-4 border-[1.5px] border-dashed border-foreground/20 bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 font-display font-bold uppercase tracking-wider text-foreground">
            查看 token
          </div>
          <p>在装 daemon 的本机执行：</p>
          <pre className="mt-1 font-mono">cat ~/.autopilot/runtime/api-token</pre>
          <p className="mt-2">或在本机浏览器打开 <span className="font-mono">127.0.0.1:6180/settings</span> → 「客户端 Token」复制。</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            autoFocus
            placeholder="粘贴 token"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full border-[1.5px] border-foreground/30 bg-background px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none rounded-none"
          />
          {touched && !input.trim() && (
            <p className="text-xs text-destructive">请粘贴 token</p>
          )}
          <button
            type="submit"
            className="w-full border-[1.5px] border-foreground bg-foreground px-3 py-2 font-display text-xs font-bold uppercase tracking-wider text-background hover:bg-accent hover:border-accent rounded-none"
          >
            保存并继续
          </button>
        </form>
      </div>
    </div>
  );
}
