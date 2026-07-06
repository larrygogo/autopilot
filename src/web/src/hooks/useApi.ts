import type { Notification } from "../lib/notification-types";
import { rpcCall } from "../lib/ws-singleton";
import { RpcCallError, type CallOptions } from "../lib/ws-rpc-client";
import { getApiToken, shouldUseToken } from "../lib/api-token";
import { classifyFeedback, type FeedbackSubtype } from "../lib/feedback-classify";

export type { FeedbackSubtype };

const BASE = "";

// ──────────────────────────────────────────────
// Comment → 旧 Question / RequirementFeedback 适配
// 仅用于让 UI 沿用旧字段名（agent_text / replies / RequirementFeedback.source）
// ──────────────────────────────────────────────

function commentToQuestionReply(c: { id: string; parent_id: string | null; from_role: string; body: string; created_at: number }): QuestionReply {
  return {
    id: c.id,
    question_id: c.parent_id ?? "",
    author_role: (c.from_role === "user" ? "user" : "agent"),
    text: c.body,
    created_at: c.created_at,
  };
}

function commentsToQuestions(all: Comment[]): Question[] {
  const tops = all.filter((c) => c.kind === "question" && c.parent_id === null);
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of all) {
    if (c.kind === "question" && c.parent_id) {
      const arr = repliesByParent.get(c.parent_id) ?? [];
      arr.push(c);
      repliesByParent.set(c.parent_id, arr);
    }
  }
  return tops.map<Question>((q) => ({
    id: q.id,
    requirement_id: q.requirement_id,
    agent_text: q.body,
    suggestions: q.suggestions ?? [],
    status: q.status,
    created_at: q.created_at,
    resolved_at: q.resolved_at,
    replies: (repliesByParent.get(q.id) ?? []).map(commentToQuestionReply),
  }));
}

function commentsToFeedbacks(all: Comment[]): RequirementFeedback[] {
  let fakeId = 0;
  return all
    .filter((c) => c.kind === "feedback")
    .map<RequirementFeedback>((c) => ({
      // 旧 RequirementFeedback.id 是 INTEGER；comment.id 是字符串（fb-N 或 cmt-N）。
      // UI 仅用 id 做 React key，不用真整数。这里给递增整数避免 number 类型冲突。
      id: ++fakeId,
      requirement_id: c.requirement_id,
      source: c.from_role === "github" ? "github_review" : "manual",
      from_role: c.from_role,
      subtype: classifyFeedback(c.from_role, c.body),
      body: c.body,
      github_review_id: c.github_review_id,
      created_at: c.created_at,
    }));
}

/**
 * 内联 agent 配置（命名复用 agent 删除后的唯一形态）。
 * 与后端 core/agent-defaults.InlineAgentConfig 同构；phase 上挂 `agent` 字段，
 * dry-run 时也直接传这个对象，省略则后端走 DEFAULT_AGENT 兜底。
 */
