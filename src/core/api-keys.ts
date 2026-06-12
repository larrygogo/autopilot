/**
 * API Key 管理模块 — 加密存储 + 脱敏展示 + 环境变量回落。
 *
 * 密钥文件：~/.autopilot/secret.key（32 字节随机数，chmod 600）
 * 加密算法：AES-256-GCM（IV 12 字节 + ciphertext + tag 16 字节）
 * DB 存储：base64(IV + ciphertext + tag)
 *
 * 所有公开接口只返回脱敏信息，rawKey 仅在内部 resolveApiKey() 使用。
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { getDb } from "./db";
import { log } from "./logger";

// ── 环境变量映射 ──

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  kimi: "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

/** 解析某个 provider 对应的环境变量名 */
export function envKeyNameForProvider(provider: string, customEnvKeyName?: string): string {
  return customEnvKeyName || ENV_KEY_MAP[provider] || `${provider.toUpperCase()}_API_KEY`;
}

// ── 密钥文件管理 ──

function getSecretKeyPath(): string {
  return join(AUTOPILOT_HOME, "secret.key");
}

/**
 * 确保 secret.key 存在（幂等）。init 时调用。
 * 返回用于 AES-256-GCM 的 CryptoKey。
 */
export async function ensureSecretKey(): Promise<CryptoKey> {
  const keyPath = getSecretKeyPath();
  let rawKey: Uint8Array;

  if (existsSync(keyPath)) {
    rawKey = new Uint8Array(readFileSync(keyPath));
    if (rawKey.length !== 32) {
      throw new KeyDecryptionError(
        `secret.key 长度异常（期望 32 字节，实际 ${rawKey.length} 字节）。` +
        "请删除 ~/.autopilot/secret.key 后重新运行 `autopilot init`，已存储的 API key 需重新录入。"
      );
    }
  } else {
    rawKey = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(keyPath, rawKey, { mode: 0o600 });
    // Windows 下 mode 参数可能无效，尝试显式 chmod
    try { chmodSync(keyPath, 0o600); } catch { /* Windows 忽略 */ }
    log.info("已生成 API 密钥加密文件：%s", keyPath);
  }

  return crypto.subtle.importKey("raw", rawKey.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// ── 加密/解密 ──

async function encryptKey(rawKey: string, cryptoKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(rawKey);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data as unknown as BufferSource);
  // 拼接 IV + ciphertext（含 tag）
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString("base64");
}

async function decryptKey(encoded: string, cryptoKey: CryptoKey): Promise<string> {
  const combined = new Uint8Array(Buffer.from(encoded, "base64"));
  if (combined.length < 13) {
    throw new KeyDecryptionError("加密数据格式异常（过短）");
  }
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new KeyDecryptionError(
      "API key 解密失败。可能原因：secret.key 文件被替换或损坏。\n" +
      "解决方案：重新运行 `autopilot key set <provider>` 录入密钥，或设置对应环境变量作为回落。"
    );
  }
}

// ── 脱敏 ──

/** 保留 key 最后 4 位，前缀保留到第一个 '-'，中间替换为 '***' */
export function maskApiKey(rawKey: string): string {
  if (rawKey.length <= 8) return "***" + rawKey.slice(-2);
  const last4 = rawKey.slice(-4);
  const dashIdx = rawKey.indexOf("-");
  const prefix = dashIdx > 0 && dashIdx < 8 ? rawKey.slice(0, dashIdx + 1) : rawKey.slice(0, 3);
  return `${prefix}***${last4}`;
}

// ── ID 生成 ──

let _keyIdCounter = 0;

function nextKeyId(): string {
  const db = getDb();
  const row = db.query("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS m FROM api_keys").get() as
    | { m: number | null }
    | null;
  const next = (row?.m ?? _keyIdCounter) + 1;
  _keyIdCounter = next;
  return `key-${String(next).padStart(3, "0")}`;
}

// ── 错误类型 ──

export class KeyDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyDecryptionError";
  }
}

// ── CRUD 接口 ──

export interface ApiKeyInfo {
  provider: string;
  key_hint: string;
  updated_at: string;
  source: "db" | "env";
}

/**
 * 写入/更新 API key（加密存储）。
 */
export async function setApiKey(provider: string, rawKey: string): Promise<void> {
  if (!rawKey || !rawKey.trim()) {
    throw new Error("API key 不能为空");
  }
  const cryptoKey = await ensureSecretKey();
  const keyEnc = await encryptKey(rawKey.trim(), cryptoKey);
  const keyHint = maskApiKey(rawKey.trim());
  const db = getDb();

  const existing = db
    .query("SELECT id FROM api_keys WHERE provider = ?")
    .get(provider) as { id: string } | null;

  if (existing) {
    db.run(
      "UPDATE api_keys SET key_enc = ?, key_hint = ?, updated_at = datetime('now') WHERE provider = ?",
      [keyEnc, keyHint, provider],
    );
  } else {
    const id = nextKeyId();
    db.run(
      "INSERT INTO api_keys (id, provider, key_enc, key_hint) VALUES (?, ?, ?, ?)",
      [id, provider, keyEnc, keyHint],
    );
  }
  log.info("API key 已更新：%s（%s）", provider, keyHint);
}

/**
 * 删除某个 provider 的 API key。
 */
export function deleteApiKey(provider: string): void {
  const db = getDb();
  const result = db.run("DELETE FROM api_keys WHERE provider = ?", [provider]);
  if (result.changes === 0) {
    throw new Error(`未找到 provider "${provider}" 的 API key`);
  }
  log.info("API key 已删除：%s", provider);
}

/**
 * 列出所有已配置的 API key（脱敏）。同时检测环境变量来源。
 */
export function listApiKeys(): ApiKeyInfo[] {
  const db = getDb();
  const rows = db.query("SELECT provider, key_hint, updated_at FROM api_keys ORDER BY provider").all() as Array<{
    provider: string;
    key_hint: string;
    updated_at: string;
  }>;

  const result: ApiKeyInfo[] = rows.map((r) => ({
    provider: r.provider,
    key_hint: r.key_hint,
    updated_at: r.updated_at,
    source: "db" as const,
  }));

  // 补充仅环境变量配置的 provider（DB 中没有的）
  const dbProviders = new Set(rows.map((r) => r.provider));
  for (const [provider, envName] of Object.entries(ENV_KEY_MAP)) {
    if (!dbProviders.has(provider) && process.env[envName]) {
      result.push({
        provider,
        key_hint: maskApiKey(process.env[envName]!),
        updated_at: "",
        source: "env",
      });
    }
  }

  return result;
}

/**
 * 解析 API key：优先 DB 解密，回落环境变量。
 * 仅 ApiAgentLoop 内部调用，不暴露原文到 RPC/CLI。
 */
export async function resolveApiKey(provider: string, customEnvKeyName?: string): Promise<string | null> {
  // 优先从 DB 解密
  const db = getDb();
  const row = db.query("SELECT key_enc FROM api_keys WHERE provider = ?").get(provider) as
    | { key_enc: string }
    | null;

  if (row) {
    try {
      const cryptoKey = await ensureSecretKey();
      return await decryptKey(row.key_enc, cryptoKey);
    } catch (e: unknown) {
      if (e instanceof KeyDecryptionError) {
        log.warn("API key 解密失败（%s），尝试环境变量回落：%s", provider, e.message);
      } else {
        throw e;
      }
    }
  }

  // 环境变量回落
  const envName = envKeyNameForProvider(provider, customEnvKeyName);
  const envValue = process.env[envName];
  if (envValue) return envValue;

  return null;
}
