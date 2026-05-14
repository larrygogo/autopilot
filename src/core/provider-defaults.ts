/**
 * Provider 框架级默认值。
 * - CLI 名：用于 spawn 探测（`<cli> --version`）和 install/login 提示
 * - default_model：用户 yaml 未写 providers 段或未 override 时的兜底 model
 * - install_hint / login_hint：探测失败时供 UI 展示
 *
 * 模型升级（如 claude-sonnet-5 发布）只需改这一个常量。
 */

export const PROVIDER_DEFAULTS = {
  anthropic: {
    cli: "claude",
    default_model: "claude-sonnet-4-6",
    install_hint: "请安装 Claude Code CLI（npm i -g @anthropic-ai/claude-code）",
    login_hint: "claude login",
  },
  openai: {
    cli: "codex",
    default_model: "gpt-5",
    install_hint: "npm i -g @openai/codex",
    login_hint: "codex login",
  },
  google: {
    cli: "gemini",
    default_model: "gemini-2.5-pro",
    install_hint: "npm i -g @google/gemini-cli",
    login_hint: "gemini auth login",
  },
} as const;

export type ProviderDefaultsName = keyof typeof PROVIDER_DEFAULTS;

export const PROVIDER_NAMES_LIST: ProviderDefaultsName[] = ["anthropic", "openai", "google"];
