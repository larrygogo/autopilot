import type { NotifyDriver, NotifyDriverConfig, NotifyDriverFactory } from "./types";
import { log } from "../logger";
import { createWindowsToastDriver } from "./windows-toast";
import { createMacosOsascriptDriver } from "./macos-osascript";
import { createLinuxNotifySendDriver } from "./linux-notify-send";
import { createSlackWebhookDriver } from "./slack-webhook";

export type { NotifyDriver, NotifyDriverConfig, NotifyPayload, NotifyEvent } from "./types";

/**
 * driver type → factory。新增 driver 在此注册即可被 config.yaml notify.drivers[].type 引用。
 */
const FACTORIES: Record<string, NotifyDriverFactory> = {
  "windows-toast": createWindowsToastDriver,
  "macos-osascript": createMacosOsascriptDriver,
  "linux-notify-send": createLinuxNotifySendDriver,
  "slack-webhook": createSlackWebhookDriver,
};

/**
 * 按 config 列表实例化 enabled 的 driver。
 * type 未注册 → warn 跳过；enabled()=false 也跳过（平台不匹配 / 依赖缺失）。
 */
export async function getEnabledDrivers(configs: NotifyDriverConfig[]): Promise<NotifyDriver[]> {
  const out: NotifyDriver[] = [];
  for (const cfg of configs) {
    const factory = FACTORIES[cfg.type];
    if (!factory) {
      log.warn("未知 notify driver 类型：%s（已忽略；可选：%s）", cfg.type, Object.keys(FACTORIES).join(", "));
      continue;
    }
    const driver = factory(cfg);
    const ok = await Promise.resolve(driver.enabled());
    if (ok) out.push(driver);
  }
  return out;
}
