/**
 * Provider 条目 CRUD（spec: 2026-06-13-provider-entries-redesign，P1）。
 *
 * provider = 用户自管的单类型实例：每条带 type(cli|api) + subtype，可增删。
 * SQLite 即权威源（无 manifest 同步需求）。core 只存「形状」——subtype→适配器的
 * 业务映射在 agents 层，本模块不识 agent/CLI 语义。
 *
 * P1：硬删 + 引用守卫（守卫在 RPC 层）。软删降级（state='deleted' + 三闸门）留 P2。
 */
import { getDb } from "./db";

export type ProviderType = "cli" | "api";
export type ProviderState = "active" | "deleted";
export type ProviderOrigin = "seed" | "template" | "user";

export interface ProviderEntry {
  id: string;
  name: string;
  display_name: string;
  type: ProviderType;
  subtype: string;
  cli_bin: string | null;
  cli_login_cmd: string | null;
  cli_status: string | null;
  cli_version: string | null;
  cli_checked_at: string | null;
  base_url: string | null;
  env_key_name: string | null;
  default_model: string | null;
  enabled: number; // 0 | 1
  state: ProviderState;
  origin: ProviderOrigin;
  created_at: string;
  updated_at: string;
}

export interface CreateProviderInput {
  name: string;
  display_name: string;
  type: ProviderType;
  subtype: string;
  cli_bin?: string | null;
  cli_login_cmd?: string | null;
  base_url?: string | null;
  env_key_name?: string | null;
  default_model?: string | null;
  origin?: ProviderOrigin;
}

export interface UpdateProviderInput {
  display_name?: string;
  subtype?: string;
  cli_bin?: string | null;
  cli_login_cmd?: string | null;
  base_url?: string | null;
  env_key_name?: string | null;
  default_model?: string | null;
  enabled?: boolean;
}

const NAME_RE = /^[a-z0-9_-]+$/i;

/** 生成下一个 provider id（prov-NNN，扫最大编号 +1，PK 兜底并发）。 */
export function nextProviderId(): string {
  const db = getDb();
  const rows = db
    .query<{ id: string }, []>("SELECT id FROM providers WHERE id GLOB 'prov-[0-9]*' ORDER BY id DESC LIMIT 1")
    .all();
  if (rows.length === 0) return "prov-001";
  const n = parseInt(rows[0].id.replace("prov-", ""), 10) + 1;
  return `prov-${String(n).padStart(3, "0")}`;
}

/** 列出 provider 条目；默认只返回 active（state!='deleted'）。 */
export function listProviders(opts?: { includeDeleted?: boolean }): ProviderEntry[] {
  const db = getDb();
  const sql = opts?.includeDeleted
    ? "SELECT * FROM providers ORDER BY created_at ASC"
    : "SELECT * FROM providers WHERE state != 'deleted' ORDER BY created_at ASC";
  return db.query<ProviderEntry, []>(sql).all();
}

export function getProviderById(id: string): ProviderEntry | null {
  const db = getDb();
  return db.query<ProviderEntry, [string]>("SELECT * FROM providers WHERE id = ?").get(id) ?? null;
}

/** 按 name 取条目（workflow agent.provider 引用键）；默认排除已删除。 */
export function getProviderByName(name: string, opts?: { includeDeleted?: boolean }): ProviderEntry | null {
  const db = getDb();
  const row = db.query<ProviderEntry, [string]>("SELECT * FROM providers WHERE name = ?").get(name);
  if (!row) return null;
  if (!opts?.includeDeleted && row.state === "deleted") return null;
  return row;
}

export function createProvider(input: CreateProviderInput): ProviderEntry {
  if (!input.name || !NAME_RE.test(input.name)) {
    throw new Error(`非法 provider 名：${input.name}（仅允许字母/数字/_/-）`);
  }
  if (input.type !== "cli" && input.type !== "api") {
    throw new Error(`非法 provider 类型：${input.type}`);
  }
  if (getProviderByName(input.name, { includeDeleted: true })) {
    throw new Error(`provider 名已存在：${input.name}`);
  }
  const db = getDb();
  const id = nextProviderId();
  db.run(
    `INSERT INTO providers
       (id, name, display_name, type, subtype, cli_bin, cli_login_cmd, base_url, env_key_name, default_model, enabled, state, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?)`,
    [
      id, input.name, input.display_name, input.type, input.subtype,
      input.cli_bin ?? null, input.cli_login_cmd ?? null, input.base_url ?? null,
      input.env_key_name ?? null, input.default_model ?? null, input.origin ?? "user",
    ],
  );
  return getProviderById(id) as ProviderEntry;
}

export function updateProvider(id: string, patch: UpdateProviderInput): ProviderEntry | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { fields.push(`${col} = ?`); vals.push(v); };

  if (patch.display_name !== undefined) set("display_name", patch.display_name);
  if (patch.subtype !== undefined) set("subtype", patch.subtype);
  if (patch.cli_bin !== undefined) set("cli_bin", patch.cli_bin);
  if (patch.cli_login_cmd !== undefined) set("cli_login_cmd", patch.cli_login_cmd);
  if (patch.base_url !== undefined) set("base_url", patch.base_url);
  if (patch.env_key_name !== undefined) set("env_key_name", patch.env_key_name);
  if (patch.default_model !== undefined) set("default_model", patch.default_model);
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);

  if (fields.length === 0) return getProviderById(id);
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.run(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`, vals);
  return getProviderById(id);
}

/** 落 CLI 探测结果（provider-cli-monitor / 添加时调用）。 */
export function setProviderCliStatus(
  id: string,
  status: "ok" | "missing" | "unknown",
  version?: string | null,
): void {
  const db = getDb();
  db.run(
    "UPDATE providers SET cli_status = ?, cli_version = ?, cli_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [status, version ?? null, id],
  );
}

/** P1：硬删（引用守卫在 RPC 层）。P2 会改为软删 state='deleted'。 */
export function deleteProvider(id: string): void {
  const db = getDb();
  db.run("DELETE FROM providers WHERE id = ?", [id]);
}
