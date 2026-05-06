import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml, parseDocument, type Document } from "yaml";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

export const PROVIDER_NAMES = ["anthropic", "openai", "google"] as const;
export type ProviderName = typeof PROVIDER_NAMES[number];

// ──────────────────────────────────────────────
// 对话（chat）系统全局配置
// ──────────────────────────────────────────────

export interface ConversationConfig {
  /** 全局主对话 agent 的名字；对话命令未指定 --agent / --workflow 时使用 */
  default_agent?: string;
}

export function loadConversationConfig(): ConversationConfig {
  try {
    const raw = loadConfig();
    const section = raw["conversation"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: ConversationConfig = {};
    if (typeof s.default_agent === "string" && s.default_agent.trim()) {
      out.default_agent = s.default_agent.trim();
    }
    return out;
  } catch { return {}; }
}

// ──────────────────────────────────────────────
// 默认偏好（defaults）
// ──────────────────────────────────────────────

export interface DefaultsConfig {
  /** 创建定时任务时的默认时区；未设置时 scheduler 用机器时区 */
  timezone?: string;
}

export function loadDefaultsConfig(): DefaultsConfig {
  try {
    const raw = loadConfig();
    const section = raw["defaults"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: DefaultsConfig = {};
    if (typeof s.timezone === "string" && s.timezone.trim()) out.timezone = s.timezone.trim();
    return out;
  } catch {
    return {};
  }
}

export function saveDefaultsConfig(cfg: DefaultsConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["defaults"])) doc.deleteIn(["defaults"]);
  } else {
    doc.setIn(["defaults"], clean);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// daemon 监听配置
// ──────────────────────────────────────────────

export interface DaemonListenConfig {
  host?: string;
  port?: number;
}

/**
 * 读取 config.yaml 的 daemon 段。返回已校验的部分配置；字段缺失或类型
 * 非法时忽略（调用方用自己默认值）。
 */
export function loadDaemonConfig(): DaemonListenConfig {
  try {
    const raw = loadConfig();
    const section = raw["daemon"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const out: DaemonListenConfig = {};
    const s = section as Record<string, unknown>;
    if (typeof s.host === "string" && s.host.trim()) out.host = s.host.trim();
    if (typeof s.port === "number" && Number.isInteger(s.port) && s.port > 0 && s.port < 65536) {
      out.port = s.port;
    }
    return out;
  } catch { return {}; }
}

// ──────────────────────────────────────────────
// GitHub 集成配置
// ──────────────────────────────────────────────

export interface GithubConfig {
  /** gh 可执行路径 */
  cli: string;
  /** PR 轮询间隔（秒），最小 30s */
  poll_interval_seconds: number;
}

/**
 * 读取 config.yaml 的 github 段。缺字段或类型不对走默认值。
 *
 * 默认值：
 *   - cli: "gh"
 *   - poll_interval_seconds: 300（5 min）
 *
 * 最小 poll_interval = 30s，保护 GitHub API rate limit。
 */
export function loadGithubConfig(): GithubConfig {
  try {
    const raw = loadConfig();
    const section = raw["github"];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return { cli: "gh", poll_interval_seconds: 300 };
    }
    const s = section as Record<string, unknown>;

    const cliRaw = s["cli"];
    const cli = typeof cliRaw === "string" && cliRaw.trim()
      ? cliRaw.trim()
      : "gh";

    const pollRaw = s["poll_interval_seconds"];
    const poll = typeof pollRaw === "number" && Number.isFinite(pollRaw) && pollRaw >= 30
      ? pollRaw
      : 300;

    return { cli, poll_interval_seconds: poll };
  } catch {
    return { cli: "gh", poll_interval_seconds: 300 };
  }
}

export interface ProviderConfig {
  /** provider 默认模型。agent 未显式指定 model 时使用此值 */
  default_model?: string;
  /** 是否启用。禁用时仍可保留配置，但注册该 provider 的 agent 不会被实例化 */
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * 返回当前使用的 config.yaml 路径。
 * 优先级：DEV_WORKFLOW_CONFIG > AUTOPILOT_HOME/config.yaml
 */
export function getConfigPath(): string {
  if (process.env.DEV_WORKFLOW_CONFIG && existsSync(process.env.DEV_WORKFLOW_CONFIG)) {
    return process.env.DEV_WORKFLOW_CONFIG;
  }
  return join(AUTOPILOT_HOME, "config.yaml");
}

export function loadConfig(): Record<string, unknown> {
  const paths = [
    process.env.DEV_WORKFLOW_CONFIG,
    join(AUTOPILOT_HOME, "config.yaml"),
    join(process.cwd(), "config.yaml"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        return parseYaml(content) ?? {};
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log.error("配置文件解析失败（%s）：%s", p, message);
        throw new Error(`配置文件解析失败（${p}）：${message}`);
      }
    }
  }
  return {};
}

/**
 * 读取 config.yaml 原文。
 */
export function loadConfigRaw(): string {
  const p = getConfigPath();
  if (existsSync(p)) {
    return readFileSync(p, "utf-8");
  }
  return "";
}

/**
 * 保存配置到 config.yaml。写入前备份原文件。
 * @param yamlContent YAML 格式的字符串
 * @throws 如果 YAML 解析失败
 */
export function saveConfigRaw(yamlContent: string): void {
  // 先校验 YAML 语法
  parseYaml(yamlContent);

  const p = getConfigPath();
  // 备份
  if (existsSync(p)) {
    copyFileSync(p, p + ".bak");
  }
  writeFileSync(p, yamlContent, "utf-8");
}

/**
 * 从全局 config.yaml 读取 `agents.<name>` 段，返回 `name -> partial AgentConfig` 映射。
 * 不校验字段，由 agents/registry 在合并后的 AgentConfig 上做校验。
 */
export function loadGlobalAgents(): Record<string, Record<string, unknown>> {
  return loadSection("agents");
}

/**
 * 读取 `providers.<name>` 段。仅返回已知的三个 provider；未配置时该 provider 对应值为 {}。
 */
export function loadProviders(): Record<ProviderName, ProviderConfig> {
  const raw = loadSection("providers");
  const out: Record<string, ProviderConfig> = {};
  for (const name of PROVIDER_NAMES) {
    const value = raw[name];
    out[name] = value && typeof value === "object" ? (value as ProviderConfig) : {};
  }
  return out as Record<ProviderName, ProviderConfig>;
}

function loadSection(key: string): Record<string, Record<string, unknown>> {
  const raw = loadConfig();
  const section = raw[key];
  if (!section || typeof section !== "object" || Array.isArray(section)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[name] = value as Record<string, unknown>;
    }
  }
  return out;
}

