/**
 * 生成首跑 config.yaml 模板。
 *
 * autopilot 的默认体验是「零配置」：
 *   - provider 自动适配：装了 claude / codex / gemini CLI 就自动用（见 provider-defaults.ts）
 *   - agent 内置默认：coder / reviewer / clarifier 直接可用（见 agent-defaults.ts）
 *
 * 这个模板写出来的 yaml 几乎全是注释——只在用户想"高级 override"时取消注释、改字段。
 */
export function buildConfigTemplate(): string {
  return `# autopilot 配置文件（零配置）
# 大部分场景无需配置——provider 自动适配、agent 用内置默认。
# 用 \`bun run dev config doctor\` 检查当前状态。
#
# 仅在以下场景需要写：
#   1. 想用非默认 model（如 claude-opus 而非 sonnet）
#   2. 自建代理 base_url
#   3. 给某个 agent 单独换 model 或自定义 system_prompt
#
# providers:
#   anthropic:
#     default_model: claude-opus-4-8   # 默认是 claude-sonnet-4-6
#     # base_url: https://my-proxy.example.com  # 自建代理时取消注释
#
# agents:
#   coder:
#     model: claude-opus-4-8           # 给 coder 单独换更强模型
#     # system_prompt: |               # 覆盖内置 prompt
#     #   你是…
`;
}
