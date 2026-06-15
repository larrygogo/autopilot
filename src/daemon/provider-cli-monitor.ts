/**
 * Provider CLI 主动探测监控器。
 *
 * daemon 启动后跑一次 L2 探测（claude/codex/gemini --version），结果写入
 * provider-health.ts 的内存 Map。每 5 分钟重跑。状态变化时 recordProviderCliStatus
 * 会 emit `provider:health-changed`；订阅 `provider:*` 频道的客户端可立即收到。
 *
 * 新订阅者通过 registerSnapshotProvider 拿到当前 snapshot。
 */

import { recordProviderCliStatus, listAllProviderHealth } from "../core/provider-health";
import { listProviders as listProviderEntries, setProviderCliStatus } from "../core/providers";
import { probeCli } from "../agents/cli-status";
import { createLogger } from "../core/logger";
import { registerSnapshotProvider } from "./ws";
import type { AutopilotEvent } from "../core/events";

const log = createLogger("provider-cli-monitor");

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 遍历 DB 里的 cli 类型 provider 条目，逐个探测本地可用性：
 *   1. 落库到条目的 cli_status（重启可见）
 *   2. 同步内存健康态（给 banner / provider:health snapshot）
 */
async function probeAll(): Promise<void> {
  let cliEntries: ReturnType<typeof listProviderEntries>;
  try {
    cliEntries = listProviderEntries().filter((p) => p.type === "cli");
  } catch (e: unknown) {
    log.warn("读取 provider 条目失败（providers 表未就绪？）：%s", e instanceof Error ? e.message : String(e));
    return;
  }
  await Promise.all(
    cliEntries.map(async (p) => {
      const probe = await probeCli(p.subtype, p.cli_bin ?? undefined);
      setProviderCliStatus(p.id, probe.status, probe.version ?? null);
      if (probe.status === "ok") {
        recordProviderCliStatus(p.name, { cli_status: "ok", cli_version: probe.version });
        log.debug("CLI 探测成功 [%s]: %s %s", p.name, p.subtype, probe.version ?? "(no version)");
      } else {
        recordProviderCliStatus(p.name, { cli_status: "missing", cli_install_hint: probe.install_hint });
        log.debug("CLI 探测失败 [%s]: %s", p.name, probe.error ?? probe.status);
      }
    }),
  );
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _snapshotProviderRegistered = false;

/** daemon 启动时调起：注册 snapshot 提供器、跑首次探测、注册定时刷新。 */
export function initProviderCliMonitor(): void {
  if (!_snapshotProviderRegistered) {
    registerSnapshotProvider((channel): AutopilotEvent | null => {
      if (channel === "provider:*" || channel === "provider:health") {
        return {
          type: "provider:health-snapshot",
          payload: { states: listAllProviderHealth(), ts: Date.now() },
        };
      }
      return null;
    });
    _snapshotProviderRegistered = true;
  }
  // 首次探测异步跑，不阻塞 daemon 启动
  probeAll().catch((e: unknown) => {
    log.warn("首次 CLI 探测失败：%s", e instanceof Error ? e.message : String(e));
  });
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    probeAll().catch(() => {
      // 定时探测失败不需要 escalate
    });
  }, REFRESH_INTERVAL_MS);
}

/** daemon 退出时清理定时器。 */
export function disposeProviderCliMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** 测试专用：手动触发一次探测并等待完成。 */
export async function _probeAllForTest(): Promise<void> {
  await probeAll();
}
