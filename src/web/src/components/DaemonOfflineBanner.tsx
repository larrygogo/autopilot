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
import { RotateCcw, Copy, WifiOff, Check } from "lucide-react";
import type { ConnectionState } from "@/hooks/useWebSocket";

/** 进入 disconnected 多久后才显示（毫秒） — 避免页面切换 / 短暂闪断刷红条 */
const SHOW_AFTER_MS = 5000;

const DAEMON_START_CMD = "autopilot daemon start";

export function DaemonOfflineBanner({ wsState }: { wsState: ConnectionState }) {
  const [shouldShow, setShouldShow] = useState(false);
  const [copied, setCopied] = useState(false);

  // wsState 变化时启动 / 取消"5s 后显示"计时
  useEffect(() => {
    if (wsState === "connected") {
      setShouldShow(false);
      return;
    }
    // connecting 或 disconnected 都启计时，超过门槛仍未 connected 才显示
    const timer = setTimeout(() => setShouldShow(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [wsState]);

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

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b-[1.5px] border-destructive/60 bg-destructive/10 px-4 py-2 text-destructive"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 font-mono text-xs">
        <span className="font-bold uppercase tracking-[0.14em]">Daemon 失联</span>
        <span className="ml-2 text-destructive/80">
          · 数据可能已过期，所有操作会失败
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleCopyCmd}
          className="inline-flex items-center gap-1.5 border-[1.5px] border-destructive/60 bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-destructive hover:bg-destructive/5"
          title="复制启动命令"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : DAEMON_START_CMD}
        </button>
        <button
          type="button"
          onClick={handleReconnect}
          className="inline-flex items-center gap-1.5 bg-destructive px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-destructive-foreground hover:bg-destructive/85"
        >
          <RotateCcw className="h-3 w-3" />
          重新连接
        </button>
      </div>
    </div>
  );
}
