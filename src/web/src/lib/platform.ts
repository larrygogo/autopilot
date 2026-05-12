// ──────────────────────────────────────────────
// 平台检测：用于快捷键显示等差异化 UI
// ──────────────────────────────────────────────

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // 新 API：userAgentData.platform（Chromium 90+，更可靠）
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  // 回退：platform（已废弃但 Safari/Firefox 仍可用）+ userAgent
  const platform = navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** 当前系统是否为 macOS（含 iOS，因为它们用 ⌘） */
export const IS_MAC = detectMac();

/** 修饰键的显示文本：mac 上 `⌘`，其他平台 `Ctrl` */
export const MOD_KEY: string = IS_MAC ? "⌘" : "Ctrl";

/** 快捷键组合的连接符：mac 上无空格紧贴，其他平台用 `+` */
export function modShortcut(key: string): string {
  return IS_MAC ? `${MOD_KEY}${key}` : `${MOD_KEY}+${key}`;
}
