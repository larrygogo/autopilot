/**
 * 统一工具能力词汇表 + 各后端映射（细粒度工具授权）。
 *
 * 工作流用这些规范能力名声明「某 phase 的 agent 能碰哪些工具」（agent 块的 tools: [...]）。
 * 框架只造骨：这里只定义词汇表 + 映射；给哪个 phase 授哪些能力是用户填的肉。
 *
 * 第一刀只实现 API 模式映射（expandToApiTools）。CLI（claude --allowed-tools /
 * codex·gemini 粗档回退）留第二刀。
 */

/** 规范能力名。零业务语义，跨后端稳定。 */
export const CAPABILITIES = [
  "read",
  "list",
  "search",
  "write",
  "edit",
  "delete",
  "bash",
  "web_fetch",
  "web_search",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 控制通道工具：引擎↔agent 的协议通道，**永不受 tools 授权约束**。
 * 否则 phase 配 tools:[read] 会把 task_complete 滤掉 → agent loop 永不终止。
 */
export const CONTROL_CHANNEL_API_TOOLS = ["task_complete"] as const;

/**
 * 能力 → API 模式内部工具名。
 * web_search 在 API 模式无对应工具（CLI-only），映射空集 = degrade-silent。
 */
const CAPABILITY_TO_API_TOOLS: Record<Capability, readonly string[]> = {
  read: ["read_file"],
  list: ["list_directory"],
  search: ["search_files"],
  write: ["write_file", "create_directory"],
  edit: ["write_file"],
  delete: ["delete_file", "move_file"],
  bash: ["bash"],
  web_fetch: ["fetch_url"],
  web_search: [],
};

export function isKnownCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/**
 * 把能力白名单展开成「允许的 API 工具名集合」，**永远含控制通道工具**。
 * 未知能力名静默忽略（调用方负责 lint/warn）。
 */
export function expandToApiTools(caps: string[]): Set<string> {
  const out = new Set<string>(CONTROL_CHANNEL_API_TOOLS);
  for (const c of caps) {
    if (isKnownCapability(c)) {
      for (const t of CAPABILITY_TO_API_TOOLS[c]) out.add(t);
    }
  }
  return out;
}

/** 返回 caps 里不认识的能力名（供 lint / warn）。 */
export function unknownCapabilities(caps: string[]): string[] {
  return caps.filter((c) => !isKnownCapability(c));
}

// ──────────────────────────────────────────────
// CLI claude 映射（第二刀）
// ──────────────────────────────────────────────

/**
 * claude CLI 内建工具中，本框架据能力授权做门禁的集合。
 * 不在此集的工具（TodoWrite / Task / mcp__autopilot__* 等）不受 tools 授权影响。
 */
export const CLAUDE_GATEABLE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "NotebookEdit",
] as const;

/** 能力 → claude CLI 应保留（放行）的内建工具名。 */
const CAPABILITY_TO_CLAUDE_TOOLS: Record<Capability, readonly string[]> = {
  read: ["Read"],
  list: ["Glob"],
  search: ["Grep", "Glob"],
  write: ["Write", "NotebookEdit"],
  edit: ["Edit", "NotebookEdit"],
  delete: [], // claude 无独立删除工具（经 Bash rm/mv）；授 delete 不解锁任何内建工具，需另配 bash
  bash: ["Bash"],
  web_fetch: ["WebFetch"],
  web_search: ["WebSearch"],
};

/**
 * 给定能力白名单，返回 claude CLI 应 **disallow** 的内建工具（= 门禁集 − 已授权保留的）。
 *
 * 为什么是 disallow 补集而非 allow：claude 的 `--allowed-tools` 是「免确认放行」而非
 * 「只留这些」，内建工具不在 allow 列表里照样可用——真限制必须靠 `--disallowed-tools` 拒掉
 * 没授权的那些。控制/MCP 工具与不在门禁集的工具不受影响。
 */
export function claudeDisallowFor(caps: string[]): string[] {
  const keep = new Set<string>();
  for (const c of caps) {
    if (isKnownCapability(c)) {
      for (const t of CAPABILITY_TO_CLAUDE_TOOLS[c]) keep.add(t);
    }
  }
  return CLAUDE_GATEABLE_TOOLS.filter((t) => !keep.has(t));
}
