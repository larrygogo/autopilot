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
