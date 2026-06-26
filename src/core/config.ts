import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml, parseDocument, type Document } from "yaml";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

export const PROVIDER_NAMES = ["anthropic", "openai", "google"] as const;
export type ProviderName = typeof PROVIDER_NAMES[number];

// ──────────────────────────────────────────────
// 默认偏好（defaults）
// ──────────────────────────────────────────────

export interface DefaultsConfig {
  /** 用户偏好时区；未设置时回退机器时区 */
  timezone?: string;
}

// ── 时区工具 ──

/** 返回当前机器的 IANA 时区标识（如 "Asia/Shanghai"），无法检测时回退 "UTC" */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 检测给定时区字符串是否为有效的 IANA 时区 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
// notify driver 配置（config.yaml notify.drivers[]）
// ──────────────────────────────────────────────

export interface NotifyDriverConfigEntry {
  type: string;
  on_events?: string[];
  [key: string]: unknown;
}

/**
 * 读取 config.yaml 的 notify.drivers 段。返回 driver 配置数组；段缺失/非法时返回 []。
 * 任意 entry 缺 type 字段 → 跳过该 entry + warn。
 */
export function loadNotifyDrivers(): NotifyDriverConfigEntry[] {
  try {
    const raw = loadConfig();
    const section = raw["notify"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return [];
    const drivers = (section as Record<string, unknown>)["drivers"];
    if (!Array.isArray(drivers)) return [];
    const out: NotifyDriverConfigEntry[] = [];
    for (const d of drivers) {
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      const obj = d as Record<string, unknown>;
      if (typeof obj.type !== "string" || !obj.type.trim()) continue;
      const entry: NotifyDriverConfigEntry = { type: obj.type.trim() };
      if (Array.isArray(obj.on_events)) {
        entry.on_events = obj.on_events.filter((e): e is string => typeof e === "string");
      }
      // 透传其他字段（如 slack-webhook 的 url）
      for (const [k, v] of Object.entries(obj)) {
        if (k !== "type" && k !== "on_events") entry[k] = v;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
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

/**
 * 写回 daemon section 的 host/port。Token 不在此处管理 —— 见 core/api-token.ts。
 * 字段为 undefined 时从 yaml 删除对应键；section 整体空则删 daemon 段。
 */
export function saveDaemonConfig(cfg: DaemonListenConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["daemon"])) doc.deleteIn(["daemon"]);
  } else {
    doc.setIn(["daemon"], clean);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// GitHub 集成配置
// ──────────────────────────────────────────────

export interface GithubConfig {
  /** gh 可执行路径 */
  cli: string;
  /** PR 轮询间隔（秒），最小 30s */
  poll_interval_seconds: number;
  /** 同一交付 PR 的 CI 自动修复触发上限（触顶停下报人，不再自动修）；默认 2。设 0 = 关闭 CI 自动修复 */
  ci_fix_limit: number;
  /** 哪些 CI 结论算「值得自动起修复轮的失败」；默认 FAILURE / TIMED_OUT / STARTUP_FAILURE */
  ci_fix_conclusions: string[];
}

/** CI 自动修复的容错策略缺省（用户可在 config.yaml github 段覆盖）——框架给机制，阈值/触发集归用户。 */
const DEFAULT_CI_FIX_LIMIT = 2;
const DEFAULT_CI_FIX_CONCLUSIONS = ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"];

/**
 * 读取 config.yaml 的 github 段。缺字段或类型不对走默认值。
 *
 * 默认值：
 *   - cli: "gh"
 *   - poll_interval_seconds: 300（5 min），最小 30s（保护 GitHub API rate limit）
 *   - ci_fix_limit: 2（同 PR 自动修 CI 几次后停下报人；0 = 关闭自动修复）
 *   - ci_fix_conclusions: [FAILURE, TIMED_OUT, STARTUP_FAILURE]
 */
export function loadGithubConfig(): GithubConfig {
  const fallback: GithubConfig = {
    cli: "gh",
    poll_interval_seconds: 300,
    ci_fix_limit: DEFAULT_CI_FIX_LIMIT,
    ci_fix_conclusions: DEFAULT_CI_FIX_CONCLUSIONS,
  };
  try {
    const raw = loadConfig();
    const section = raw["github"];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return fallback;
    }
    const s = section as Record<string, unknown>;

    const cliRaw = s["cli"];
    const cli = typeof cliRaw === "string" && cliRaw.trim() ? cliRaw.trim() : "gh";

    const pollRaw = s["poll_interval_seconds"];
    const poll = typeof pollRaw === "number" && Number.isFinite(pollRaw) && pollRaw >= 30
      ? pollRaw
      : 300;

    const limitRaw = s["ci_fix_limit"];
    const ci_fix_limit = typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw >= 0
      ? limitRaw
      : DEFAULT_CI_FIX_LIMIT;

    const conclRaw = s["ci_fix_conclusions"];
    const ci_fix_conclusions = Array.isArray(conclRaw) && conclRaw.length > 0 && conclRaw.every((x) => typeof x === "string")
      ? (conclRaw as string[]).map((x) => x.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_CI_FIX_CONCLUSIONS;

    return { cli, poll_interval_seconds: poll, ci_fix_limit, ci_fix_conclusions };
  } catch {
    return fallback;
  }
}

export interface ProviderConfig {
  /** provider 默认模型。agent 未显式指定 model 时使用此值 */
  default_model?: string;
  /** 是否启用。禁用时仍可保留配置，但注册该 provider 的 agent 不会被实例化 */
  enabled?: boolean;
  /** provider 级默认接入方式：cli 或 api。不填则按供应商类型判断 */
  mode?: "cli" | "api";
  /** 自定义 base_url（API 模式下覆盖官方默认端点） */
  base_url?: string;
  /** 自定义 compat provider 的环境变量回落名 */
  env_key_name?: string;
  [key: string]: unknown;
}

/**
 * 返回当前使用的 config.yaml 路径。
 * 优先级：DEV_WORKFLOW_CONFIG > AUTOPILOT_HOME/config.yaml
 * 注意：每次调用时动态读取环境变量，以支持测试隔离。
 */
export function getConfigPath(): string {
  if (process.env.DEV_WORKFLOW_CONFIG && existsSync(process.env.DEV_WORKFLOW_CONFIG)) {
    return process.env.DEV_WORKFLOW_CONFIG;
  }
  const home = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
  return join(home, "config.yaml");
}

export function loadConfig(): Record<string, unknown> {
  const paths = [
    getConfigPath(),                     // DEV_WORKFLOW_CONFIG > AUTOPILOT_HOME/config.yaml（动态读取环境变量）
    join(process.cwd(), "config.yaml"),  // cwd 兜底
  ];

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
 * 读取 `providers.<name>` 段。返回已知的三个内置 provider + 所有用户配置的自定义 provider；
 * 未配置时内置 provider 对应值为 {}。
 */
export function loadProviders(): Record<string, ProviderConfig> {
  const raw = loadSection("providers");
  const out: Record<string, ProviderConfig> = {};
  // 三大内置 provider 始终存在
  for (const name of PROVIDER_NAMES) {
    const value = raw[name];
    out[name] = value && typeof value === "object" ? (value as ProviderConfig) : {};
  }
  // 自定义 provider（如 deepseek / kimi / minimax / 用户自定义 compat）
  for (const [name, value] of Object.entries(raw)) {
    if (name in out) continue; // 跳过已处理的内置 provider
    if (value && typeof value === "object") {
      out[name] = value as ProviderConfig;
    }
  }
  return out;
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
 * 读 config.yaml `providers.default` —— 系统默认 provider 名（用户偏好指针）。
 * `default` 是 providers 段下的保留键（字符串值，非 provider 条目）；loadProviders/loadSection
 * 只收对象值，天然不会把它误当条目。未设/空返回 undefined（由 resolveDefaultProvider 派生兜底）。
 */
export function loadDefaultProviderName(): string | undefined {
  const raw = loadConfig() as Record<string, unknown>;
  const providers = raw["providers"];
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    const d = (providers as Record<string, unknown>)["default"];
    if (typeof d === "string" && d.trim()) return d.trim();
  }
  return undefined;
}

/** 写/删 `providers.default`（merge-safe，保留 YAML 注释与其他段）。空 = 删键回退派生。 */
export function setDefaultProviderName(name: string | undefined): void {
  const doc = loadDocument();
  const trimmed = name?.trim();
  if (trimmed) doc.setIn(["providers", "default"], trimmed);
  else doc.deleteIn(["providers", "default"]);
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// 生命周期 agent 配置（lifecycle: 段）
//   平台固定生命周期阶段（clarify / extract / fix / author）的 agent override。
//   不属于任何工作流（数据层/平台），全局生效。字段省略走代码兜底。
// ──────────────────────────────────────────────

const LIFECYCLE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** 读 config.yaml `lifecycle:` 段 → { clarify: {...}, ... }（用户显式写的 override，未写=空）。 */
export function loadLifecycleConfig(): Record<string, Record<string, unknown>> {
  return loadSection("lifecycle");
}

/** 写/删某生命周期 agent 的 override；cfg=null 删整段回退默认。保留 YAML 注释与其他段。 */
export function saveLifecycleAgent(name: string, cfg: Record<string, unknown> | null): void {
  if (!LIFECYCLE_NAME_RE.test(name)) {
    throw new Error(`非法生命周期 agent 名：${name}`);
  }
  const doc = loadDocument();
  if (cfg === null) {
    doc.deleteIn(["lifecycle", name]);
    const node = doc.getIn(["lifecycle"]) as { items?: unknown[] } | undefined;
    if (node && Array.isArray(node.items) && node.items.length === 0) doc.deleteIn(["lifecycle"]);
  } else {
    doc.setIn(["lifecycle", name], stripUndefined(cfg));
  }
  writeDocument(doc);
}

const PROVIDER_NAME_RE = /^[a-z0-9_-]+$/i;

/**
 * 字段级写入某 provider 的 default_model（merge-safe：只动 default_model 单键，
 * 保留 base_url / env_key_name 等兄弟字段与 YAML 注释）。服务任意已注册 provider
 * （官方 + compat），故只做格式校验，业务白名单（哪些名合法）由调用方/RPC 层把关。
 * model 为空 = 删字段回退到预置默认。
 */
export function setProviderDefaultModel(name: string, model?: string): void {
  if (!name || !PROVIDER_NAME_RE.test(name)) {
    throw new Error(`非法 provider 名：${name}`);
  }
  const doc = loadDocument();
  const trimmed = model?.trim();
  if (trimmed) {
    doc.setIn(["providers", name, "default_model"], trimmed);
  } else {
    doc.deleteIn(["providers", name, "default_model"]);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// git 凭据配置
// ──────────────────────────────────────────────

export interface GitConfig {
  /**
   * 私有仓库 HTTPS clone 用 token（全局共用）。
   * HTTP URL clone 时自动注入：https://oauth2:<token>@<host>/...
   * SSH URL 不使用（走系统 SSH key）。
   * 未设置时退回系统 git 凭证（~/.gitconfig credential helper / gh CLI 等）。
   */
  token?: string;
}

/**
 * 读取 config.yaml 的 git 段。
 */
export function loadGitConfig(): GitConfig {
  try {
    const raw = loadConfig();
    const section = raw["git"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: GitConfig = {};
    if (typeof s.token === "string" && s.token.trim()) out.token = s.token.trim();
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入 git 段配置（token 为 undefined 时删除键）。
 */
export function saveGitConfig(cfg: GitConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["git"])) doc.deleteIn(["git"]);
  } else {
    doc.setIn(["git"], clean);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// 调度器配置
// ──────────────────────────────────────────────

export interface SchedulerConfig {
  /**
   * 全局最大并发任务数（所有工作区合计运行中任务总数 ≤ N）。
   * 默认 1（向后兼容：不配置时行为与之前相同）。
   *
   * ⚠️ 行为说明（N=1 时）：原实现是「组内串行，不同组可并行」；
   * 改为全局计数后，N=1 对多 workspace 用户是更严格的全局串行。
   * 这是有意为之的行为统一（需求澄清 Q1 答案：全局总上限）。
   *
   * ⚠️ 约束范围 = 仅 execution run（scheduler 起的常规任务）。**fix 修复回路例外**：
   * 需求转 fix_revision 时 fix-revision-runner 直接起 kind=fix run（续作），不经 scheduler 闸门、
   * 不读此值。fix_revision 计入 active 只阻止再调度新 queued，不阻止 fix-runner 自己起 fix run，
   * 故 awaiting_review 释放槽后又被 fix run 占回时 active 可瞬时 +1 超 N（有界、短暂）——这是有意
   * 设计：修复回路是「已接活的需求把活干完」，不该被并发上限二次排队卡住。要严格限流需另立 fix
   * 专属上限，非本字段语义。
   */
  max_concurrent_tasks?: number;
}

/**
 * 读取 config.yaml 的 scheduler 段。
 * 字段缺失或类型非法时返回空对象；调用方使用 `?? 1` 取默认值 1。
 */
export function loadSchedulerConfig(): SchedulerConfig {
  try {
    const raw = loadConfig();
    const section = raw["scheduler"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: SchedulerConfig = {};
    if (
      typeof s.max_concurrent_tasks === "number" &&
      Number.isInteger(s.max_concurrent_tasks) &&
      s.max_concurrent_tasks >= 1
    ) {
      out.max_concurrent_tasks = s.max_concurrent_tasks;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入/更新 scheduler 段。max_concurrent_tasks 为 undefined 时删除整段。
 */
export function saveSchedulerConfig(cfg: SchedulerConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["scheduler"])) doc.deleteIn(["scheduler"]);
  } else {
    doc.setIn(["scheduler"], clean);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// runner 模式配置（A 模式：autopilot 作为 reqgenie 自托管 runner）
// ──────────────────────────────────────────────

export type RunMode = "scheduler" | "runner";

/**
 * 读顶层 `mode:`（scheduler=传统调度 daemon；runner=reqgenie 自托管执行器）。
 * 缺省/非法回退 scheduler（向后兼容：现存用户无 mode 字段=照旧）。
 */
export function loadRunMode(): RunMode {
  try {
    const raw = loadConfig();
    const m = raw["mode"];
    return m === "runner" ? "runner" : "scheduler";
  } catch { return "scheduler"; }
}

export interface RunnerConfig {
  /** reqgenie 控制平面 URL（凭证落 runner/credentials.json，此处只存非敏感连接元数据）。 */
  control_plane_url?: string;
  /** runner 展示名。 */
  name?: string;
  /** /sessions/pending 长轮询挂起秒数（默认 50）。 */
  poll_wait_seconds?: number;
  /** runner 级心跳间隔秒（默认 30）。 */
  heartbeat_seconds?: number;
}

/** 读 config.yaml `runner:` 段（凭证不在此，见 runner/credentials.ts）。 */
export function loadRunnerConfig(): RunnerConfig {
  try {
    const raw = loadConfig();
    const section = raw["runner"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: RunnerConfig = {};
    if (typeof s.control_plane_url === "string" && s.control_plane_url.trim()) out.control_plane_url = s.control_plane_url.trim();
    if (typeof s.name === "string" && s.name.trim()) out.name = s.name.trim();
    if (typeof s.poll_wait_seconds === "number" && Number.isInteger(s.poll_wait_seconds) && s.poll_wait_seconds > 0) out.poll_wait_seconds = s.poll_wait_seconds;
    if (typeof s.heartbeat_seconds === "number" && Number.isInteger(s.heartbeat_seconds) && s.heartbeat_seconds > 0) out.heartbeat_seconds = s.heartbeat_seconds;
    return out;
  } catch { return {}; }
}

/** 写 `runner:` 段（merge-safe，保留注释；空字段删键，整段空删 runner 段）。 */
export function saveRunnerConfig(cfg: RunnerConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["runner"])) doc.deleteIn(["runner"]);
  } else {
    doc.setIn(["runner"], clean);
  }
  writeDocument(doc);
}

// ──────────────────────────────────────────────
// selfhosted 连接器配置（B-interactive 模式）
// ──────────────────────────────────────────────

export interface SelfhostedConfig {
  /** reqgenie 控制平面 URL（如 https://reqgenie.example.com）。凭证落 selfhosted/credentials.json，此处存非敏感连接元数据。 */
  control_plane_url?: string;
  /** 是否启用 selfhosted connector。true = daemon 启动时自动连接 reqgenie 控制面。 */
  enabled?: boolean;
  /** /assignments/pending 与 /commands/pending 长轮询挂起秒数（默认 50）。 */
  poll_wait_seconds?: number;
  /** 心跳间隔秒（默认 30）。 */
  heartbeat_seconds?: number;
}

/**
 * 读 config.yaml `selfhosted:` 段（B-interactive 实例连接器配置）。
 * 凭证不在此，见 selfhosted-connector/credentials.ts。
 * 字段缺失/类型非法时忽略，调用方用自己默认值。
 */
export function loadSelfhostedConfig(): SelfhostedConfig {
  try {
    const raw = loadConfig();
    const section = raw["selfhosted"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: SelfhostedConfig = {};
    if (typeof s.control_plane_url === "string" && s.control_plane_url.trim()) out.control_plane_url = s.control_plane_url.trim();
    if (typeof s.enabled === "boolean") out.enabled = s.enabled;
    if (typeof s.poll_wait_seconds === "number" && Number.isInteger(s.poll_wait_seconds) && s.poll_wait_seconds > 0) out.poll_wait_seconds = s.poll_wait_seconds;
    if (typeof s.heartbeat_seconds === "number" && Number.isInteger(s.heartbeat_seconds) && s.heartbeat_seconds > 0) out.heartbeat_seconds = s.heartbeat_seconds;
    return out;
  } catch { return {}; }
}

/** 写 `selfhosted:` 段（merge-safe，保留注释；空字段删键，整段空删 selfhosted 段）。 */
export function saveSelfhostedConfig(cfg: SelfhostedConfig): void {
  const doc = loadDocument();
  const clean = stripUndefined(cfg as Record<string, unknown>);
  if (Object.keys(clean).length === 0) {
    if (doc.hasIn(["selfhosted"])) doc.deleteIn(["selfhosted"]);
  } else {
    doc.setIn(["selfhosted"], clean);
  }
  writeDocument(doc);
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
