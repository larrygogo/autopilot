/**
 * Provider CLI 主动探测监控器。
 *
 * daemon 启动后跑一次 L2 探测（claude/codex/gemini --version），结果写入
 * provider-health.ts 的内存 Map。每 5 分钟重跑。状态变化时 recordProviderCliStatus
 * 会 emit `provider:health-changed`；订阅 `provider:*` 频道的客户端可立即收到。
 *
 * 新订阅者通过 registerSnapshotProvider 拿到当前 snapshot。
 */

import { PROVIDER_NAMES_LIST, PROVIDER_DEFAULTS, type ProviderDefaultsName } from "../core/provider-defaults";
import { recordProviderCliStatus, listAllProviderHealth } from "../core/provider-health";
import { createLogger } from "../core/logger";
import { registerSnapshotProvider } from "./ws";
import type { AutopilotEvent } from "../core/events";

const log = createLogger("provider-cli-monitor");

const PROBE_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface ProbeResult {
  ok: boolean;
  version?: string;
  reason?: string;
}

async function probeCli(cli: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const proc = Bun.spawn([cli, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
    });
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const text = (stdout || stderr).trim();
      const version = text.split(/\s+/).find((s) => /\d+\.\d+/.test(s));
      return { ok: true, version };
    }
    return { ok: false, reason: `${cli} 退出码 ${exitCode}` };
  } catch (e: unknown) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      reason: aborted ? `探测超时（${PROBE_TIMEOUT_MS}ms）` : e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeAll(): Promise<void> {
  await Promise.all(
    PROVIDER_NAMES_LIST.map(async (name) => {
      const def = PROVIDER_DEFAULTS[name as ProviderDefaultsName];
      const result = await probeCli(def.cli);
      if (result.ok) {
        recordProviderCliStatus(name, {
          cli_status: "ok",
          cli_version: result.version,
        });
        log.debug("CLI 探测成功 [%s]: %s %s", name, def.cli, result.version ?? "(no version)");
      } else {
        recordProviderCliStatus(name, {
          cli_status: "missing",
          cli_install_hint: def.install_hint,
        });
        log.debug("CLI 探测失败 [%s]: %s", name, result.reason);
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
