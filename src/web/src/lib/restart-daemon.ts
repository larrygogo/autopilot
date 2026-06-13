// daemon 重启 + 等待重连的共享流程。
// 复用于「网络访问改 host/port」（NetworkAccessCard）与「Daemon 设置重启按钮」。
//
// 流程：快照旧 git_sha → daemon.restart（supervisor exit 75 respawn）→ 锁 WS RPC
// （防重启窗口期 mutation 卡 5s）→ 轮询 getDaemonListen 等新进程起来 → 拿新 sha
// 对比给「代码切换」信号 → 解锁。超时回退刷新页面。
import { api, type DaemonListenInfo } from "@/hooks/useApi";
import { setRestarting } from "@/lib/ws-singleton";
import type { ToastApi } from "@/components/Toast";

/**
 * 触发 daemon 重启并等待其重新上线。
 * @returns 重启后最新监听信息（成功）；restart 调用失败 / 等待超时返回 null
 *   （已 toast 出错因 / 超时已安排刷新兜底）。
 */
export async function restartDaemonAndWait(toast: ToastApi): Promise<DaemonListenInfo | null> {
  // 重启前记下旧 git_sha，重启完拿新 sha 对比展示「代码切换」
  let prevSha: string | undefined;
  try { prevSha = (await api.getStatus()).git_sha; } catch { /* 容错 */ }

  try {
    await api.restartDaemon();
  } catch (e: unknown) {
    // restart 调用本身失败（如 daemon 已退出未起完）— 提示手动 restart 兜底
    toast.error("自动重启失败，请手动执行 `autopilot daemon restart`", (e as Error)?.message ?? String(e));
    return null;
  }

  // restart RPC 已发出，daemon 150ms 后 exit。锁定 WS RPC 防用户在重启窗口期
  // 发出的 mutation 卡 5s 才反馈。轮询 getDaemonListen 走 HTTP 不受此锁影响。
  setRestarting(true);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const fresh = await api.getDaemonListen();
        // 拿新 daemon 的 git_sha，跟旧 sha 对比给明确的「切换信号」
        let shaSuffix = "";
        try {
          const newSha = (await api.getStatus()).git_sha;
          if (newSha && prevSha && newSha !== prevSha) shaSuffix = ` · git ${prevSha} → ${newSha}`;
          else if (newSha) shaSuffix = ` · git ${newSha}`;
        } catch { /* 容错：拿不到 sha 不影响主流程 */ }
        toast.success(`daemon 已重启，当前监听 ${fresh.host}:${fresh.port}${shaSuffix}`);
        return fresh;
      } catch { /* 还在重启，继续等 */ }
    }
    toast.error("daemon 重启等待超时，刷新页面尝试…");
    setTimeout(() => location.reload(), 1000);
    return null;
  } finally {
    setRestarting(false);
  }
}
