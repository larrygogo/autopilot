import React, { useEffect, useState } from "react";
import { api, type ProviderItem } from "../hooks/useApi";

type Toast = { type: "success" | "error"; message: string } | null;

const PROVIDER_META: Record<string, { label: string; defaultModel: string; envHint: string }> = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-6", envHint: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI (Codex)", defaultModel: "o4-mini", envHint: "OPENAI_API_KEY" },
  google: { label: "Google (Gemini)", defaultModel: "gemini-2.5-pro", envHint: "GEMINI_API_KEY" },
};

export function Providers() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const refresh = () => {
    setLoading(true);
    api.listProviders().then(setProviders).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const updateField = (name: string, field: keyof ProviderItem, value: string | boolean | undefined) => {
    setProviders((prev) =>
      prev.map((p) => (p.name === name ? { ...p, [field]: value } : p))
    );
  };

  const save = async (p: ProviderItem) => {
    setSaving(p.name);
    try {
      const { name, ...cfg } = p;
      await api.saveProviderConfig(name, cfg);
      showToast("success", `${name} 配置已保存`);
    } catch (e: any) {
      showToast("error", e.message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  return (
    <div className="container">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}

      <div className="page-hdr">
        <h2>Providers</h2>
        <span>LLM 提供商全局默认</span>
      </div>

      <div className="provider-list">
        {providers.map((p) => {
          const meta = PROVIDER_META[p.name] ?? { label: p.name, defaultModel: "", envHint: "" };
          return (
            <div key={p.name} className="card provider-card">
              <div className="card-header">
                <h3>{meta.label}</h3>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={p.enabled !== false}
                    onChange={(e) => updateField(p.name, "enabled", e.target.checked)}
                  />
                  <span>{p.enabled !== false ? "启用" : "禁用"}</span>
                </label>
              </div>

              <div className="form-grid">
                <label>
                  <span>默认模型</span>
                  <input
                    type="text"
                    className="text-input"
                    placeholder={meta.defaultModel}
                    value={p.default_model ?? ""}
                    onChange={(e) => updateField(p.name, "default_model", e.target.value)}
                  />
                </label>

                <label>
                  <span>API Key 环境变量</span>
                  <input
                    type="text"
                    className="text-input"
                    placeholder={meta.envHint}
                    value={p.api_key_env ?? ""}
                    onChange={(e) => updateField(p.name, "api_key_env", e.target.value)}
                  />
                </label>

                <label className="col-span-2">
                  <span>Base URL（可选 — 自建代理时填写）</span>
                  <input
                    type="text"
                    className="text-input"
                    placeholder="https://api.anthropic.com"
                    value={p.base_url ?? ""}
                    onChange={(e) => updateField(p.name, "base_url", e.target.value)}
                  />
                </label>
              </div>

              <div className="card-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => save(p)}
                  disabled={saving === p.name}
                >
                  {saving === p.name ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
