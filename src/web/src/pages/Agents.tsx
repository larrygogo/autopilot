import React, { useEffect, useState } from "react";
import { api, type AgentItem } from "../hooks/useApi";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";

type Mode = { type: "list" } | { type: "edit"; original: string | null; draft: AgentItem };

const PROVIDERS = ["anthropic", "openai", "google"] as const;
const PERMISSION_MODES = ["auto", "ask", "readonly", "deny"] as const;

function emptyDraft(): AgentItem {
  return { name: "", provider: "anthropic", model: "", max_turns: 10, permission_mode: "auto", system_prompt: "" };
}

export function Agents({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ type: "list" });
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    api.listAgents()
      .then(setAgents)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const startCreate = () => setMode({ type: "edit", original: null, draft: emptyDraft() });
  const startEdit = (a: AgentItem) => setMode({ type: "edit", original: a.name, draft: { ...a } });
  const cancel = () => setMode({ type: "list" });

  const doDelete = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    try {
      await api.deleteAgent(name);
      toast.success(`已删除 ${name}`);
      refresh();
    } catch (e: any) {
      toast.error("删除失败", e?.message ?? String(e));
    } finally {
      setPendingDelete(null);
    }
  };

  const save = async () => {
    if (mode.type !== "edit") return;
    const { original, draft } = mode;
    if (!draft.name || !/^[\w.\-]+$/.test(draft.name)) {
      toast.warning("名称必须为字母、数字、._- 组成，且非空");
      return;
    }
    if (!draft.provider) {
      toast.warning("必须选择 provider");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { provider: draft.provider };
      if (draft.model) body.model = draft.model;
      if (typeof draft.max_turns === "number") body.max_turns = draft.max_turns;
      if (draft.permission_mode) body.permission_mode = draft.permission_mode;
      if (draft.system_prompt) body.system_prompt = draft.system_prompt;
      if (draft.extends) body.extends = draft.extends;

      if (original && original === draft.name) {
        await api.updateAgent(original, body);
      } else if (original && original !== draft.name) {
        await api.createAgent({ name: draft.name, ...body });
        await api.deleteAgent(original);
      } else {
        await api.createAgent({ name: draft.name, ...body });
      }
      toast.success("已保存");
      setMode({ type: "list" });
      refresh();
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = <K extends keyof AgentItem>(key: K, value: AgentItem[K]) => {
    if (mode.type !== "edit") return;
    setMode({ ...mode, draft: { ...mode.draft, [key]: value } });
  };

  const body = (
    <>
      {mode.type === "list" && (
        <>
          {!embedded && (
            <div className="page-hdr">
              <h2>智能体</h2>
              <span>{agents.length} 个</span>
              <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={startCreate}>
                新建
              </button>
            </div>
          )}
          {embedded && (
            <div className="subtab-toolbar">
              <span className="muted">{agents.length} 个智能体</span>
              <button className="btn btn-primary" onClick={startCreate}>新建</button>
            </div>
          )}

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
          ) : agents.length === 0 ? (
            <div className="card empty-state">
              <p className="muted">暂无智能体</p>
              <button className="btn btn-primary" onClick={startCreate}>创建第一个智能体</button>
            </div>
          ) : (
            <div className="agent-list">
              {agents.map((a) => (
                <div key={a.name} className="card agent-card">
                  <div className="agent-card-head">
                    <div>
                      <h3 style={{ color: "var(--cyan)" }}>{a.name}</h3>
                      <div className="agent-meta mono muted">
                        <span>{a.provider ?? "—"}</span>
                        {a.model && <span>/ {a.model}</span>}
                        {a.max_turns !== undefined && <span>· {a.max_turns} turns</span>}
                      </div>
                    </div>
                    <div className="agent-actions">
                      <button className="btn btn-secondary" onClick={() => startEdit(a)}>编辑</button>
                      <button className="btn btn-danger" onClick={() => setPendingDelete(a.name)}>删除</button>
                    </div>
                  </div>
                  {a.used_by && a.used_by.length > 0 && (
                    <div className="usage-pills">
                      <span className="usage-label">被引用：</span>
                      {a.used_by.map((wf) => (
                        <span key={wf} className="pill pill-cyan mono">{wf}</span>
                      ))}
                    </div>
                  )}
                  {a.system_prompt && (
                    <p className="agent-prompt muted">
                      {a.system_prompt.length > 140 ? a.system_prompt.slice(0, 140) + "…" : a.system_prompt}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode.type === "edit" && (
        <>
          <div className="page-hdr">
            <button className="btn-back" onClick={cancel}>← 返回</button>
            <h2>{mode.original ? `编辑 ${mode.original}` : "新建智能体"}</h2>
          </div>

          <div className="card">
            <div className="form-grid">
              <label>
                <span>名称 <span className="required">*</span></span>
                <input
                  type="text"
                  className="text-input mono"
                  placeholder="coder"
                  value={mode.draft.name}
                  onChange={(e) => updateDraft("name", e.target.value)}
                  disabled={!!mode.original}
                />
                {mode.original && <small className="muted">改名请删除后重建</small>}
              </label>

              <label>
                <span>提供商 <span className="required">*</span></span>
                <select
                  className="wf-select"
                  value={mode.draft.provider ?? ""}
                  onChange={(e) => updateDraft("provider", e.target.value)}
                >
                  {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>

              <label>
                <span>模型（留空使用 provider 默认）</span>
                <input
                  type="text"
                  className="text-input mono"
                  placeholder="claude-sonnet-4-6"
                  value={mode.draft.model ?? ""}
                  onChange={(e) => updateDraft("model", e.target.value)}
                />
              </label>

              <label>
                <span>最大轮数</span>
                <input
                  type="number"
                  className="text-input"
                  min={1}
                  value={mode.draft.max_turns ?? 10}
                  onChange={(e) => updateDraft("max_turns", parseInt(e.target.value, 10) || 10)}
                />
              </label>

              <label>
                <span>权限模式</span>
                <select
                  className="wf-select"
                  value={mode.draft.permission_mode ?? "auto"}
                  onChange={(e) => updateDraft("permission_mode", e.target.value)}
                >
                  {PERMISSION_MODES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>

              <label>
                <span>继承自（可选）</span>
                <input
                  type="text"
                  className="text-input mono"
                  placeholder="留空默认继承同名"
                  value={(mode.draft.extends as string) ?? ""}
                  onChange={(e) => updateDraft("extends", e.target.value || undefined)}
                />
              </label>

              <label className="col-span-2">
                <span>系统提示词</span>
                <textarea
                  className="yaml-editor"
                  style={{ minHeight: 180 }}
                  placeholder="这里定义该智能体的基础角色提示词。调用时可追加 additional_system。"
                  value={mode.draft.system_prompt ?? ""}
                  onChange={(e) => updateDraft("system_prompt", e.target.value)}
                />
              </label>
            </div>

            <div className="card-actions">
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </button>
              <button className="btn btn-secondary" onClick={cancel}>取消</button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除智能体"
        message={
          <div>
            <p>确认删除智能体 <code className="mono">{pendingDelete}</code>？此操作不可恢复。</p>
            {pendingDelete && (() => {
              const target = agents.find((a) => a.name === pendingDelete);
              const refs = target?.used_by ?? [];
              if (refs.length === 0) return null;
              return (
                <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.8rem", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 6 }}>
                  <p style={{ color: "var(--yellow)", fontSize: "0.82rem" }}>
                    ⚠ 以下 {refs.length} 个工作流引用了此智能体，删除后这些工作流将无法运行：
                  </p>
                  <div style={{ marginTop: "0.4rem", display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                    {refs.map((wf) => <span key={wf} className="pill pill-cyan mono">{wf}</span>)}
                  </div>
                </div>
              );
            })()}
          </div>
        }
        confirmText="删除"
        danger
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );

  return embedded ? <>{body}</> : <div className="container">{body}</div>;
}
