import React, { useEffect, useState } from "react";
import { api, type AgentCallSummary, type AgentCallRecord } from "../hooks/useApi";
import { useToast } from "./Toast";

interface Props {
  taskId: string;
}

function fmtMs(ms?: number): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTokens(n?: number): string {
  if (n == null) return "";
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function fmtUsd(v?: number): string {
  if (v == null) return "";
  return `$${v.toFixed(4)}`;
}

export function AgentCallsViewer({ taskId }: Props) {
  const toast = useToast();
  const [calls, setCalls] = useState<AgentCallSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<AgentCallRecord | null>(null);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await api.listAgentCalls(taskId);
      setCalls(list);
    } catch (e: any) {
      toast.error("加载失败", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, [taskId]);

  const toggle = async (seq: number) => {
    if (expandedSeq === seq) {
      setExpandedSeq(null);
      setExpanded(null);
      return;
    }
    setExpandedSeq(seq);
    setExpanded(null);
    try {
      const rec = await api.getAgentCall(taskId, seq);
      setExpanded(rec);
    } catch (e: any) {
      toast.error("加载详情失败", e?.message ?? String(e));
    }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success("已复制"); } catch { /* ignore */ }
  };

  // 统计
  const total = calls.length;
  const totalInTokens = calls.reduce((a, c) => a + (c.usage?.input_tokens ?? 0), 0);
  const totalOutTokens = calls.reduce((a, c) => a + (c.usage?.output_tokens ?? 0), 0);
  const totalCost = calls.reduce((a, c) => a + (c.usage?.total_cost_usd ?? 0), 0);
  const totalErrors = calls.filter((c) => c.error).length;

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-header">
        <h3>Agent 调用</h3>
        <button className="btn btn-secondary" onClick={refresh} disabled={loading}>刷新</button>
      </div>

      {loading && calls.length === 0 ? (
        <p className="muted">加载中...</p>
      ) : calls.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          尚未记录 agent 调用。阶段函数里调用 <code className="mono">agent.run()</code> 后会自动记录 prompt / 响应 / token 用量。
        </p>
      ) : (
        <>
          <div className="agent-calls-stats">
            <span>共 <strong>{total}</strong> 次调用</span>
            {totalErrors > 0 && <span style={{ color: "var(--red)" }}>· 失败 {totalErrors}</span>}
            {totalInTokens > 0 && <span>· in <strong>{fmtTokens(totalInTokens)}</strong></span>}
            {totalOutTokens > 0 && <span>· out <strong>{fmtTokens(totalOutTokens)}</strong></span>}
            {totalCost > 0 && <span>· <strong>{fmtUsd(totalCost)}</strong></span>}
          </div>

          <div className="agent-calls-list">
            {calls.map((c) => {
              const isOpen = expandedSeq === c.seq;
              return (
                <div key={c.seq} className={`agent-call-item ${c.error ? "is-error" : ""} ${isOpen ? "is-open" : ""}`}>
                  <div className="agent-call-head" onClick={() => toggle(c.seq)}>
                    <div className="agent-call-meta">
                      <span className="agent-call-seq">#{c.seq}</span>
                      {c.phase && <span className="pill pill-cyan mono">{c.phase}</span>}
                      <span className="mono" style={{ color: "var(--cyan)" }}>{c.agent}</span>
                      {c.model && <span className="muted mono" style={{ fontSize: "0.72rem" }}>{c.model}</span>}
                    </div>
                    <div className="agent-call-stats muted">
                      {c.error && <span style={{ color: "var(--red)" }}>✕ 失败</span>}
                      {c.elapsed_ms != null && <span>{fmtMs(c.elapsed_ms)}</span>}
                      {c.usage?.input_tokens != null && <span>in {fmtTokens(c.usage.input_tokens)}</span>}
                      {c.usage?.output_tokens != null && <span>out {fmtTokens(c.usage.output_tokens)}</span>}
                      {c.usage?.total_cost_usd != null && <span>{fmtUsd(c.usage.total_cost_usd)}</span>}
                      <span className="agent-call-caret">{isOpen ? "▼" : "▶"}</span>
                    </div>
                  </div>
                  <div className="agent-call-preview muted">
                    <span className="agent-call-prompt-preview">→ {c.prompt_preview || "(空 prompt)"}</span>
                  </div>

                  {isOpen && (
                    <div className="agent-call-detail">
                      {!expanded ? (
                        <p className="muted">加载详情中...</p>
                      ) : expanded.seq === c.seq ? (
                        <>
                          {expanded.system_prompt && (
                            <AgentCallBlock label="System prompt" content={expanded.system_prompt} onCopy={copy} />
                          )}
                          {expanded.additional_system && (
                            <AgentCallBlock label="Additional system" content={expanded.additional_system} onCopy={copy} />
                          )}
                          <AgentCallBlock label="Prompt" content={expanded.prompt} onCopy={copy} />
                          {expanded.error ? (
                            <AgentCallBlock label="Error" content={expanded.error} errorStyle onCopy={copy} />
                          ) : (
                            <AgentCallBlock label="Response" content={expanded.result_text ?? "(空)"} onCopy={copy} />
                          )}
                          <p className="muted" style={{ fontSize: "0.7rem" }}>
                            {new Date(expanded.ts).toLocaleString()}
                            {expanded.provider && ` · ${expanded.provider}`}
                          </p>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function AgentCallBlock({ label, content, errorStyle, onCopy }: {
  label: string;
  content: string;
  errorStyle?: boolean;
  onCopy: (s: string) => void;
}) {
  return (
    <div className="agent-call-block">
      <div className="agent-call-block-head">
        <strong>{label}</strong>
        <button className="btn btn-secondary" style={{ padding: "0.2rem 0.6rem", minHeight: 26, fontSize: "0.74rem" }} onClick={() => onCopy(content)}>复制</button>
      </div>
      <pre className={`agent-call-body ${errorStyle ? "is-error" : ""}`}>{content}</pre>
    </div>
  );
}
