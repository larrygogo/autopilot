/**
 * 生成首跑 config.yaml 模板。
 * - anthropic 启用并填好 default_model（最小可跑）
 * - openai / google 保留为注释样例
 * - agents.coder 默认启用，避免空 agent 触发 doctor C6
 */
export function buildConfigTemplate(): string {
  return `# autopilot 配置文件。
# 用 \`bun run dev config doctor\` 检查当前状态。
# providers / agents 是最少需要填的两项。

providers:
  anthropic:
    default_model: claude-sonnet-4-6
    enabled: true

  # openai:
  #   default_model: gpt-5
  #   enabled: true
  #
  # google:
  #   default_model: gemini-2.5-pro
  #   enabled: true

agents:
  coder:
    provider: anthropic
    model: claude-sonnet-4-6
    max_turns: 10
    permission_mode: auto
`;
}