// ──────────────────────────────────────────────
// 结构化写入（保留 YAML 注释与其他段）
// ──────────────────────────────────────────────

function loadDocument(): Document {
  const raw = loadConfigRaw();
  return raw ? parseDocument(raw) : parseDocument("{}\n");
}

function writeDocument(doc: Document): void {
  // toString 可能产生 "{}\n" 这种空文档；需要时自动整理
  const yaml = doc.toString();
  saveConfigRaw(yaml);
}

/**
 * 写入/更新某个 provider 的配置。undefined 字段会被删除。
 */
export function saveProvider(name: ProviderName, cfg: ProviderConfig): void {
  if (!PROVIDER_NAMES.includes(name)) {
    throw new Error(`未知 provider：${name}`);
  }
  const doc = loadDocument();
  const clean = stripUndefined(cfg);
  doc.setIn(["providers", name], clean);
  writeDocument(doc);
}

/**
 * 写入/更新某个 agent 的配置。
 */
export function saveAgent(name: string, cfg: Record<string, unknown>): void {
  if (!name || !/^[\w.\-]+$/.test(name)) {
    throw new Error(`非法 agent 名：${name}（仅允许字母、数字、._-）`);
  }
  const doc = loadDocument();
  const clean = stripUndefined(cfg);
  // 不允许把 name 字段写入 YAML（key 即 name）
  delete clean["name"];
  doc.setIn(["agents", name], clean);
  writeDocument(doc);
}

export function deleteAgent(name: string): boolean {
  const doc = loadDocument();
  if (!doc.hasIn(["agents", name])) return false;
  doc.deleteIn(["agents", name]);
  writeDocument(doc);
  return true;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (typeof v === "string" && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}
