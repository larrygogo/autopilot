import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";

type Toast = { type: "success" | "error"; message: string } | null;

export function Settings() {
  // 全局配置
  const [configYaml, setConfigYaml] = useState("");
  const [configLoading, setConfigLoading] = useState(true);

  // 工作流配置
  const [workflows, setWorkflows] = useState<{ name: string; description: string }[]>([]);
  const [selectedWf, setSelectedWf] = useState("");
  const [wfYaml, setWfYaml] = useState("");
  const [wfLoading, setWfLoading] = useState(false);

  // Daemon 信息
  const [status, setStatus] = useState<any>(null);

  // Toast
  const [toast, setToast] = useState<Toast>(null);

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  // 加载全局配置
  useEffect(() => {
    api.getConfig()
      .then((res) => setConfigYaml(res.yaml))
      .catch(() => {})
      .finally(() => setConfigLoading(false));
  }, []);

  // 加载工作流列表
  useEffect(() => {
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  // 加载 daemon 状态
  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
  }, []);

  // 选中工作流时加载 YAML
  useEffect(() => {
    if (!selectedWf) {
      setWfYaml("");
      return;
    }
    setWfLoading(true);
    api.getWorkflowYaml(selectedWf)
      .then((res) => setWfYaml(res.yaml))
      .catch((e) => showToast("error", e.message))
      .finally(() => setWfLoading(false));
  }, [selectedWf]);

  // 保存全局配置
  const saveConfig = async () => {
    try {
      await api.saveConfig(configYaml);
      showToast("success", "全局配置已保存");
    } catch (e: any) {
      showToast("error", e.message);
    }
  };

  // 保存工作流 YAML
  const saveWorkflow = async () => {
    if (!selectedWf) return;
    try {
      await api.saveWorkflowYaml(selectedWf, wfYaml);
      showToast("success", `工作流 ${selectedWf} 已保存并重载`);
    } catch (e: any) {
      showToast("error", e.message);
    }
  };

  // 重载工作流
  const reloadAll = async () => {
    try {
      const res = await api.reloadWorkflows();
      setWorkflows(res.workflows);
      showToast("success", "工作流已重载");
    } catch (e: any) {
      showToast("error", e.message);
    }
  };

  return (
    <div className="container">
      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}

      <div className="page-hdr">
        <h2>设置</h2>
      </div>

      {/* Daemon 信息 */}
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

      {/* 全局配置 */}
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
              <button className="btn btn-primary" onClick={saveConfig}>保存</button>
            </div>
          </>
        )}
      </div>

      {/* 工作流配置 */}
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
                  <button className="btn btn-primary" onClick={saveWorkflow}>保存并重载</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const CONFIG_PLACEHOLDER = `# 全局配置。仅存放跨工作流共享的基础设施（如 agents）；
# 工作流自己的参数请写在该工作流目录下的 workflow.yaml 或
# 其独立配置文件里，不要放在这里。
#
# agents：共享的命名 agent 定义。工作流可同名覆盖或 extends 别名，
#   调用 agent.run() 时可再用 RunOptions 覆盖提示词与模型。
#
# agents:
#   coder:
#     provider: anthropic          # 支持 anthropic / openai / google
#     model: claude-sonnet-4-6
#     max_turns: 10
#     permission_mode: auto
#     system_prompt: |
#       你是通用编码助手。
#   reviewer:
#     provider: anthropic
#     model: claude-opus-4-7
#     system_prompt: |
#       你是严苛的代码审查员。
`;
