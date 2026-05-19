/**
 * JWT + 用户管理模块
 *
 * - JWT 使用 HS256 签名，密钥自动生成并持久化到 AUTOPILOT_HOME/runtime/jwt-secret
 * - 密码使用 Bun.password（bcrypt）哈希
 * - 若 users 表为空，auth 视为"未启用"，兼容旧 API token 模式
 */

import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { getDb } from "./db";

// ── 常量 ─────────────────────────────────────────────────────────────────

const JWT_SECRET_PATH = join(AUTOPILOT_HOME, "runtime", "jwt-secret");
export const COOKIE_NAME = "autopilot_session";
const JWT_EXPIRY_SECS = 7 * 24 * 60 * 60; // 7 天

// ── JWT 密钥 ──────────────────────────────────────────────────────────────

let _secret: string | null = null;

function getJwtSecret(): string {
  if (_secret) return _secret;
  if (existsSync(JWT_SECRET_PATH)) {
    _secret = readFileSync(JWT_SECRET_PATH, "utf8").trim();
    return _secret;
  }
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  writeFileSync(JWT_SECRET_PATH, hex, { mode: 0o600 });
  _secret = hex;
  return _secret;
}

// ── Base64URL ──────────────────────────────────────────────────────────────

function b64uEncodeStr(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uEncodeBuf(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(str: string): string {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

// ── HMAC 密钥 ─────────────────────────────────────────────────────────────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// ── JWT ───────────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: number;   // user id
  email: string;
  iat: number;
  exp: number;
}

export async function signJwt(userId: number, email: string): Promise<string> {
  const key = await importHmacKey(getJwtSecret());
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub: userId, email, iat: now, exp: now + JWT_EXPIRY_SECS };
  const header = b64uEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64uEncodeStr(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64uEncodeBuf(sig)}`;
}

export async function verifyJwt(token: string): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT 格式无效");
  const [header, body, sig] = parts;
  const key = await importHmacKey(getJwtSecret());
  const sigBytes = Uint8Array.from(b64uDecode(sig), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(`${header}.${body}`),
  );
  if (!valid) throw new Error("JWT 签名无效");
  const payload = JSON.parse(b64uDecode(body)) as JwtPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("JWT 已过期");
  return payload;
}

// ── Cookie 工具 ───────────────────────────────────────────────────────────

/** 生成 Set-Cookie 头的值。clear=true 时使 cookie 立即过期（logout 用）。 */
export function makeSessionCookie(token: string, clear = false): string {
  if (clear) {
    return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${JWT_EXPIRY_SECS}`;
}

/** 从请求 Cookie 头提取 JWT。未找到返回 null。 */
export function extractJwtFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === COOKIE_NAME && val) return val;
  }
  return null;
}

// ── 用户 CRUD ─────────────────────────────────────────────────────────────

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: number;
  email: string;
  created_at: string;
}

/** users 表中是否存在至少一条记录（用于判断 auth 是否启用）。 */
export function hasAnyUser(): boolean {
  const db = getDb();
  const row = db.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM users").get();
  return (row?.cnt ?? 0) > 0;
}

/** 创建新用户（密码 bcrypt 哈希后写入）。邮箱已存在时抛出。 */
export async function createUser(email: string, password: string): Promise<User> {
  const db = getDb();
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt" });
  const normalized = email.toLowerCase().trim();
  db.run("INSERT INTO users (email, password_hash) VALUES (?, ?)", [normalized, hash]);
  const row = db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(normalized);
  if (!row) throw new Error("创建用户失败");
  return { id: row.id, email: row.email, created_at: row.created_at };
}

/** 验证邮箱+密码。匹配返回 User，不匹配返回 null。 */
export async function verifyUser(email: string, password: string): Promise<User | null> {
  const db = getDb();
  const row = db
    .query<UserRow, [string]>("SELECT * FROM users WHERE email = ?")
    .get(email.toLowerCase().trim());
  if (!row) return null;
  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) return null;
  return { id: row.id, email: row.email, created_at: row.created_at };
}

/** 按 ID 查找用户。 */
export function getUserById(id: number): User | null {
  const db = getDb();
  const row = db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return null;
  return { id: row.id, email: row.email, created_at: row.created_at };
}

/** 列出所有用户（不含密码哈希）。 */
export function listUsers(): User[] {
  const db = getDb();
  const rows = db
    .query<UserRow, []>("SELECT * FROM users ORDER BY created_at ASC")
    .all();
  return rows.map((r) => ({ id: r.id, email: r.email, created_at: r.created_at }));
}

/** 修改用户密码。 */
export async function changePassword(userId: number, newPassword: string): Promise<void> {
  const db = getDb();
  const hash = await Bun.password.hash(newPassword, { algorithm: "bcrypt" });
  db.run(
    "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
    [hash, userId],
  );
}
