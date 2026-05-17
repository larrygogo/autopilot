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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; msg: string }>(null);

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

  // 测试连接：不存 localStorage，直接拿输入框的 token 试 /api/status，
  // 让用户先确认 token 对不对再保存（避免 reload → 401 → 又回到 TokenGate 死循环猜疑）
  async function testConnection() {
    const t = input.trim();
    setTouched(true);
    if (!t) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/status", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.status === 401) {
        setTestResult({ ok: false, msg: "token 错误（HTTP 401）—— 请检查从本机复制时是否带了空格/换行" });
      } else if (!res.ok) {
        setTestResult({ ok: false, msg: `daemon 返回 HTTP ${res.status}` });
      } else {
        setTestResult({ ok: true, msg: "✓ token 验证通过，可以保存" });
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, msg: `网络错误：${(e as Error)?.message ?? String(e)}` });
    } finally {
      setTesting(false);
    }
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
          <p className="mt-2">或在本机浏览器打开 <span className="font-mono">127.0.0.1:6180/settings</span> → 「网络访问 → API 安全令牌 → 显示明文」复制。</p>
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
          {testResult && (
            <p className={`text-xs ${testResult.ok ? "text-success" : "text-destructive"}`}>
              {testResult.msg}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing || !input.trim()}
              className="flex-1 border-[1.5px] border-foreground/30 bg-background px-3 py-2 font-display text-xs font-bold uppercase tracking-wider text-foreground hover:border-accent hover:text-accent disabled:opacity-50 rounded-none"
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="submit"
              className="flex-[2] border-[1.5px] border-foreground bg-foreground px-3 py-2 font-display text-xs font-bold uppercase tracking-wider text-background hover:bg-accent hover:border-accent rounded-none"
            >
              保存并继续
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
