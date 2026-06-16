/**
 * Daemon 失联横幅 — 解决"UI 静默僵尸"产品断点。
 *
 * 场景：用户开着 web tab，去终端 `autopilot daemon stop` 升级代码 / 处理别的事。
 * 回到浏览器 tab 时页面看起来好好的，状态条还在说"任务在跑"——其实早就失联了。
 * 之前只有侧栏底部一个小绿点变红，用户根本不看那里。
 *
 * 这里做的事：
 *   - 监听 wsState，进入 disconnected 持续 5s 才显示（避免短暂闪断刷出来吓人）
 *   - 在 header 下方插一根红色横条，文案 + 重连 / 复制启动命令 两个动作
 *   - 重连：reload 整个页面（强重置 WS + 所有 state）
 *   - 复制命令：把 `autopilot daemon start` 塞剪贴板
 *
 * 不引入新设置项 / 数据模型，纯反映已有的连接状态。
 */

import { useEffect, useState } from "react";
import { RotateCcw, Copy, WifiOff, Check, KeyRound } from "lucide-react";
import type { ConnectionState } from "@/hooks/useWebSocket";
import { getApiToken, clearApiToken, shouldUseToken } from "../lib/api-token";

/** 进入 disconnected 多久后才显示（毫秒） — 避免页面切换 / 短暂闪断刷红条 */
const SHOW_AFTER_MS = 5000;

const DAEMON_START_CMD = "autopilot daemon start";

export function DaemonOfflineBanner({ wsState }: { wsState: ConnectionState }) {
  const [shouldShow, setShouldShow] = useState(false);
  const [copied, setCopied] = useState(false);
  // 浏览器 WS API 区分不了「401 被拒」和「网络断」——都表现为连接失败。
  // 远程访问 token 失效时若只显示「Daemon 失联」，用户毫无线索（实际 daemon 活得好好的）。
  // banner 出现时探测一次 /api/status：401 → 鉴权问题，引导重输 token。
  const [authProblem, setAuthProblem] = useState(false);

  // wsState 变化时启动 / 取消"5s 后显示"计时
  useEffect(() => {
    if (wsState === "connected") {
      setShouldShow(false);
      setAuthProblem(false);
      return;
    }
    // connecting 或 disconnected 都启计时，超过门槛仍未 connected 才显示
    const timer = setTimeout(() => setShouldShow(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [wsState]);

  useEffect(() => {
    if (!shouldShow) return;
    const headers: Record<string, string> = {};
    if (shouldUseToken()) {
      const t = getApiToken();
      if (t) headers["Authorization"] = `Bearer ${t}`;
    }
    fetch("/api/status", { headers })
      .then((res) => setAuthProblem(res.status === 401))
      .catch(() => { /* 网络不通 → daemon 真失联，保持默认文案 */ });
  }, [shouldShow]);

  if (!shouldShow || wsState === "connected") return null;

  const handleReconnect = () => {
    window.location.reload();
  };

  const handleCopyCmd = () => {
    navigator.clipboard
      .writeText(DAEMON_START_CMD)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => { /* 静默：剪贴板不可用 */ });
  };

  const handleReenterToken = () => {
    clearApiToken();
    window.location.reload(); // TokenGate 检测到无 token 重新拦截
  };

  if (authProblem) {
    return (
      <div
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-3 border-b border-destructive/60 bg-destructive/10 px-4 py-2 text-destructive"
      >
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 font-mono text-xs">
          <span className="font-bold">鉴权失败</span>
          <span className="ml-2 text-destructive/80">
            · daemon 在线，但当前 API token 无效或已轮换 —— 请在装 daemon 的本机查看最新 token
          </span>
        </div>
        <button
          type="button"
          onClick={handleReenterToken}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-destructive px-2 py-1 text-[10px] text-destructive-foreground hover:bg-destructive/85"
        >
          <KeyRound className="h-3 w-3" />
          重新输入 token
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-destructive/60 bg-destructive/10 px-4 py-2 text-destructive"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 font-mono text-xs">
        <span className="font-bold">Daemon 失联</span>
        <span className="ml-2 text-destructive/80">
          · 数据可能已过期，所有操作会失败
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleCopyCmd}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/60 bg-background px-2 py-1 font-mono text-[10px] text-destructive hover:bg-destructive/5"
          title="复制启动命令"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : DAEMON_START_CMD}
        </button>
        <button
          type="button"
          onClick={handleReconnect}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-2 py-1 text-[10px] text-destructive-foreground hover:bg-destructive/85"
        >
          <RotateCcw className="h-3 w-3" />
          重新连接
        </button>
      </div>
    </div>
  );
}
