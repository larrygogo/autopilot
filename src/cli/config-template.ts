/**
 * 生成首跑 config.json 模板。
 *
 * autopilot 的默认体验是「零配置」：
 *   - provider 自动适配：装了 claude / codex / gemini CLI 就自动用（见 provider-defaults.ts）
 *   - agent 内置默认：coder / reviewer / clarifier 直接可用（见 agent-defaults.ts）
 *
 * 此模板输出最小合法 JSON 对象，等效空配置（所有字段均走内置默认值）。
 * 用 `bun run dev config doctor` 检查当前状态。
 *
 * 高级覆盖示例（取消注释并按需填写）：
 *   providers.anthropic.default_model  — 指定非默认 model（如 claude-opus-4-8）
 *   providers.anthropic.base_url       — 自建代理时填入
 *   lifecycle.clarify.model            — 给澄清阶段单独换 model
 *   scheduler.max_concurrent_tasks     — 最大并发任务数（默认 1）
 *
 * 详细说明见 docs/quickstart.md。
 */
export function buildConfigTemplate(): string {
  return JSON.stringify({}, null, 2) + "\n";
}
