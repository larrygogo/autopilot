/**
 * Provider 条目化重构（spec: 2026-06-13-provider-entries-redesign）— P1 数据层。
 *
 * 把 provider 从「写死三家 + 双模式」改成「用户自管单类型实例列表」。本迁移：
 *   1. 建 providers 表
 *   2. 种子：官方三家 → cli 条目（name 保 anthropic/openai/google 不变，老 workflow 零改）；
 *      config 里写了 mode:api 的尊重用户选择种成 api 条目
 *   3. 导入 config.yaml 现有自定义/compat provider → api/openai-compat 条目
 *   4. api_keys 有但无条目覆盖的 name → 占位条目（避免有 key 没条目的孤儿）
 *
 * 内联冻结 BUILTIN_COMPAT_PROVIDERS 数据（迁移是历史快照，冻结数据是正常形态，
 * 不反向 import agents/）。只新增表 + 插数据、不改既有 config.yaml/api_keys，可回退（DROP TABLE）。
 */
import type { Database } from "bun:sqlite";
import { loadProviders, type ProviderConfig } from "../core/config";

// 冻结快照：内置 compat 预置（与 agents/providers/api/compat.ts 对齐，迁移内联避免反向依赖）
const COMPAT_PRESETS: Record<string, { base_url: string; default_model: string; display_name: string }> = {
  deepseek: { base_url: "https://api.deepseek.com", default_model: "deepseek-chat", display_name: "DeepSeek" },
  kimi: { base_url: "https://api.moonshot.cn", default_model: "moonshot-v1-8k", display_name: "Kimi (Moonshot)" },
  minimax: { base_url: "https://api.minimax.chat", default_model: "abab6.5s-chat", display_name: "MiniMax" },
};

// 官方三家 → CLI 子类映射（name 保持原名）
const OFFICIAL: Record<string, { subtype: string; display_name: string; login: string }> = {
  anthropic: { subtype: "claude", display_name: "Anthropic (Claude)", login: "claude login" },
  openai: { subtype: "codex", display_name: "OpenAI (Codex)", login: "codex login" },
  google: { subtype: "gemini", display_name: "Google (Gemini)", login: "gemini auth login" },
};

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL UNIQUE,
      display_name   TEXT NOT NULL,
      type           TEXT NOT NULL,              -- 'cli' | 'api'
      subtype        TEXT NOT NULL,              -- cli: claude/codex/gemini/custom；api: anthropic/openai/google/openai-compat
      cli_bin        TEXT,
      cli_login_cmd  TEXT,
      cli_status     TEXT,                       -- 'ok' | 'missing' | 'unknown'
      cli_version    TEXT,
      cli_checked_at TEXT,
      base_url       TEXT,
      env_key_name   TEXT,
      default_model  TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      state          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'deleted'（软删 P2 用）
      origin         TEXT NOT NULL DEFAULT 'user',    -- 'seed' | 'template' | 'user'
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 幂等：已种子过则跳过（重跑迁移 / init 已跑全量时 no-op）
  const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM providers").get();
  if (count && count.n > 0) return;

  let seq = 0;
  const nextId = () => `prov-${String(++seq).padStart(3, "0")}`;
  const insert = db.prepare(
    `INSERT INTO providers
       (id, name, display_name, type, subtype, cli_login_cmd, base_url, env_key_name, default_model, enabled, state, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const providers = loadProviders(); // 官方三家（可能 {}）+ config 自定义
  const seen = new Set<string>();

  // 1. 官方三家种子
  for (const name of ["anthropic", "openai", "google"]) {
    const cfg: ProviderConfig = providers[name] ?? {};
    const off = OFFICIAL[name];
    if (cfg.mode === "api") {
      insert.run(nextId(), name, off.display_name, "api", name, null,
        cfg.base_url ?? null, cfg.env_key_name ?? null, cfg.default_model ?? null, 1, "active", "seed");
    } else {
      insert.run(nextId(), name, off.display_name, "cli", off.subtype, off.login,
        null, null, cfg.default_model ?? null, 1, "active", "seed");
    }
    seen.add(name);
  }

  // 2. config 里的自定义 / compat provider
  for (const [name, cfg] of Object.entries(providers)) {
    if (seen.has(name)) continue;
    const preset = COMPAT_PRESETS[name];
    insert.run(nextId(), name, preset?.display_name ?? name, "api", "openai-compat", null,
      (cfg as ProviderConfig).base_url ?? preset?.base_url ?? null,
      (cfg as ProviderConfig).env_key_name ?? null,
      (cfg as ProviderConfig).default_model ?? preset?.default_model ?? null,
      1, "active", preset ? "template" : "user");
    seen.add(name);
  }

  // 3. api_keys 有但无条目覆盖的 name → 占位条目
  const keyRows = db.query<{ provider: string }, []>("SELECT provider FROM api_keys").all();
  for (const { provider } of keyRows) {
    if (seen.has(provider)) continue;
    const preset = COMPAT_PRESETS[provider];
    insert.run(nextId(), provider, preset?.display_name ?? provider, "api", "openai-compat", null,
      preset?.base_url ?? null, null, preset?.default_model ?? null, 1, "active", preset ? "template" : "user");
    seen.add(provider);
  }
}
