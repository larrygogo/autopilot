/**
 * 桌面通知应用层开关 — 存 localStorage，仅当前浏览器有效。
 * 浏览器权限已是 granted 时，无记录视为开启（维持老用户现状）。
 *
 * 注意：严格隐私模式或企业安全策略下 localStorage 可能抛 SecurityError，
 * 所有读写均 try/catch 保护，异常时降级为默认开。
 */
const STORAGE_KEY = "autopilot.desktopNotify.enabled";

export function getDesktopNotifyEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "true";
  } catch {
    return true; // 存储不可用时降级为默认开
  }
}

export function setDesktopNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // 存储不可用时静默忽略
  }
}

/**
 * 确保有偏好记录：无记录时写入 true 并返回 true，有记录时直接返回其值。
 * 用于 `default → granted` 流程，单次 localStorage 读取即完成「尊重已有偏好 + 回填默认值」。
 */
export function ensureDesktopNotifyDefault(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) {
      localStorage.setItem(STORAGE_KEY, "true");
      return true;
    }
    return v === "true";
  } catch {
    return true; // 存储不可用时降级为默认开
  }
}
