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
import { loadDefaultProviderName, setDefaultProviderName } from "./config";
import { listProviders, getProviderByName, type ProviderEntry } from "./providers";
import { resolveApiKey } from "./api-keys";

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
    // 3. 首选「已就绪的 claude（anthropic）CLI」——claude 是 autopilot agentic 工作流的最强默认
    //    （DEFAULT_AGENT / dev 各 phase 都按 claude 调）。这是框架级偏好（同 FALLBACK_PROVIDER 性质），
    //    仍是动态的：无可用 claude 才退到其它 provider，用户也可用显式 providers.default 覆盖。
    const readyClaude = entries.find((p) => p.type === "cli" && p.cli_status === "ok" && p.subtype === "claude");
    if (readyClaude) return readyClaude.name;
    // 4. 否则首个就绪 cli（cli_status==='ok'，同步可得、最可能真可用）
    const ready = entries.find((p) => p.type === "cli" && p.cli_status === "ok");
    if (ready) return ready.name;
    // 5. 首个 enabled（健康态未知也尊重用户已配的，不退回 literal）
    return entries[0].name;
  } catch {
    // DB 未就绪 / 任何异常 → 占位兜底（热路径同步调用，绝不抛）
    return FALLBACK_PROVIDER;
  }
}

// ──────────────────────────────────────────────
// 可用性判定（P1：onboarding gate / 关键操作守卫 / 自动设默认 共用）
//   「有条目」≠「能用」：cli 要 cli_status=ok（已登录），api 要有 key。
//   异步（resolveApiKey），与 resolveDefaultProvider 的同步派生分开用。
// ──────────────────────────────────────────────

/** 某 provider 条目是否真正可用（enabled + cli 已就绪 / api 有 key）。 */
export async function isProviderUsable(entry: ProviderEntry): Promise<boolean> {
  if (entry.enabled !== 1) return false;
  if (entry.type === "cli") return entry.cli_status === "ok";
  // api：需要 key（DB 加密存储 / 环境变量回落）
  try {
    const key = await resolveApiKey(entry.name, entry.env_key_name ?? undefined);
    return !!key;
  } catch {
    return false;
  }
}

/** 列出当前真正可用的 provider 条目（按 created_at ASC）。 */
export async function listUsableProviders(): Promise<ProviderEntry[]> {
  let entries: ProviderEntry[];
  try {
    entries = listProviders();
  } catch {
    return []; // DB 未就绪
  }
  const out: ProviderEntry[] = [];
  for (const e of entries) {
    if (await isProviderUsable(e)) out.push(e);
  }
  return out;
}

/** 是否存在至少一个可用 provider。 */
export async function hasUsableProvider(): Promise<boolean> {
  return (await listUsableProviders()).length > 0;
}

/**
 * 「第一个配好的 provider 自动设为默认」——onboarding 兜底。
 * 仅在 `providers.default` **未显式设置**时生效（不覆盖用户的显式选择；显式默认指向不可用时
 * 由 resolveDefaultProvider 派生兜底，待用户重新登录即恢复，不在这里强改）。
 * 返回最终默认名，或 null（无可用 provider）。
 */
export async function ensureDefaultProviderSet(): Promise<string | null> {
  const explicit = loadDefaultProviderName();
  if (explicit) return explicit; // 已显式设 → 尊重，不动
  const usable = await listUsableProviders();
  if (usable.length === 0) return null;
  // ⚠ 只在「恰好一个可用」时自动 pin（真·首个 provider 场景）。多个可用 + 无显式默认 →
  // 不自动 pin：交给 resolveDefaultProvider 派生（首个就绪 cli，通常 anthropic），用户想固定/换
  // 别的在 Web 显式选。否则会把「碰巧排第一的可用 provider」强写进 config、悄悄改掉用户的有效默认。
  if (usable.length === 1) {
    setDefaultProviderName(usable[0].name);
    return usable[0].name;
  }
  return null;
}
