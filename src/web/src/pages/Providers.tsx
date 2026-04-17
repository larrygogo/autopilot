import React, { useEffect, useState } from "react";
import { api, type ProviderItem, type ProviderStatus, type ProviderModelsResult } from "../hooks/useApi";
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
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});
  const [checking, setChecking] = useState(false);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    api.listProviders()
      .then(setProviders)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  const refreshStatus = async () => {
    setChecking(true);
    try {
      const list = await api.getProvidersStatus();
      const map: Record<string, ProviderStatus> = {};
      for (const s of list) map[s.name] = s;
      setStatuses(map);
    } catch (e: any) {
      console.warn("状态检测失败", e);
    } finally {
      setChecking(false);
    }
  };

  const refreshModels = async () => {
    const names = ["anthropic", "openai", "google"];
    const results = await Promise.all(names.map((n) => api.getProviderModels(n).catch(() => null)));
    const map: Record<string, ProviderModelsResult> = {};
    for (const r of results) if (r) map[r.name] = r;
    setModels(map);
  };

  useEffect(() => { refresh(); refreshStatus(); refreshModels(); }, []);

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
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
          <p className="muted" style={{ fontSize: "0.85rem", flex: 1, margin: 0 }}>
            Autopilot 通过 Claude / Codex / Gemini 各自的 CLI 调用模型，凭证由 CLI 管理。
            如尚未登录，请在终端中运行对应的 <span className="mono">login</span> 命令。
          </p>
          <button className="btn btn-secondary" onClick={refreshStatus} disabled={checking}>
            {checking ? "检查中..." : "重新检查"}
          </button>
        </div>
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
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <h3>{meta.label}</h3>
                    <ProviderStatusBadge status={statuses[p.name]} />
                    <span className="pill pill-accent">
                      {p.agent_count ?? 0} 个智能体
                    </span>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={p.enabled !== false}
                      onChange={(e) => updateField(p.name, "enabled", e.target.checked)}
                    />
                    <span>{p.enabled !== false ? "启用" : "禁用"}</span>
                  </label>
                </div>

                <ProviderStatusDetail status={statuses[p.name]} loginCmd={meta.loginCmd} />

                <div className="form-grid">
                  <label className="col-span-2">
                    <span>
                      默认模型
                      {models[p.name] && (
                        <span className="muted" style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}>
                          （{models[p.name].source === "api" ? "API 实时列表" : "内置列表"}
                          {models[p.name].error ? ` · 降级：${models[p.name].error}` : ""}）
                        </span>
                      )}
                    </span>
                    <input
                      type="text"
                      className="text-input mono"
                      placeholder={meta.defaultModel}
                      value={p.default_model ?? ""}
                      list={`models-${p.name}`}
                      onChange={(e) => updateField(p.name, "default_model", e.target.value)}
                    />
                    {models[p.name] && (
                      <datalist id={`models-${p.name}`}>
                        {models[p.name].models.map((m) => <option key={m} value={m} />)}
                      </datalist>
                    )}
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

function ProviderStatusBadge({ status }: { status?: ProviderStatus }) {
  if (!status) {
    return <span className="pill status-pill status-unknown">未检测</span>;
  }
  if (!status.cli_installed) {
    return <span className="pill status-pill status-missing">CLI 未安装</span>;
  }
  if (status.error) {
    return <span className="pill status-pill status-warn">CLI 异常</span>;
  }
  return <span className="pill status-pill status-ok">CLI 就绪</span>;
}

function ProviderStatusDetail({ status, loginCmd }: { status?: ProviderStatus; loginCmd: string }) {
  if (!status) {
    return (
      <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
        登录命令：<span className="mono">{loginCmd}</span>
      </p>
    );
  }

  if (!status.cli_installed) {
    return (
      <div className="status-detail status-detail-error">
        <div><strong>⚠ {status.error ?? "CLI 未安装"}</strong></div>
        {status.install_hint && (
          <div style={{ fontSize: "0.78rem", marginTop: "0.35rem" }}>
            安装：<code className="mono">{status.install_hint}</code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="status-detail">
      <div>
        <span className="muted" style={{ fontSize: "0.78rem" }}>CLI：</span>
        <code className="mono" style={{ fontSize: "0.78rem" }}>{status.cli_path}</code>
      </div>
      {status.cli_version && (
        <div style={{ marginTop: "0.2rem" }}>
          <span className="muted" style={{ fontSize: "0.78rem" }}>版本：</span>
          <code className="mono" style={{ fontSize: "0.78rem" }}>{status.cli_version}</code>
        </div>
      )}
      {status.error && (
        <div style={{ marginTop: "0.3rem", color: "var(--yellow)", fontSize: "0.78rem" }}>
          ⚠ {status.error}
        </div>
      )}
      <div style={{ marginTop: "0.3rem", fontSize: "0.78rem" }}>
        <span className="muted">登录：</span><span className="mono">{loginCmd}</span>
      </div>
    </div>
  );
}
