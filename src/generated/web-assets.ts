// src/generated/web-assets.ts —— 入库稳定入口
// 勿与 _web-assets.generated.ts（gitignore 生成物）混淆。
// daemon 启动时调 initWebAssets() 一次；dev 未跑 gen:web-assets 时退化为空表（serveStatic 回退磁盘）。
let assets: Record<string, string> = {};

/** daemon 启动调一次。try 动态 import 生成的嵌入清单；dev 未构建则空表。 */
export async function initWebAssets(): Promise<void> {
  try {
    const gen = (await import("./_web-assets.generated")) as {
      WEB_ASSETS: Record<string, string>;
    };
    assets = gen.WEB_ASSETS;
  } catch {
    // dev 未跑 gen:web-assets：空表，serveStatic 回退磁盘
    assets = {};
  }
}

/** 按 URL 路径取嵌入资源的 bun file handle；不存在返回 undefined。 */
export function getWebAsset(urlKey: string): string | undefined {
  return assets[urlKey];
}

/** 嵌入表是否非空（false = dev 模式 / 未生成，serveStatic 应回退磁盘）。 */
export function hasWebAssets(): boolean {
  return Object.keys(assets).length > 0;
}
