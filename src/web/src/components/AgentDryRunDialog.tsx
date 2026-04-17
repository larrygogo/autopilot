import React, { useEffect, useState } from "react";
import { api, type AgentItem, type ProviderModelsResult } from "../hooks/useApi";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: AgentItem | null;
}

interface RunResult {
  elapsed_ms: number;
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export function AgentDryRunDialog({ open, onClose, agent }: Props) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [additionalSystem, setAdditionalSystem] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [maxTurns, setMaxTurns] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [models, setModels] = useState<ProviderModelsResult | null>(null);

  // 打开时重置
  useEffect(() => {
    if (open) {
      setPrompt("");
      setAdditionalSystem("");
      setModelOverride("");
      setMaxTurns("");
      setResult(null);
    }
  }, [open, agent?.name]);

  // 加载 provider 对应的模型列表（只在有 provider 时）
  useEffect(() => {
    if (!open || !agent?.provider) { setModels(null); return; }
    api.getProviderModels(agent.provider).then(setModels).catch(() => setModels(null));
  }, [open, agent?.provider]);

  if (!agent) return null;

  const canRun = prompt.trim().length > 0 && !running;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setResult(null);
    try {
      const turns = maxTurns ? parseInt(maxTurns, 10) : undefined;
      const body = {
        prompt,
        ...(additionalSystem ? { additional_system: additionalSystem } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(typeof turns === "number" && turns > 0 ? { max_turns: turns } : {}),
      };
      const res = await api.dryRunAgent(agent.name, body);
      setResult({
        elapsed_ms: res.elapsed_ms,
        text: res.result.text,
        usage: res.result.usage,
      });
    } catch (e: any) {
      toast.error("试跑失败", e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      toast.success("已复制到剪贴板");
    } catch { /* ignore */ }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  };

  return (
    <Modal
      open={open}
      onClose={() => !running && onClose()}
      title={`试跑智能体：${agent.name}`}
      size="lg"
      dismissable={!running}
      actions={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={running}>
            {result ? "关闭" : "取消"}
          </button>
          <button className="btn btn-primary" onClick={run} disabled={!canRun}>
            {running ? "运行中..." : result ? "重新运行" : "运行"}
          </button>
        </>
      }
    >
      {/* agent 基础信息摘要 */}
      <div className="card" style={{ background: "var(--bg0)", padding: "0.6rem 0.85rem", marginBottom: "0.75rem", fontSize: "0.82rem" }}>
        <div className="mono" style={{ color: "var(--cyan)" }}>
          {agent.provider ?? "—"}{agent.model ? ` / ${agent.model}` : ""}
          {agent.max_turns !== undefined && <span className="muted"> · {agent.max_turns} turns</span>}
        </div>
        {agent.system_prompt && (
          <p className="muted" style={{ fontSize: "0.76rem", marginTop: "0.3rem", whiteSpace: "pre-wrap" }}>
            {agent.system_prompt.length > 200 ? agent.system_prompt.slice(0, 200) + "…" : agent.system_prompt}
          </p>
        )}
      </div>

      <div className="form-grid" onKeyDown={onKeyDown}>
        <label className="col-span-2">
          <span>Prompt <span className="required">*</span></span>
          <textarea
            className="yaml-editor"
            style={{ minHeight: 140 }}
            placeholder="输入要测试的 prompt；Ctrl/Cmd + Enter 快速运行"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </label>

        <label>
          <span>临时覆盖模型（可选）</span>
          <input
            type="text"
            className="text-input mono"
            placeholder={agent.model ?? "使用 agent 配置的模型"}
            list={models ? "dry-run-models" : undefined}
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
          />
          {models && (
            <datalist id="dry-run-models">
              {models.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
        </label>

        <label>
          <span>最大轮数（可选）</span>
          <input
            type="number"
            className="text-input"
            min={1}
            placeholder={String(agent.max_turns ?? 10)}
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
          />
        </label>

        <label className="col-span-2">
          <span>追加 system prompt（可选，叠加到 agent 的 system_prompt 之后）</span>
          <textarea
            className="yaml-editor"
            style={{ minHeight: 80 }}
            placeholder="例如：仅用中文回答 / 严格按 JSON 格式返回"
            value={additionalSystem}
            onChange={(e) => setAdditionalSystem(e.target.value)}
          />
        </label>
      </div>

      {running && (
        <div className="card" style={{ marginTop: "1rem", textAlign: "center", padding: "1.2rem" }}>
          <p className="muted">运行中... CLI 可能会弹出权限确认</p>
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="card-header">
            <h3>结果</h3>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: "0.76rem" }}>
                耗时 {Math.round(result.elapsed_ms / 100) / 10}s
                {result.usage?.input_tokens != null && ` · in ${result.usage.input_tokens}t`}
                {result.usage?.output_tokens != null && ` · out ${result.usage.output_tokens}t`}
                {result.usage?.total_cost_usd != null && ` · $${result.usage.total_cost_usd.toFixed(4)}`}
              </span>
              <button className="btn btn-secondary" onClick={copyResult}>复制</button>
            </div>
          </div>
          <pre className="dry-run-result">{result.text || "（空输出）"}</pre>
        </div>
      )}

      <p className="muted" style={{ marginTop: "0.6rem", fontSize: "0.74rem" }}>
        注：试跑不创建任务、不走工作流；失败不会影响任何运行中的任务。
      </p>
    </Modal>
  );
}
