import { Card } from "@/components/ui/card";
import { useProviderHealth, type ProviderHealthState } from "@/hooks/useProviderHealth";

const PROVIDER_DISPLAY: Record<string, { label: string; loginHint: string }> = {
  anthropic: { label: "Anthropic", loginHint: "claude login" },
  openai:    { label: "OpenAI",    loginHint: "codex login" },
  google:    { label: "Google",    loginHint: "gemini auth login" },
};

const KNOWN_PROVIDERS = ["anthropic", "openai", "google"] as const;

interface StatusInfo {
  icon: string;
  color: string;
  label: string;
  hint?: string;
}

function summarize(state: ProviderHealthState | undefined): StatusInfo {
  if (!state || state.cli_status === undefined) {
    return { icon: "○", color: "text-muted-foreground", label: "未探测" };
  }
  if (state.cli_status === "missing") {
    return {
      icon: "✗",
      color: "text-destructive",
      label: "CLI 未安装",
      hint: state.cli_install_hint,
    };
  }
  if (!state.healthy) {
    return {
      icon: "⚠",
      color: "text-warning",
      label: "调用失败",
      hint: state.last_reason,
    };
  }
  return {
    icon: "✓",
    color: "text-success",
    label: state.cli_version ? `CLI ${state.cli_version}` : "可用",
  };
}

export function ProviderHealthCard() {
  const { states, connected } = useProviderHealth();
  const byName = new Map(states.map((s) => [s.provider, s]));

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">提供商健康</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          autopilot 启动时主动探测各 CLI；运行中每 5 分钟刷新；调用失败时自动标红
          {connected ? "" : "（WS 未连接，状态可能延迟）"}
        </p>
      </div>
      <ul className="divide-y divide-foreground/10 font-mono text-xs">
        {KNOWN_PROVIDERS.map((name) => {
          const state = byName.get(name);
          const info = summarize(state);
          const display = PROVIDER_DISPLAY[name]!;
          return (
            <li key={name} className="flex items-start gap-3 py-2">
              <span className={`w-4 shrink-0 ${info.color}`}>{info.icon}</span>
              <span className="w-24 shrink-0 font-bold">{display.label}</span>
              <div className="flex-1">
                <div className={info.color}>{info.label}</div>
                {info.hint && (
                  <div className="mt-0.5 text-muted-foreground">
                    {info.hint}
                  </div>
                )}
                {state && state.cli_status === "ok" && !state.healthy && (
                  <div className="mt-0.5 text-muted-foreground">
                    凭证可能失效，重新登录：
                    <code className="ml-1 bg-muted/40 px-1.5 py-0.5">{display.loginHint}</code>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