export interface InlineAgentConfig {
  provider?: string;
  /** 执行模式：cli（子进程，官方凭证）/ api（直连，内置工具）；省略走 resolveMode 派生 */
  mode?: "cli" | "api";
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

/** 生命周期 agent 配置（lifecycle.list 返回项）。 */
export interface LifecycleAgentInfo {
  name: string;
  display_name: string;
  note: string;
  effective: InlineAgentConfig;
  userConfig: InlineAgentConfig | null;
  defaults: InlineAgentConfig;
  reqOverridable: boolean;
}

/** dry-run 时把临时 model/max_turns 覆盖合到内联配置上；全空则返回 undefined（让后端走默认）。 */
function mergeInlineAgent(
  agent: InlineAgentConfig | undefined,
  override: { model?: string; max_turns?: number },
): InlineAgentConfig | undefined {
  const merged: InlineAgentConfig = { ...(agent ?? {}) };
  if (override.model) merged.model = override.model;
  if (typeof override.max_turns === "number" && override.max_turns > 0) merged.max_turns = override.max_turns;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 返回需要塞进 fetch headers 的 token 字段；本机访问不需要 token 时返回空对象。 */
function authHeaders(): Record<string, string> {
  if (!shouldUseToken()) return {};
  const token = getApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * 走 WS RPC 的薄包装 — 当前阶段只迁了少量 PoC method（见下方注释标记），
 * 其余 method 仍走 HTTP request()。两套并存，逐步迁移。
 *
 * 错误归一化：RpcCallError 转成普通 Error，文案包含 code，便于现有 UI 错误展示。
 */
export async function requestRpc<T>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
  try {
    return await rpcCall<T>(method, params, opts);
  } catch (e: unknown) {
    if (e instanceof RpcCallError) {
      // DISCONNECTED 时给跟旧 fetch 失败一致的提示，让现有 daemon 失联横幅能复用判断
      if (e.code === "DISCONNECTED") {
        throw new Error("WebSocket 未连接（daemon 是否在运行？）");
      }
      throw new Error(`${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * 标记新添加的 API endpoint（daemon 须是最新代码才有）。404 时提示重启 daemon。
 *
 * 严格 endpoint 匹配，不用 prefix 模糊匹配 —— 否则 `/api/requirements/<不存在的 id>` 这种
 * "endpoint 在但 resource 不存在"的 404 也会被误判为"daemon 旧版"，让用户看到误导提示。
 *
 * 顶层 collection endpoint 用 `(\?.*)?$` 允许 query string，但不匹配 `/:id` 子路径。
 */
const NEW_API_PATTERNS: RegExp[] = [
  // 带固定后缀的子路径 endpoint
  /^\/api\/workflows\/[\w.\-]+\/phases$/,
  /^\/api\/workflows\/[\w.\-]+\/sync-ts$/,
  /^\/api\/requirements\/[\w.\-]+\/sub-prs$/,
  /^\/api\/requirements\/[\w.\-]+\/spec-revisions$/,
  /^\/api\/requirements\/[\w.\-]+\/clarifier-round$/,
  /^\/api\/requirements\/[\w.\-]+\/attachments(\/[\w.\-]+)?$/,
  // 顶层 collection endpoint（list/create，不匹配 /:id 详情）
  /^\/api\/providers(\?.*)?$/,
  /^\/api\/defaults(\?.*)?$/,
  /^\/api\/fs\//,
  /^\/api\/requirements(\?.*)?$/,
  /^\/api\/projects(\?.*)?$/,
  /^\/api\/now\/cards(\?.*)?$/,
  /^\/api\/daemon\/listen(\?.*)?$/,
  /^\/api\/daemon\/token\/rotate$/,
  /^\/api\/daemon\/token$/,
];

export interface DaemonListenInfo {
  host: string;
  port: number;
  token: {
    is_set: boolean;
    source: "env" | "file" | "none";
    preview: string | null;
  };
  lan_ips: string[];
  mcp_note: string;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...opts?.headers },
    });
  } catch (e: unknown) {
    throw new Error(`网络请求失败：${(e as Error)?.message ?? String(e)}（daemon 是否在运行？）`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    let msg = (body as any).error ?? `HTTP ${res.status}`;
    // 401 = token 缺失/错误。局域网访问场景下 token 在 localStorage 还没设。
    if (res.status === 401 && shouldUseToken()) {
      msg = "未授权（HTTP 401）：从局域网访问 daemon 需要设置 API token，请到「设置 → 客户端 Token」配置。";
    }
    // 特判：新 API 返回 404 往往意味着 daemon 跑的是旧代码
    if (res.status === 404 && NEW_API_PATTERNS.some((re) => re.test(path))) {
      msg = `接口 ${path} 不存在（HTTP 404）。请确认 daemon 已重启到最新版本：\n\n  autopilot daemon stop && autopilot daemon start`;
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  // [WS-RPC] daemon.status — P3 第一批 PoC，已切到 WS
  getStatus: () => requestRpc<any>("daemon.status"),
  // [WS-RPC] extensions.list — daemon 扩展及其自报状态（设置 → Daemon「扩展」卡）
  listExtensions: () =>
    requestRpc<{ extensions: Array<{ id: string; enabled: boolean; running: boolean; status: Record<string, unknown> | null }> }>("extensions.list"),
  // [WS-RPC] extensions.invoke — 调用扩展动作（如 reqgenie 连接器注册）
  invokeExtension: (id: string, action: string, params?: Record<string, unknown>) =>
    requestRpc<{ result: unknown }>("extensions.invoke", { id, action, params: params ?? {} }),
  // [WS-RPC] tasks.list — P3 第一批 PoC
  listTasks: (filters?: Record<string, string>) => {
    const params: Record<string, unknown> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.workflow) params.workflow = filters.workflow;
    if (filters?.limit) params.limit = Number(filters.limit);
    return requestRpc<any[]>("tasks.list", params);
  },
  // [WS-RPC] tasks.get — P3 第一批 PoC
  getTask: (id: string) => requestRpc<any>("tasks.get", { id }),
  // [WS-RPC] tasks.listByRequirement — v2 R6：需求页 run 历史（按 seq 升序）
  listTasksByRequirement: (reqId: string) =>
    requestRpc<any[]>("tasks.listByRequirement", { requirementId: reqId }),
  // [WS-RPC] tasks.start
  startTask: (body: { title?: string; requirement?: string; workflow?: string; reqId?: string; requirement_id?: string }) =>
    requestRpc<any>("tasks.start", body),
  // [WS-RPC] tasks.cancel
  cancelTask: (id: string) => requestRpc<any>("tasks.cancel", { id }),
  // [WS-RPC] tasks.delete
  deleteTask: (id: string) =>
    requestRpc<{ ok: true; deleted: string[] }>("tasks.delete", { id }),
  // [WS-RPC] tasks.restart
  restartTask: (id: string) =>
    requestRpc<{ ok: true; phase: string; from: string }>("tasks.restart", { id }),
  // [WS-RPC] tasks.decide
  decideTask: (id: string, decision: "pass" | "reject" | "cancel", note?: string) =>
    requestRpc<{ from: string; to: string; decision: string; note: string }>(
      "tasks.decide", { id, decision, note },
    ),
  // [WS-RPC] tasks.answer
  answerTask: (id: string, text: string) =>
    requestRpc<{ ok: true }>("tasks.answer", { id, text }),
  // [WS-RPC] tasks.logs
  getTaskLogs: (id: string, limit = 100) =>
    requestRpc<any[]>("tasks.logs", { id, limit }),
  // [WS-RPC] tasks.phaseLogs
  getPhaseLogsList: (id: string) =>
    requestRpc<Array<{ phase: string; size: number; mtime: number }>>("tasks.phaseLogs", { id }),
  // [WS-RPC] tasks.phaseLog
  getPhaseLog: (id: string, phase: string, tail?: number) =>
    requestRpc<{ phase: string; content: string }>("tasks.phaseLog", { id, phase, tail }),
  // [WS-RPC] tasks.phaseEvents
  listTaskPhaseEvents: (id: string) =>
    requestRpc<{ events: TaskPhaseEvent[] }>("tasks.phaseEvents", { id }).then((r) => r.events),
  /** 同工作流历史 phase 耗时 P50 — 给"还要多久"参考 */
  // [WS-RPC] workflows.phaseStats
  getWorkflowPhaseStats: (workflow: string) =>
    requestRpc<{ stats: Record<string, { count: number; p50_ms: number }> }>(
      "workflows.phaseStats",
      { workflow },
    ).then((r) => r.stats),
  // [WS-RPC] tasks.outcome
  getTaskOutcome: (id: string) =>
    requestRpc<TaskOutcome>("tasks.outcome", { id }),
  // [WS-RPC] daemon.log
  getDaemonLog: (tail = 500) =>
    requestRpc<{ path: string | null; content: string }>("daemon.log", { tail }),
  // [WS-RPC] tasks.agentCalls
  listAgentCalls: (id: string) =>
    requestRpc<AgentCallSummary[]>("tasks.agentCalls", { id }),
  // [WS-RPC] tasks.agentCall
  getAgentCall: (id: string, seq: number) =>
    requestRpc<AgentCallRecord>("tasks.agentCall", { id, seq }),
  // [WS-RPC] sandboxes.tree（root: artifacts=产物归档 / workspace=代码 clone 工作树）
  getSandboxTree: (id: string, path: string, root: "artifacts" | "workspace" = "artifacts") =>
    requestRpc<{ path: string; entries: SandboxEntry[] }>("sandboxes.tree", { id, path, root }),
  // [WS-RPC] sandboxes.file
  getSandboxFile: (id: string, path: string, root: "artifacts" | "workspace" = "artifacts") =>
    requestRpc<{ content: string; binary: boolean; size: number; truncated: boolean }>(
      "sandboxes.file", { id, path, root },
    ),
  // download / zip 走原生 HTTP 流（浏览器需要 URL 触发下载，不能走 WS）
  sandboxDownloadUrl: (id: string, path: string) =>
    `/api/tasks/${id}/sandbox/download?path=${encodeURIComponent(path)}`,
  sandboxZipUrl: (id: string) => `/api/tasks/${id}/sandbox/zip`,
  // [WS-RPC] sandboxes.delete
  deleteSandbox: (id: string) =>
    requestRpc<{ ok: boolean; removed: boolean }>("sandboxes.delete", { id }),
  // [WS-RPC] sandboxes.usage
  getSandboxUsage: () =>
    requestRpc<{ total: number; tasks: Array<{ taskId: string; size: number; mtime: number; exists: boolean }> }>(
      "sandboxes.usage",
    ),
  // [WS-RPC] workflows.list — P3 第一批 PoC
  listWorkflows: () =>
    requestRpc<
      Array<{
        name: string;
        label?: string;
        description: string;
        source?: "db" | "file";
        derives_from?: string | null;
        /** 声明层（v2 R5）：git 输入要求（二态，含缺省派生） */
        requires_git?: boolean;
        /** 声明层（v2 R5）：产出形态（"pr"/"artifacts"…，缺省 = 事实推断） */
        delivers?: string;
      }>
    >("workflows.list"),
  // [WS-RPC] workflows.get
  getWorkflow: (name: string) =>
    requestRpc<{
      name: string;
      label?: string;
      description?: string;
      source?: "db" | "file";
      derives_from?: string | null;
      [key: string]: unknown;
    }>("workflows.get", { name }),
  // [WS-RPC] workflows.graph
  getWorkflowGraph: (name: string) => requestRpc<any>("workflows.graph", { name }),
  createWorkflow: (body: {
    name: string;
    description?: string;
    firstPhase?: string;
    derives_from?: string;
    spec_json?: string;
  }) =>
    request<{ ok: boolean; name: string; source?: string; dir?: string }>("/api/workflows", {
      method: "POST", body: JSON.stringify(body),
    }),
  // [WS-RPC] workflows.templates（RPC handler 返回 wrap {templates:[]}）
  listWorkflowTemplates: () =>
    requestRpc<{ templates: WorkflowTemplate[] }>("workflows.templates").then((r) => r.templates),
  createWorkflowFromTemplate: (body: { template: string; name: string }) =>
    request<{ ok: boolean; name: string }>("/api/workflows/from-template", {
      method: "POST", body: JSON.stringify(body),
    }),
  /** 从用户已有的工作流克隆为新工作流（区别于 createWorkflowFromTemplate 只克隆 examples 模板） */
  cloneWorkflow: (sourceName: string, targetName: string) =>
    request<{ ok: boolean; name: string }>(
      `/api/workflows/${sourceName}/clone`,
      { method: "POST", body: JSON.stringify({ name: targetName }) },
    ),
  // [WS-RPC] workflows.export —— 导出为结构原生 JSON（与 CLI / 内部 spec_json 一致）
  exportWorkflow: (name: string) =>
    requestRpc<{ content: string }>("workflows.export", { name }),
  // [WS-RPC] workflows.import —— 从 JSON 文本导入落 DB（不写磁盘；无 derives_from = native）
  importWorkflow: (body: { name: string; content: string; derives_from?: string; description?: string }) =>
    requestRpc<{ name: string; kind: string; source: string }>("workflows.import", body),
  // [WS-RPC] workflows.author（AI 长任务，给 5min 超时）
  authorWorkflow: (body: { description: string; prior_spec?: string }) =>
    requestRpc<AuthoredWorkflow>("workflows.author", body, { timeoutMs: 300_000 }),
  // [WS-RPC] workflows.saveAuthored（落 native DB，零 ts）
  saveAuthoredWorkflow: (body: { name: string; spec_json: string }) =>
    requestRpc<{ ok: boolean; name: string }>("workflows.saveAuthored", body),
  // [WS-RPC] workflows.delete
  deleteWorkflow: (name: string) =>
    requestRpc<{ ok: boolean }>("workflows.delete", { name }),
  setWorkflowPhases: (
    name: string,
    phases: unknown[],
    syncTs = true,
    renames?: Record<string, string>,
  ) =>
    request<{
      ok: boolean;
      ts: { added: string[]; orphans: string[]; modified: boolean; legacy_signature?: string[] } | null;
      ts_error?: string | null;
      renamed?: string[];
    }>(
      `/api/workflows/${name}/phases`,
      {
        method: "PUT",
        body: JSON.stringify({ phases, sync_ts: syncTs, renames }),
      },
    ),
  syncWorkflowTs: (name: string) =>
    request<{ added: string[]; orphans: string[]; modified: boolean; legacy_signature?: string[] }>(
      `/api/workflows/${name}/sync-ts`, { method: "POST" },
    ),
  pruneOrphans: (name: string, names: string[]) =>
    request<{ removed: string[] }>(`/api/workflows/${name}/prune-orphans`, {
      method: "POST", body: JSON.stringify({ names }),
    }),

  // Config
  // [WS-RPC] config.get
  getConfig: () => requestRpc<{ content: string }>("config.get"),
  // [WS-RPC] config.save
  saveConfig: (content: string) =>
    requestRpc<{ ok: boolean }>("config.save", { content }),
  // [WS-RPC] workflows.getSpec（P2 后 yaml_content 已删，spec_json 是唯一真相）
  getWorkflowSpec: (name: string) => requestRpc<{ spec: string }>("workflows.getSpec", { name }),
  // [WS-RPC] workflows.getTs
  getWorkflowTs: (name: string) => requestRpc<{ content: string }>("workflows.getTs", { name }),
  setWorkflowPhaseFn: (name: string, phase: string, code: string) =>
    request<{ ok: true; mode: "replaced" | "appended" }>(
      `/api/workflows/${name}/phase-fn/${phase}`,
      { method: "PUT", body: JSON.stringify({ code }) },
    ),
  /**
   * 试跑某 workflow 的 prompt。命名复用 agent 删除后：agent 字段是一个内联配置对象
   * （provider/model/system_prompt/...），省略则后端走 DEFAULT_AGENT 兜底。
   */
  dryRunPrompt: (
    workflowName: string,
    body: { agent?: InlineAgentConfig; prompt: string; timeout?: number },
  ) =>
    request<{
      text: string;
      durationMs: number;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; total_cost_usd?: number };
    }>(
      `/api/workflows/${workflowName}/dry-run`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // [WS-RPC] workflows.saveSpec（P2 后 yaml_content 已删，spec_json 是唯一真相）
  saveWorkflowSpec: (name: string, spec: string) =>
    requestRpc<{ ok: boolean }>("workflows.saveSpec", { name, spec }),
  // [WS-RPC] workflows.setMeta —— 改显示名/描述（name 是标识符不可改）
  setWorkflowMeta: (
    name: string,
    meta: {
      label?: string | null;
      description?: string | null;
      /** 声明层 requires.git：true（需要代码库）/ false（不需要）显式；null = 删键回退派生。二态。 */
      requiresGit?: boolean | null;
      // 注：sandbox.git（建 git 沙盒）从 requires.git 派生、delivers 从 phase 派生，均不再是 setMeta 输入。
    },
  ) => requestRpc<{ ok: boolean }>("workflows.setMeta", { name, ...meta }),
  reloadWorkflows: () =>
    request<{ ok: boolean; workflows: any[] }>("/api/reload", { method: "POST" }),

  // Providers
  // [WS-RPC] providers.list
  listProviders: () => requestRpc<ProviderItem[]>("providers.list"),
  // [WS-RPC] providers.save
  saveProviderConfig: (name: string, cfg: Record<string, unknown>) =>
    requestRpc<{ ok: boolean }>("providers.save", { name, ...cfg }),
  // [WS-RPC] providers.statusAll
  getProvidersStatus: () => requestRpc<ProviderStatus[]>("providers.statusAll"),
  // [WS-RPC] providers.status
  getProviderStatus: (name: string) => requestRpc<ProviderStatus>("providers.status", { name }),
  // [WS-RPC] providers.models
  getProviderModels: (name: string) =>
    requestRpc<ProviderModelsResult>("providers.models", { name }),
  // [WS-RPC] providers.listExtended — 含 API key 状态
  listProvidersExtended: () => requestRpc<ProviderExtendedInfo[]>("providers.listExtended"),
  // ── 生命周期 agent 配置（lifecycle.* RPC）──
  // [WS-RPC] lifecycle.list
  listLifecycleAgents: () => requestRpc<{ agents: LifecycleAgentInfo[] }>("lifecycle.list"),
  // [WS-RPC] lifecycle.setAgent（config=null 删段回退默认）
  setLifecycleAgent: (name: string, config: Partial<InlineAgentConfig> | null) =>
    requestRpc<{ ok: boolean }>("lifecycle.setAgent", { name, config }),
  // [WS-RPC] providers.setDefaultModel — 字段级写默认模型（官方 + compat），merge-safe
  setProviderDefaultModel: (name: string, model?: string) =>
    requestRpc<{ ok: boolean }>("providers.setDefaultModel", { name, model }),
  // ── provider 条目 CRUD（条目化重构 P1）──
  // [WS-RPC] providers.create
  createProvider: (input: {
    name: string;
    display_name?: string;
    type: "cli" | "api";
    subtype: string;
    cli_bin?: string | null;
    cli_login_cmd?: string | null;
    base_url?: string | null;
    env_key_name?: string | null;
    default_model?: string | null;
    origin?: "template" | "user";
  }) => requestRpc<{ provider: ProviderExtendedInfo }>("providers.create", input),
  // [WS-RPC] providers.update
  updateProvider: (
    id: string,
    patch: { display_name?: string; base_url?: string | null; env_key_name?: string | null; default_model?: string | null; enabled?: boolean },
  ) => requestRpc<{ provider: ProviderExtendedInfo }>("providers.update", { id, ...patch }),
  // [WS-RPC] providers.delete
  deleteProvider: (id: string, force?: boolean) =>
    requestRpc<{ ok: boolean }>("providers.delete", { id, force }),
  // [WS-RPC] providers.templates
  listProviderTemplates: () => requestRpc<ProviderTemplate[]>("providers.templates"),
  // [WS-RPC] providers.detectCli
  detectProviderCli: (id: string) =>
    requestRpc<{ status: "ok" | "missing" | "unknown"; version?: string; install_hint?: string; error?: string }>(
      "providers.detectCli", { id },
    ),

  // API Keys
  listApiKeys: () => requestRpc<ApiKeyInfo[]>("apiKeys.list"),
  setApiKey: (provider: string, key: string) =>
    requestRpc<{ ok: boolean }>("apiKeys.set", { provider, key }),
  deleteApiKey: (provider: string) =>
    requestRpc<{ ok: boolean }>("apiKeys.delete", { provider }),

  // Agents — 命名复用 agent 机制已删除（Phase 3）。
  // agent 配置现在内联挂在 phase 上；试跑见下方 dryRunAgent（收内联配置对象）。

  // Chat（独立对话页已于 2026-06-11 删除；后端 chat/sessions 设施保留给需求澄清使用）

  // [WS-RPC] agents.defaultAgent —— phase 省略 agent / 留空字段时兜底的 DEFAULT_AGENT（编辑器展示默认值）
  getDefaultAgent: () => requestRpc<InlineAgentConfig>("agents.defaultAgent"),

  // Defaults（用户偏好）
  // [WS-RPC] defaults.get
  getDefaults: () =>
    requestRpc<{
      timezone: string | null;
      resolved_timezone: string;
      system_timezone: string;
    }>("defaults.get"),
  // [WS-RPC] defaults.save
  saveDefaults: (body: { timezone?: string | null }) =>
    requestRpc<{ ok: true; timezone: string | null }>("defaults.save", body),

  // 调度器配置
  // [WS-RPC] scheduler.get
  getSchedulerConfig: () =>
    requestRpc<{
      max_concurrent_tasks: number | null;
      effective_max_concurrent_tasks: number;
    }>("scheduler.get"),
  // [WS-RPC] scheduler.save
  saveSchedulerConfig: (body: { max_concurrent_tasks?: number | null }) =>
    requestRpc<{
      ok: true;
      max_concurrent_tasks: number | null;
      effective_max_concurrent_tasks: number;
    }>("scheduler.save", body),

  // 网络访问设置
  getDaemonListen: () => request<DaemonListenInfo>("/api/daemon/listen"),
  saveDaemonListen: (body: { host?: string; port?: number }) =>
    request<{ ok: true; host?: string; port?: number; restart_required: boolean }>(
      "/api/daemon/listen",
      { method: "PUT", body: JSON.stringify(body) },
    ),
  // [WS-RPC] daemon.setHost — 写 config.json.daemon.host
  setDaemonHost: (host: string) =>
    requestRpc<{ ok: true; host: string; restart_required: true }>("daemon.setHost", { host }),
  // [WS-RPC] daemon.restart — 请求 supervisor 重启 daemon（exit code 75）
  restartDaemon: () =>
    requestRpc<{ ok: boolean; scheduled_in_ms: number }>("daemon.restart"),
  // [WS-RPC] daemon.revealToken — 已鉴权调用方查看明文 token
  revealApiToken: () =>
    requestRpc<{ token: string; is_set: boolean }>("daemon.revealToken"),
  rotateApiToken: () =>
    request<{ ok: true; token: string; state: DaemonListenInfo["token"] }>(
      "/api/daemon/token/rotate",
      { method: "POST" },
    ),
  deleteApiToken: () =>
    request<{ ok: true; state: DaemonListenInfo["token"] }>(
      "/api/daemon/token",
      { method: "DELETE" },
    ),

  // [WS-RPC] agents.dryRun（LLM 调用，5min 超时）
  // 命名复用 agent 删除后：传一个内联 agent 配置对象（provider/model/system_prompt/...），
  // 省略 agent 字段则后端走 DEFAULT_AGENT 兜底。additional_system 叠加到 system_prompt 之后。
  dryRunAgent: (
    agent: InlineAgentConfig | undefined,
    body: { prompt: string; additional_system?: string; model?: string; max_turns?: number },
  ) =>
    requestRpc<{
      ok: boolean;
      elapsed_ms: number;
      result: {
        text: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; total_cost_usd?: number };
      };
    }>(
      "agents.dryRun",
      { agent: mergeInlineAgent(agent, body), prompt: body.prompt, additional_system: body.additional_system },
      { timeoutMs: 300_000 },
    ),

  // Projects
  // [WS-RPC] projects.list — P3 第一批 PoC（RPC 直接返回数组，不再 wrap projects 字段）
  listProjects: () =>
    requestRpc<Project[]>("projects.list"),
  // [WS-RPC] projects.get
  getProject: (id: string) =>
    requestRpc<{ project: Project }>("projects.get", { id }).then((r) => r.project),
  // [WS-RPC] projects.create
  createProject: (body: { name: string; description?: string }) =>
    requestRpc<{ project: Project }>("projects.create", body).then((r) => r.project),
  // projects.createWithWorkspace（原子创建项目+代码库）现仅 CLI 在用；
  // Web 新建项目已简化为只填名称/描述，代码库在项目「代码库」分区单独关联
  // [WS-RPC] projects.update
  updateProject: (id: string, body: { name?: string; description?: string | null }) =>
    requestRpc<{ project: Project }>("projects.update", { id, ...body }).then((r) => r.project),
  // [WS-RPC] projects.delete
  deleteProject: (id: string) =>
    requestRpc<{ ok: true }>("projects.delete", { id }),
  // [WS-RPC] projects.workspaces
  listProjectWorkspaces: (projectId: string) =>
    requestRpc<{ workspaces: Workspace[] }>("projects.workspaces", { id: projectId }).then((r) => r.workspaces),
  // projects.addWorkspace 是远程化前的本地 path 模式老接口（alias+path 必填），Web 不再调用；
  // 新建代码库统一走 workspaces.create（见 createWorkspace，仅凭远程 URL 注册）
  // [WS-RPC] workspaces.delete —— 默认拒删 in-use workspace；force=true 才允许级联清空
  deleteWorkspace: (workspaceId: string, force = false) =>
    requestRpc<{ ok: true }>("workspaces.delete", { id: workspaceId, force }),
  // [WS-RPC] projects.requirements
  listProjectRequirements: (projectId: string) =>
    requestRpc<{ requirements: Requirement[] }>("projects.requirements", { id: projectId }).then((r) => r.requirements),

  // Workspaces CRUD —— 走 WS RPC，handler 返回裸数据，无 envelope
  // [WS-RPC] workspaces.list
  listWorkspaces: () =>
    requestRpc<Workspace[]>("workspaces.list"),
  // [WS-RPC] workspaces.get
  getWorkspace: (id: string) =>
    requestRpc<Workspace>("workspaces.get", { id }),
  // [WS-RPC] workspaces.create
  createWorkspace: (body: {
    alias: string;
    path?: string;
    remote_url?: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
    project_id?: string;
  }) =>
    requestRpc<Workspace>("workspaces.create", body),
  // [WS-RPC] requirements.setWorkspaces —— 澄清前确认代码库集合（开始澄清后冻结；failed 例外；无主/副之分）
  setRequirementWorkspaces: (id: string, workspaceIds: string[]) =>
    requestRpc<{ requirement: Requirement; workspace_ids: string[] }>("requirements.setWorkspaces", {
      id,
      workspace_ids: workspaceIds,
    }),
  // [WS-RPC] workspaces.detect —— 从本地路径探测 git 信息，用于创建表单自动填充
  detectWorkspace: (path: string) =>
    requestRpc<{
      is_git: boolean;
      default_branch: string | null;
      remote_url: string | null;
      github_owner: string | null;
      github_repo: string | null;
    }>("workspaces.detect", { path }),
  // [WS-RPC] workspaces.update
  updateWorkspace: (id: string, body: Partial<{
    alias: string;
    remote_url: string | null;
    default_branch: string;
    github_owner: string | null;
    github_repo: string | null;
  }>) =>
    requestRpc<Workspace>("workspaces.update", { id, ...body }),
  // [WS-RPC] workspaces.healthcheck
  healthcheckWorkspace: (id: string) =>
    requestRpc<WorkspaceHealthResult>("workspaces.healthcheck", { id }),

  // Submodules（仅查询；自动发现写在 healthcheck 里）
  // [WS-RPC] workspaces.listSubmodules
  listSubmodules: (parentId: string) =>
    requestRpc<{ submodules: Workspace[] }>("workspaces.listSubmodules", { id: parentId }).then((r) => r.submodules),
  // [WS-RPC] workspaces.rediscoverSubmodules
  rediscoverSubmodules: (parentId: string) =>
    requestRpc<RediscoverSubmodulesResult>("workspaces.rediscoverSubmodules", { id: parentId }),

  // 文件系统浏览
  browseFs: (path?: string, showHidden = false) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (showHidden) params.set("show_hidden", "1");
    const qs = params.toString();
    return request<FsListResult>(`/api/fs/list${qs ? "?" + qs : ""}`);
  },

  // 首跑配置 setup
  // [WS-RPC] setup.status
  setupStatus: () => requestRpc<DoctorReportWithDismiss>("setup.status"),

  // [WS-RPC] setup.saveProviders
  setupProviders: (providers: Record<string, Record<string, unknown>>) =>
    requestRpc<{ report: DoctorReportWithDismiss }>("setup.saveProviders", { providers }),

  // setup.saveAgents 已移除（Phase 3：命名复用 agent 机制删除；首跑向导不再单独配 agent）。

  // [WS-RPC] setup.saveWorkspaces
  setupWorkspace: (payload: { name: string; remote_url: string; project_id?: string }) =>
    requestRpc<{ workspace: { id: string; alias: string; remote_url: string | null; project_id: string } }>(
      "setup.saveWorkspaces",
      payload,
    ),

  // [WS-RPC] setup.dismiss
  setupDismiss: () =>
    requestRpc<{ ok: boolean }>("setup.dismiss"),

  // [WS-RPC] requirements.extract（LLM 长任务，5min 超时）
  extractRequirement: (input: { raw_text: string; project_id: string; workspace_id?: string | null }) =>
    requestRpc<{ title: string; spec_md: string }>("requirements.extract", input, { timeoutMs: 300_000 }),

  // Requirements
  // [WS-RPC] requirements.list
  listRequirements: (filters?: { workspace_id?: string; project_id?: string; status?: string }) =>
    requestRpc<{ requirements: Requirement[] }>("requirements.list", filters ?? {})
      .then((r) => r.requirements),

  // [WS-RPC] requirements.get （返回 comments，UI 沿用 feedbacks/questions 视图，由 adapter 拆分）
  getRequirement: async (id: string) => {
    const res = await requestRpc<{ requirement: Requirement; comments: Comment[] }>("requirements.get", { id });
    return {
      requirement: res.requirement,
      comments: res.comments,
      feedbacks: commentsToFeedbacks(res.comments),
    };
  },

  // [WS-RPC] requirements.create
  createRequirement: (body: {
    project_id?: string;
    workspace_id?: string | null;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
    source?: string | null;
    external_ref?: string | null;
    callback_url?: string | null;
    callback_secret?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.create", body).then((r) => r.requirement),

  // [WS-RPC] requirements.update
  updateRequirement: (id: string, body: {
    title?: string;
    spec_md?: string;
    workspace_id?: string | null;
    chat_session_id?: string | null;
    clarifier_provider?: string | null;
    clarifier_model?: string | null;
    workflow?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.update", { id, ...body }).then((r) => r.requirement),

  // [WS-RPC] requirements.delete —— 删一件工作：需求 + 其名下全部任务（返回连带删的任务数）
  deleteRequirement: (id: string) =>
    requestRpc<{ ok: true; deletedTasks: number }>("requirements.delete", { id }),

  // [WS-RPC] requirements.transition
  transitionRequirement: (id: string, to: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.transition", { id, to }).then((r) => r.requirement),

  // [WS-RPC] requirements.enqueue
  enqueueRequirement: (id: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.enqueue", { id }).then((r) => r.requirement),

  // [WS-RPC] requirements.injectFeedback
  /** 注入反馈：comments.add(kind=feedback) 的语法糖；在 awaiting_review 自动触发 fix_revision */
  injectFeedback: (id: string, body: string, source: "manual" | "github_review" = "manual") =>
    requestRpc<{ comment: Comment }>("comments.add", {
      requirementId: id,
      kind: "feedback",
      from_role: source === "github_review" ? "github" : "user",
      body,
    }).then((r) => r.comment),

  // [WS-RPC] requirements.cancel
  cancelRequirement: (id: string, reason?: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.cancel", { id, ...(reason ? { reason } : {}) }).then((r) => r.requirement),

  // [WS-RPC] requirements.statusLogs
  listRequirementStatusLogs: (id: string) =>
    requestRpc<{ logs: RequirementStatusLog[] }>("requirements.statusLogs", { id }).then((r) => r.logs),

  // [WS-RPC] tasks.diffFiles
  getTaskDiffFiles: (id: string) =>
    requestRpc<{ files: TaskFileDiff[] }>("tasks.diffFiles", { id }).then((r) => r.files),

  // [WS-RPC] requirements.subPrs
  listRequirementSubPrs: (id: string) =>
    requestRpc<{ sub_prs: RequirementSubPr[] }>("requirements.subPrs", { id }).then((r) => r.sub_prs),

  // [WS-RPC] requirements.deliveries —— artifacts 交付轮次记录（验收卡用）
  listRequirementDeliveries: (id: string) =>
    requestRpc<{ deliveries: RequirementDelivery[] }>("requirements.deliveries", { id }).then((r) => r.deliveries),

  // [WS-RPC] requirements.listDeliveryFiles —— 某验收轮文件列表（缺省最新轮）
  listDeliveryFiles: (id: string, round?: number) =>
    requestRpc<{ round: number; files: DeliveryFileEntry[] }>(
      "requirements.listDeliveryFiles",
      round !== undefined ? { id, round } : { id },
    ),

  /** 交付物单文件下载 URL（HTTP 二进制通道，强制 attachment） */
  deliveryDownloadUrl: (id: string, round: number, path: string) =>
    `/api/requirements/${encodeURIComponent(id)}/deliveries/download?round=${round}&path=${encodeURIComponent(path)}`,

  /** 交付物单文件预览 URL（安全内联：图片 <img>/html CSP sandbox；其它 415） */
  deliveryPreviewUrl: (id: string, round: number, path: string) =>
    `/api/requirements/${encodeURIComponent(id)}/deliveries/preview?round=${round}&path=${encodeURIComponent(path)}`,

  // [WS-RPC] requirements.specRevisions
  listSpecRevisions: (id: string) =>
    requestRpc<{ revisions: SpecRevision[] }>("requirements.specRevisions", { id }).then((r) => r.revisions),

  // [WS-RPC] requirements.clarifierRound
  getClarifierRound: (id: string) =>
    requestRpc<{ round: ClarifierRoundState | null }>("requirements.clarifierRound", { id })
      .then((r) => r.round),

  // requirements.fixRound 已移除（v2 R3：fix = 标准 run，进度看 requirement.task_id 指向的任务）

  // Comments（统一评论线程：question / feedback / handoff）
  // [WS-RPC] comments.list
  listComments: (reqId: string, filter?: { kind?: "question" | "feedback" | "handoff"; status?: "open" | "resolved" }) =>
    requestRpc<{ comments: Comment[] }>("comments.list", { requirementId: reqId, ...(filter ?? {}) })
      .then((r) => r.comments),
  /** 兼容 web 旧用法：返回 Question[]（顶层 question + replies 嵌套），由 Comment[] 适配 */
  listQuestions: (reqId: string): Promise<Question[]> =>
    requestRpc<{ comments: Comment[] }>("comments.list", { requirementId: reqId, kind: "question" })
      .then((r) => commentsToQuestions(r.comments)),
  // [WS-RPC] comments.add（用于在某 question 下追加 reply）
  addQuestionReply: (reqId: string, qid: string, body: { author_role: "agent" | "user"; text: string }) =>
    requestRpc<{ comment: Comment }>("comments.add", {
      requirementId: reqId,
      kind: "question",
      parent_id: qid,
      from_role: body.author_role,
      body: body.text,
    }).then((r) => r.comment),
  // [WS-RPC] comments.resolve
  resolveQuestion: (_reqId: string, qid: string) =>
    requestRpc<{ ok: true }>("comments.resolve", { id: qid }),

  // 附件 — HTTP 多方法（upload 需 multipart，走原生 fetch 不走 WS-RPC）
  listAttachments: (reqId: string) =>
    request<{ attachments: Attachment[] }>(`/api/requirements/${reqId}/attachments`)
      .then((r) => r.attachments),

  uploadAttachments: async (reqId: string, files: File[]): Promise<Attachment[]> => {
    const formData = new FormData();
    for (const f of files) formData.append("files", f);
    let res: Response;
    try {
      res = await fetch(`/api/requirements/${reqId}/attachments`, {
        method: "POST",
        body: formData,
        headers: { ...authHeaders() },
        // 注意：不设 Content-Type，让浏览器自动加 boundary
      });
    } catch (e: unknown) {
      throw new Error(`上传请求失败：${(e as Error)?.message ?? String(e)}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as any).error ?? `HTTP ${res.status}`);
    }
    return ((await res.json()) as { attachments: Attachment[] }).attachments;
  },

  deleteAttachment: (reqId: string, attId: string) =>
    request<{ ok: boolean }>(`/api/requirements/${reqId}/attachments/${attId}`, {
      method: "DELETE",
    }),

  // Notifications（事件型通知流）
  // [WS-RPC] notifications.list
  listNotifications: (opts: {
    limit?: number;
    before_id?: number;
    unread_only?: boolean;
    include_dismissed?: boolean;
  } = {}) =>
    requestRpc<{ items: Notification[]; next_before_id: number | null }>(
      "notifications.list",
      opts,
    ),
  // [WS-RPC] notifications.unreadCount
  notificationUnreadCount: () =>
    requestRpc<{ count: number }>("notifications.unreadCount"),
  // [WS-RPC] notifications.markRead
  markNotificationsRead: (ids: number[]) =>
    requestRpc<{ updated: number }>("notifications.markRead", { ids }),
  // [WS-RPC] notifications.markAllRead
  markAllNotificationsRead: () =>
    requestRpc<{ updated: number }>("notifications.markAllRead"),
  // [WS-RPC] notifications.markReadByRelated —— 点进任务/需求详情页自动消化相关通知
  markNotificationsReadByRelated: (relatedType: "task" | "requirement", relatedId: string) =>
    requestRpc<{ updated: number; ids: number[] }>("notifications.markReadByRelated", {
      related_type: relatedType,
      related_id: relatedId,
    }),
  // [WS-RPC] notifications.dismiss
  dismissNotification: (id: number) =>
    requestRpc<{ ok: true }>("notifications.dismiss", { id }),
  // [WS-RPC] providers.health（轻量内存态，通知面板 banner 用）
  providersHealth: () =>
    requestRpc<Array<{ provider: string; healthy: boolean; last_reason?: string }>>(
      "providers.health",
    ),

  // [WS-RPC] providers.usableCount（无可用供应商横幅用）
  providersUsableCount: () =>
    requestRpc<{ usable: number; total: number }>("providers.usableCount"),
};

export interface Attachment {
  id: string;
  requirement_id: string;
  original_name: string;
  mime_type: string;
  file_path: string;
  file_size: number;
  category: "image" | "text" | "pdf" | "office";
  extracted_text: string | null;
  created_at: number;
}

export interface WorkflowTemplate {
  name: string;
  label?: string;
  description: string;
  phase_count: number;
  agent_count: number;
}


export interface AuthoredWorkflow {
  name: string;
  description: string;
  /** 结构化 spec 的 JSON pretty 文本（与 DB 列 spec_json 语义一致） */
  spec_json: string;
  warnings: string[];
}

export interface TaskPhaseEvent {
  id: number;
  task_id: string;
  phase: string;
  status: "running" | "done" | "awaiting" | "failed";
  started_at: number;
  ended_at: number | null;
}

export interface RequirementStatusLog {
  id: number;
  requirement_id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  created_at: number;
}

export interface TaskFileDiff {
  file: string;
  insertions: number;
  deletions: number;
  patch: string;
}

export interface TaskOutcome {
  task_id: string;
  status: "done" | "failed" | "cancelled";
  pr_url: string | null;
  pr_number: number | null;
  diff_stat: { files: number; insertions: number; deletions: number } | null;
  total_duration_ms: number;
  top_phases: Array<{ phase: string; duration_ms: number }>;
  sandbox_path: string | null;
  /** 进终态的原因（task_logs 最后一条进 failed/cancelled 的 note）；done 为 null */
  terminal_reason: string | null;
  /** 最近一次评审驳回原话（markdown）；无则 null */
  rejection_reason: string | null;
  /** 各评审阶段累计驳回次数；无则 null */
  rejection_counts: Record<string, number> | null;
}

export interface DoctorCheck {
  id: string;
  category: "config" | "provider" | "agent" | "project" | "workspace";
  status: "ok" | "warning" | "error" | "skipped";
  title: string;
  detail?: string;
  fix?: { cli?: string; url?: string; auto?: string };
}

export interface DoctorReportWithDismiss {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: DoctorCheck[];
  durationMs: number;
  generatedAt: string;
  setupDismissed?: boolean;
}

export interface ProviderItem {
  name: string;
  default_model?: string;
  enabled?: boolean;
  agent_count?: number;
}

export interface ProviderStatus {
  name: string;
  cli_installed: boolean;
  cli_path?: string;
  cli_version?: string;
  error?: string;
  install_hint?: string;
}

export interface ProviderModelsResult {
  name: string;
  models: string[];
  source: "api" | "catalog";
  error?: string;
}

export interface AgentCallSummary {
  seq: number;
  ts: string;
  phase?: string;
  agent: string;
  provider?: string;
  model?: string;
  elapsed_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; total_cost_usd?: number };
  error?: string;
  prompt_preview: string;
  result_preview: string;
}

