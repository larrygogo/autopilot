import type { ProviderName } from "../core/config";

// ──────────────────────────────────────────────
// Provider 模型列表 —— API 优先 / catalog fallback
//
// 每家 provider 单独实现：
//   1. 有对应的 *_API_KEY 环境变量时：直接调官方 REST API 拉最新列表
//   2. 否则 fallback 到内置 catalog（跟随 autopilot 版本更新）
//
// 这里不依赖各家的 SDK npm 包（避免必装依赖）；通过原生 fetch 调 REST。
// ──────────────────────────────────────────────

export type ModelListSource = "api" | "catalog";

export interface ModelListResult {
  name: ProviderName;
  models: string[];
  source: ModelListSource;
  /** 拉取 API 失败时的错误信息（已 fallback 到 catalog，但告知用户原因） */
  error?: string;
}

// ──────────────────────────────────────────────
// 内置 catalog —— 随 autopilot 版本维护
// ──────────────────────────────────────────────

const CATALOG: Record<ProviderName, string[]> = {
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    // legacy（用户可能还想用）
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  openai: [
    "o4-mini",
    "o3",
    "o3-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ],
};

const API_TIMEOUT_MS = 5000;

// ──────────────────────────────────────────────
// 入口
// ──────────────────────────────────────────────

export async function listProviderModels(name: ProviderName): Promise<ModelListResult> {
  switch (name) {
    case "anthropic": return await listAnthropic();
    case "openai": return await listOpenAI();
    case "google": return await listGoogle();
    default:
      return { name, models: [], source: "catalog", error: `未知 provider：${name}` };
  }
}

function catalogResult(name: ProviderName, error?: string): ModelListResult {
  return { name, models: CATALOG[name] ?? [], source: "catalog", error };
}

// ──────────────────────────────────────────────
// Anthropic: GET https://api.anthropic.com/v1/models
// ──────────────────────────────────────────────

async function listAnthropic(): Promise<ModelListResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return catalogResult("anthropic");

  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json() as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => typeof m.id === "string" ? m.id : null)
      .filter((x): x is string => !!x)
      .sort();
    if (models.length === 0) return catalogResult("anthropic", "API 返回空列表");
    return { name: "anthropic", models, source: "api" };
  } catch (e: unknown) {
    return catalogResult("anthropic", e instanceof Error ? e.message : String(e));
  }
}

// ──────────────────────────────────────────────
// OpenAI: GET https://api.openai.com/v1/models
// ──────────────────────────────────────────────

async function listOpenAI(): Promise<ModelListResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return catalogResult("openai");

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { "Authorization": `Bearer ${key}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json() as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => typeof m.id === "string" ? m.id : null)
      .filter((x): x is string => !!x)
      // 排除 embedding / whisper / tts / vision-only 等非推理模型；
      // OpenAI 列表里什么都有，精简到聊天/推理类
      .filter((id) => /^(gpt-|o[0-9])/.test(id))
      .sort();
    if (models.length === 0) return catalogResult("openai", "API 返回空列表");
    return { name: "openai", models, source: "api" };
  } catch (e: unknown) {
    return catalogResult("openai", e instanceof Error ? e.message : String(e));
  }
}

// ──────────────────────────────────────────────
// Google Gemini: GET https://generativelanguage.googleapis.com/v1beta/models?key=...
// ──────────────────────────────────────────────

async function listGoogle(): Promise<ModelListResult> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) return catalogResult("google");

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const models = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => {
        // API 返回 "models/gemini-2.5-pro"，脱去前缀
        const id = m.name ?? "";
        return id.startsWith("models/") ? id.slice("models/".length) : id;
      })
      .filter((id): id is string => !!id)
      .sort();
    if (models.length === 0) return catalogResult("google", "API 返回空列表");
    return { name: "google", models, source: "api" };
  } catch (e: unknown) {
    return catalogResult("google", e instanceof Error ? e.message : String(e));
  }
}

// ──────────────────────────────────────────────
// 导出便捷方法用于外部扩展 catalog
// ──────────────────────────────────────────────

export function getCatalog(name: ProviderName): string[] {
  return [...(CATALOG[name] ?? [])];
}
