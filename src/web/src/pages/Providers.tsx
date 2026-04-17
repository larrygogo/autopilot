import React, { useEffect, useState } from "react";
import { api, type ProviderItem } from "../hooks/useApi";
import { useToast } from "../components/Toast";

const PROVIDER_META: Record<string, { label: string; defaultModel: string; loginCmd: string }> = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-6", loginCmd: "claude login" },
  openai: { label: "OpenAI (Codex)", defaultModel: "o4-mini", loginCmd: "codex login" },
  google: { label: "Google (Gemini)", defaultModel: "gemini-2.5-pro", loginCmd: "gemini auth login" },
};

export function Providers({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    api.listProviders()
      .then(setProviders)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
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
      toast.success(`${name} 配置已保存`);
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setSaving(null);
    }
  };

  const body = (
    <>
      {!embedded && (
        <div className="page-hdr">
          <h2>模型提供商</h2>
          <span>LLM 提供商全局默认</span>
        </div>
      )}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Autopilot 通过 Claude / Codex / Gemini 各自的 CLI 调用模型，凭证由 CLI 管理。
          如尚未登录，请在终端中运行对应的 <span className="mono">login</span> 命令。
        </p>
      </div>

      {loadError && (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "rgba(248,113,113,0.4)" }}>
          <p style={{ color: "var(--red)" }}>加载失败：{loadError}</p>
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
            常见原因：daemon 未重启（新 API 未生效）。请执行 <code className="mono">autopilot daemon stop && autopilot daemon start</code> 后刷新页面。
          </p>
        </div>
      )}

      {loading ? (
        <p className="muted">加载中...</p>
      ) : (
        <div className="provider-list">
          {providers.map((p) => {
            const meta = PROVIDER_META[p.name] ?? { label: p.name, defaultModel: "", loginCmd: "" };
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

                {meta.loginCmd && (
                  <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
                    登录命令：<span className="mono">{meta.loginCmd}</span>
                  </p>
                )}

                <div className="form-grid">
                  <label className="col-span-2">
                    <span>默认模型</span>
                    <input
                      type="text"
                      className="text-input mono"
                      placeholder={meta.defaultModel}
                      value={p.default_model ?? ""}
                      onChange={(e) => updateField(p.name, "default_model", e.target.value)}
                    />
                  </label>

                  <label className="col-span-2">
                    <span>Base URL（可选 — 仅在使用自建代理/兼容端点时填写）</span>
                    <input
                      type="text"
                      className="text-input mono"
                      placeholder="留空使用官方端点"
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
      )}
    </>
  );

  return embedded ? <>{body}</> : <div className="container">{body}</div>;
}
