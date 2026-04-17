import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { useToast } from "../components/Toast";

export function Settings({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();

  const [configYaml, setConfigYaml] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);

  const [workflows, setWorkflows] = useState<{ name: string; description: string }[]>([]);
  const [selectedWf, setSelectedWf] = useState("");
  const [wfYaml, setWfYaml] = useState("");
  const [wfLoading, setWfLoading] = useState(false);
  const [wfSaving, setWfSaving] = useState(false);

  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    api.getConfig()
      .then((res) => setConfigYaml(res.yaml))
      .catch((e) => toast.error("加载全局配置失败", e?.message ?? String(e)))
      .finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedWf) { setWfYaml(""); return; }
    setWfLoading(true);
    api.getWorkflowYaml(selectedWf)
      .then((res) => setWfYaml(res.yaml))
      .catch((e) => toast.error("加载工作流失败", e?.message ?? String(e)))
      .finally(() => setWfLoading(false));
  }, [selectedWf]);

  const saveConfig = async () => {
    setConfigSaving(true);
    try {
      await api.saveConfig(configYaml);
      toast.success("全局配置已保存");
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  const saveWorkflow = async () => {
    if (!selectedWf) return;
    setWfSaving(true);
    try {
      await api.saveWorkflowYaml(selectedWf, wfYaml);
      toast.success(`工作流 ${selectedWf} 已保存并重载`);
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setWfSaving(false);
    }
  };

  const reloadAll = async () => {
    try {
      const res = await api.reloadWorkflows();
      setWorkflows(res.workflows);
      toast.success("工作流已重载");
    } catch (e: any) {
      toast.error("重载失败", e?.message ?? String(e));
    }
  };

  const body = (
    <>
      {!embedded && (
        <div className="page-hdr">
          <h2>高级 (YAML)</h2>
        </div>
      )}

      {embedded && (
        <div className="subtab-toolbar">
          <span className="muted" style={{ fontSize: "0.82rem" }}>
            优先使用上方的图形化编辑；这里是 YAML 直编后门
          </span>
        </div>
      )}

      {status && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3>Daemon 信息</h3>
          <div className="settings-info-grid">
            <div><span className="muted">版本：</span>{status.version}</div>
            <div><span className="muted">PID：</span>{status.pid}</div>
            <div><span className="muted">运行时间：</span>{formatUptime(status.uptime)}</div>
            <div><span className="muted">端口：</span>{location.port || "80"}</div>
          </div>
        </div>
      )}

      <DaemonLogCard />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="card-header">
          <h3>全局配置</h3>
          <span className="muted mono" style={{ fontSize: "0.75rem" }}>config.yaml</span>
        </div>
        {configLoading ? (
          <p className="muted">加载中...</p>
        ) : (
          <>
            <textarea
              className="yaml-editor"
              value={configYaml}
              onChange={(e) => setConfigYaml(e.target.value)}
              placeholder={CONFIG_PLACEHOLDER}
              spellCheck={false}
            />
            <div className="card-actions">
              <button className="btn btn-primary" onClick={saveConfig} disabled={configSaving}>
                {configSaving ? "保存中..." : "保存"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>工作流配置</h3>
          <button className="btn btn-secondary" onClick={reloadAll}>重载全部</button>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <select
            className="wf-select"
            value={selectedWf}
            onChange={(e) => setSelectedWf(e.target.value)}
          >
            <option value="">选择工作流...</option>
            {workflows.map((wf) => (
              <option key={wf.name} value={wf.name}>
                {wf.name}{wf.description ? ` — ${wf.description}` : ""}
              </option>
            ))}
          </select>
        </div>

        {selectedWf && (
          <>
            {wfLoading ? (
              <p className="muted">加载中...</p>
            ) : (
              <>
                <textarea
                  className="yaml-editor"
                  value={wfYaml}
                  onChange={(e) => setWfYaml(e.target.value)}
                  placeholder="# workflow.yaml"
                  spellCheck={false}
                />
                <div className="card-actions">
                  <button className="btn btn-primary" onClick={saveWorkflow} disabled={wfSaving}>
                    {wfSaving ? "保存中..." : "保存并重载"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );

  return embedded ? <>{body}</> : <div className="container">{body}</div>;
}

function DaemonLogCard(): React.ReactElement {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.getDaemonLog(1000);
      setContent(res.content);
      setPath(res.path);
    } catch (e: any) {
      toast.error("加载 daemon 日志失败", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, []);

  const filtered = React.useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const q = query.trim().toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [content, query]);

  const extractLevel = (line: string): string | null => {
    const m = line.match(/\s\[(INFO|WARN|ERROR|DEBUG)\]\s/);
    return m?.[1] ?? null;
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-header">
        <h3>Daemon 日志</h3>
        <button className="btn btn-secondary" onClick={refresh} disabled={loading}>刷新</button>
      </div>
      {path ? (
        <p className="muted" style={{ fontSize: "0.76rem", marginBottom: "0.5rem" }}>
          位置：<code className="mono">{path}</code>
          <span style={{ marginLeft: "0.5rem" }}>（含上一次滚动的 .1 备份，最后 1000 行）</span>
        </p>
      ) : (
        <p className="muted" style={{ fontSize: "0.82rem" }}>daemon 日志未激活或路径未知。</p>
      )}
      <input
        type="search"
        className="text-input"
        placeholder="搜索日志..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: "0.5rem" }}
      />
      {loading && !content ? (
        <p className="muted">加载中...</p>
      ) : filtered.length === 0 ? (
        <p className="muted" style={{ padding: "0.5rem" }}>
          {content ? "（当前过滤下无匹配）" : "（空）"}
        </p>
      ) : (
        <pre className="phase-log-body" style={{ maxHeight: 400 }}>
          {filtered.map((line, i) => {
            const lvl = extractLevel(line);
            return (
              <div key={i} className={`log-row ${lvl ? `log-row-${lvl.toLowerCase()}` : ""}`}>{line}</div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const CONFIG_PLACEHOLDER = `# 全局配置。仅存放跨工作流共享的基础设施（providers / agents）；
# 工作流自己的参数请写在该工作流目录下的 workflow.yaml 或
# 其独立配置文件里，不要放在这里。
#
# providers:
#   anthropic:
#     default_model: claude-sonnet-4-6
#     base_url: ""
#     enabled: true
#
# agents:
#   coder:
#     provider: anthropic
#     model: claude-sonnet-4-6
#     max_turns: 10
#     permission_mode: auto
#     system_prompt: |
#       你是通用编码助手。
`;
