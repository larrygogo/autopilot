/**
 * 默认 provider 解析 —— 系统「未指定 provider 时用哪个」的单一真相源。
 *
 * 取代散落各处的 `?? "anthropic"` 硬编码：默认不再写死，而是按用户**实际配置**解析。
 * fallback 链（短路）：
 *   1. 显式默认（config.yaml providers.default 指向的已存在且 enabled 条目）
 *   2. 唯一已配（恰好一条 enabled 条目）
 *   3. 首个「CLI 已就绪」（cli_status==='ok'，最可能真可用）
 *   4. 首个 enabled 条目
 *   5. 终极兜底常量 FALLBACK_PROVIDER
 *
 * 真实可用性（CLI 登录 / API key）由 onboarding 保证（P1）；本函数只保证「返回一个非空 provider 名」，
 * 被 agentForPhase 等同步热路径调用，故全程同步 + try-catch 兜底（DB 未就绪也不抛）。
 */
import { loadDefaultProviderName } from "./config";
import { listProviders, getProviderByName } from "./providers";

/**
 * 终极兜底 provider 名：一条 enabled 条目都没有 / DB 未就绪时的占位。
 * 这是框架级「provider 解析非空保证」，**不是**工作流业务常量（不违反 core 零业务知识）——
 * 它只是给「provider 全无」这种异常态一个能让错误信息成形的占位名。所有原来散落的
 * `?? "anthropic"` 都收敛到这一个常量。
 */
export const FALLBACK_PROVIDER = "anthropic";

/** 解析系统默认 provider 名。必返回非空字符串。 */
export function resolveDefaultProvider(): string {
  try {
    // 1. 显式默认（陈旧/typo/disabled 指针 → 跳过，降级到派生，不卡死）
    const explicit = loadDefaultProviderName();
    if (explicit) {
      const e = getProviderByName(explicit);
      if (e && e.enabled === 1) return e.name;
    }
    const entries = listProviders().filter((p) => p.enabled === 1);
    if (entries.length === 0) return FALLBACK_PROVIDER;
    // 2. 唯一已配
    if (entries.length === 1) return entries[0].name;
    // 3. 首个 CLI 已就绪（cli_status==='ok'，同步可得、最可能真可用）
    const ready = entries.find((p) => p.type === "cli" && p.cli_status === "ok");
    if (ready) return ready.name;
    // 4. 首个 enabled（健康态未知也尊重用户已配的，不退回 literal）
    return entries[0].name;
  } catch {
    // DB 未就绪 / 任何异常 → 占位兜底（热路径同步调用，绝不抛）
    return FALLBACK_PROVIDER;
  }
}
