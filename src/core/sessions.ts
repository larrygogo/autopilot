import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { atomicWriteSync } from "./atomic-write";
import { log } from "./logger";

// ──────────────────────────────────────────────
// 对话 Session 管理
//
// 布局（沿用 gsd-style 的文件权威源）：
//   AUTOPILOT_HOME/runtime/sessions/<sid>/
//     ├── manifest.json      ← session 元数据
//     └── messages.jsonl     ← append-only 消息历史（每行一条 ChatMessage）
//
// Provider（比如 Anthropic SDK）可能有自己的 session 机制，
// manifest.provider_session_id 记录它；autopilot 侧独立管理一份"人话"历史
// 用于 UI 展示、跨 provider 复用。
// ──────────────────────────────────────────────

const SESSION_ID_RE = /^[\w.\-]+$/;

function getAutopilotHome(): string {
  return process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
}

function getSessionsRoot(): string {
  return join(getAutopilotHome(), "runtime", "sessions");
}

function getSessionDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`非法 session ID：${sessionId}`);
  }
  return join(getSessionsRoot(), sessionId);
}

export interface SessionManifest {
  version: 1;
  id: string;
  /** 人类可读标题（可选） */
  title?: string;
  /** 本 session 使用的 autopilot agent 配置名 */
  agent: string;
  /** 聚焦的工作流（可选，决定了 chat_agent 选取） */
  workflow?: string;
  /** provider 原生 session id（Anthropic SDK 的 session_id 等），用于继续对话 */
  provider_session_id?: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  /** 可选：本条消息的成本信息（assistant 回复） */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_cost_usd?: number;
  };
}

export const SESSION_MANIFEST_VERSION = 1;

export interface CreateSessionOpts {
  agent: string;
  workflow?: string;
  title?: string;
  /** 显式指定 session id（默认自动生成） */
  id?: string;
}

export function createSession(opts: CreateSessionOpts): SessionManifest {
  const id = opts.id ?? randomUUID();
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`非法 session ID：${id}`);
  }
  const now = new Date().toISOString();
  const manifest: SessionManifest = {
    version: SESSION_MANIFEST_VERSION,
    id,
    agent: opts.agent,
    created_at: now,
    updated_at: now,
    message_count: 0,
  };
  if (opts.title) manifest.title = opts.title;
  if (opts.workflow) manifest.workflow = opts.workflow;

  const dir = getSessionDir(id);
  mkdirSync(dir, { recursive: true });
  writeManifest(manifest);
  return manifest;
}

function manifestPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "manifest.json");
}

function messagesPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "messages.jsonl");
}

export function writeManifest(manifest: SessionManifest): void {
  atomicWriteSync(manifestPath(manifest.id), JSON.stringify(manifest, null, 2) + "\n");
}

export function readManifest(sessionId: string): SessionManifest | null {
  const p = manifestPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as SessionManifest;
    if (parsed.version !== SESSION_MANIFEST_VERSION) {
      log.warn("session manifest 版本不匹配 [session=%s version=%s]", sessionId, parsed.version);
      return null;
    }
    return parsed;
  } catch (e: unknown) {
    log.warn("读取 session manifest 失败 [session=%s]：%s",
      sessionId, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export function updateManifest(
  sessionId: string,
  patch: Partial<Omit<SessionManifest, "id" | "version" | "created_at">>,
): boolean {
  const m = readManifest(sessionId);
  if (!m) return false;
  const updated: SessionManifest = {
    ...m,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeManifest(updated);
  return true;
}

export function listSessions(): SessionManifest[] {
  const root = getSessionsRoot();
  if (!existsSync(root)) return [];
  const out: SessionManifest[] = [];
  for (const sid of readdirSync(root)) {
    const m = readManifest(sid);
    if (m) out.push(m);
  }
  // 最新的在前
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function deleteSession(sessionId: string): boolean {
  const dir = getSessionDir(sessionId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 追加一条消息到 jsonl 文件，并更新 manifest.message_count / updated_at。
 */
export function appendMessage(sessionId: string, message: ChatMessage): void {
  const m = readManifest(sessionId);
  if (!m) throw new Error(`session 不存在：${sessionId}`);

  appendFileSync(messagesPath(sessionId), JSON.stringify(message) + "\n", "utf-8");
  updateManifest(sessionId, { message_count: m.message_count + 1 });
}

/**
 * 读取消息历史。limit 未提供则读全部，按时间顺序返回（旧 → 新）。
 */
export function readMessages(sessionId: string, limit?: number): ChatMessage[] {
  const p = messagesPath(sessionId);
  if (!existsSync(p)) return [];
  const all = readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) as ChatMessage; } catch { return null; }
    })
    .filter((m): m is ChatMessage => m !== null);
  return limit !== undefined ? all.slice(-limit) : all;
}