export interface AgentCallRecord extends AgentCallSummary {
  prompt: string;
  system_prompt?: string;
  additional_system?: string;
  result_text?: string;
}

export interface SandboxEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface WorkspaceHealthResult {
  healthy: boolean;
  issues: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  /** 历史字段，新 workspace 可能为 null */
  path: string | null;
  /** 远程仓库 URL（主字段） */
  remote_url: string | null;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
  /** 列表接口运行时计算：remote_url 是否已填写 */
  path_exists?: boolean;
}

export interface Comment {
  id: string;
  requirement_id: string;
  parent_id: string | null;
  kind: "question" | "feedback" | "handoff";
  from_role: "agent" | "user" | "github";
  body: string;
  suggestions: string[] | null;
  status: "open" | "resolved";
  github_review_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

// ── Legacy 视图类型（UI 沿用，由 Comment 适配） ──
// Phase 2 数据层已合并到 requirement_comments；保留这些类型让 UI 不必大改。
// 等 UI 全面用 Comment 直接渲染时再删（spec follow-up）。

export interface QuestionReply {
  id: string;
  question_id: string;
  author_role: "agent" | "user";
  text: string;
  created_at: number;
}

export interface Question {
  id: string;
  requirement_id: string;
  agent_text: string;
  suggestions: string[];
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
  replies?: QuestionReply[];
}

export interface Requirement {
  id: string;
  /** 冗余缓存 = 集合第一个（主库语义已废除）；真相在 workspace_ids */
  workspace_id: string | null;
  /** 需求关联的代码库集合（requirement_workspaces；RPC 层附带） */
  workspace_ids?: string[];
  project_id: string;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  /** PR-A 新加：当前等用户回答的 question id（clarifying 期 AI 决定下一题时 set） */
  active_question_id: string | null;
  /** clarifier 失败时 set 错误原因，成功时 clear；持久化到 DB，跨重启/navigation 可见 */
  clarifier_error: string | null;
  clarifier_provider: string | null;
  clarifier_model: string | null;
  /** 调度器起 task 失败（回滚 ready）时记录的原因；成功起 task 时清空 */
  schedule_error: string | null;
  /** 进入 cancelled / failed 终态时的人话短摘要；failed 重试时清空 */
  status_reason: string | null;
  /** status_reason 来源：user（手动）/ task（任务级联）/ system */
  status_reason_source: "user" | "task" | "system" | null;
  /** 转入终态时的 from 状态（步骤条据此把 ✗ 画在死亡步）；failed 重试时清空 */
  status_before_terminal: string | null;
  /** 执行用的工作流名；null = 未显式选择（调度回退默认 dev）。审批后随内容冻结 */
  workflow: string | null;
  /** 输入形态确认（迁移 045）：null=未确认 / 'git'=基于代码库 / 'none'=确认无库 */
  input_mode?: string | null;
  /** 需求来源标识（如 'reqgenie'），B 模式深链触发时写入（迁移 050）。 */
  source?: string | null;
  /** 外部系统需求 id（如 reqgenie requirement uuid），用于回链（迁移 050）。 */
  external_ref?: string | null;
  /** 状态变化回传 webhook URL（迁移 050）。 */
  callback_url?: string | null;
  /** 回传 webhook HMAC secret（迁移 050）。 */
  callback_secret?: string | null;
  created_at: number;
  updated_at: number;
}

/** 需求交付物轮次记录（requirement_deliveries，artifacts 验收用） */
export interface RequirementDelivery {
  id: string;
  requirement_id: string;
  task_id: string | null;
  round: number;
  /** 相对需求运行时目录的落点（deliveries/round-<N>） */
  path: string;
  summary: string | null;
  created_at: number;
}

export interface DeliveryFileEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface RequirementFeedback {
  id: number;
  requirement_id: string;
  source: "github_review" | "manual";
  /** 原始评论角色（user/github/agent）—— agent = 修复执行器的总结 */
  from_role?: string;
  /** 子类：residue=历史失败 run 评审遗留（非本 PR）/ fix=Agent 修复总结 / review=用户/GitHub 评审意见 */
  subtype?: FeedbackSubtype;
  body: string;
  github_review_id: string | null;
  created_at: number;
}

export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_workspace_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface SpecRevision {
  id: number;
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
  created_at: number;
}

export interface ClarifierRoundState {
  req_id: string;
  started_at: number;
  phase: "preparing" | "cloning-repo" | "calling-llm" | "parsing" | "writing" | "done" | "aborted" | "errored";
  attempt: 0 | 1;
  prompt: string | null;
  last_parse_error: string | null;
}

export interface RediscoverSubmodulesResult {
  added: Array<{ id: string; alias: string; submodule_path: string | null }>;
  existing_count: number;
  warnings: string[];
}

export interface FsListResult {
  current_path: string;
  parent_path: string | null;
  entries: { name: string; is_dir: boolean }[];
  /** 后端截断到 2000 entries 时为 true（系统大目录保护）；老 daemon 不返回此字段 */
  truncated?: boolean;
}

// ── API Key 管理类型 ──

export interface ApiKeyInfo {
  provider: string;
  key_hint: string;
  updated_at: string;
  source: "db" | "env";
}

export interface ProviderExtendedInfo {
  // provider 条目字段（条目化重构）
  id?: string;
  name: string;
  display_name: string;
  type?: "cli" | "api";
  subtype?: string;
  enabled?: boolean;
  origin?: "seed" | "template" | "user";
  cli_status?: "ok" | "missing" | "unknown" | null;
  cli_version?: string | null;
  env_key_name?: string;
  // 旧 shape 兼容
  supports_cli: boolean;
  supports_api: boolean;
  api_only: boolean;
  default_mode: "cli" | "api";
  default_model?: string;
  has_api_key: boolean;
  key_hint?: string;
  key_source?: "db" | "env";
  base_url?: string;
}

export interface ProviderTemplate {
  name: string;
  display_name: string;
  type: "api";
  subtype: "openai-compat";
  base_url: string;
  default_model: string;
  env_key_name: string;
}
