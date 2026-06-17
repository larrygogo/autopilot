/**
 * Phase 内联 agent 配置（spec：移除命名复用 agent）。
 *
 * 工作流不再引用命名 agent，而是在 phase 上就地挂一个匿名配置对象：
 *   phases:
 *     - name: design
 *       agent: { provider: anthropic, model: claude-opus-4-8, system_prompt: ... }
 *
 * 整段 `agent:` 可省略——省略时走 DEFAULT_AGENT 兜底。
 * 字段语义与 AgentConfig 同构（去掉 name/extends 这类「命名复用」专属字段）。
 */
export interface InlineAgentConfig {
  label?: string;
  provider?: string;
  model?: string;
  /** 接入方式：cli 或 api。不填则继承 provider 级或按默认规则 */
  mode?: "cli" | "api";
  max_turns?: number;
  permission_mode?: string;
  /**
   * 工具能力白名单（细粒度授权，规范能力名见 tool-capabilities.ts）。
   * 缺省 = 全集（现状）；[] = 仅控制通道。与 permission_mode 正交（前者管"给哪些"，后者管"防护强度"）。
   * 第一刀仅 API agent 生效；CLI agent 第二刀。
   */
  tools?: string[];
  system_prompt?: string;
  [key: string]: unknown;
}

/**
 * 单一无名默认 agent——phase 不配 `agent:` 时的兜底。
 *
 * 取代旧的「命名 AGENT_DEFAULTS + 三层合并」：现在没有"按名取用"，
 * 只有「phase 内联覆盖 DEFAULT_AGENT」两层。model 缺失时再走
 * providers.<provider>.default_model（见 agentForPhase）。
 *
 * ⚠ provider / model 这里的值是「最终字面量兜底」，**不是系统默认 provider**：phase 没写
 * provider 时，agentForPhase 走 resolveDefaultProvider()（按用户实际配置派生），不读这里的
 * provider；model 同理走解析到的 provider 的 default_model。这里的 anthropic/claude-sonnet 仅在
 * 解析链全失败（无任何 provider 条目）时才会真正生效。
 */
export const DEFAULT_AGENT: InlineAgentConfig & { provider: string } = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  // ⚠ max_turns 仅 API 模式（ApiAgentLoop）强制；CLI provider（anthropic/google 官方）忽略它
  //（claude CLI 无对应 flag）。10 对「读完仓库再综合方案 / 改多文件」的 agentic API 阶段过低
  // ——读仓库就耗尽预算、末轮返回探索叙述当结论。提到对 agentic 安全的 30（仅是上限，提前收尾
  // 的 agent 不受影响；省略 agent: 走默认的 API-mode 阶段直接受益）。
  max_turns: 30,
  permission_mode: "auto",
  system_prompt:
    "你是通用编码助手。读上下文 → 提出方案 → 实施 → 自查。" +
    "代码注释和 commit message 用中文，代码本身用英文；遵循项目已有风格。",
};
