import React, { useEffect, useRef, useState, useCallback } from "react";
import { api, type ChatMessage, type ChatSessionManifest, type AgentItem } from "../hooks/useApi";
import { useToast } from "../components/Toast";

interface ChatProps {
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

export function Chat({ subscribe }: ChatProps) {
  const toast = useToast();
  const [sessions, setSessions] = useState<ChatSessionManifest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [workflows, setWorkflows] = useState<{ name: string; description: string }[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [workflow, setWorkflow] = useState<string>("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 1. 初始加载：sessions + agents + workflows
  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSessions();
    api.listAgents().then(setAgents).catch(() => {});
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, [refreshSessions]);

  // 2. 选中 session 时加载消息
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    api.getSession(selected).then((s) => {
      setMessages(s.messages);
      if (s.agent && !agent) setAgent(s.agent);
      if (s.workflow && !workflow) setWorkflow(s.workflow);
    }).catch(() => {});
  }, [selected]); // eslint-disable-line

  // 3. 订阅当前 session 的流式事件
  useEffect(() => {
    if (!selected) return;
    const unsub = subscribe(`chat:${selected}`, (event: any) => {
      if (event.type === "chat:delta") {
        setStreaming((prev) => prev + event.payload.delta);
      } else if (event.type === "chat:complete") {
        setStreaming("");
        setMessages((prev) => [...prev, event.payload.message]);
        refreshSessions();
      } else if (event.type === "chat:error") {
        setStreaming("");
        toast.error(`对话错误：${event.payload.error}`);
      }
    });
    return unsub;
  }, [selected, subscribe, refreshSessions, toast]);

  // 4. 消息区滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // 5. 发消息
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setStreaming("");
    // 乐观插入 user 消息
    const userMsg: ChatMessage = { role: "user", content: text, ts: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    try {
      const result = await api.chat({
        message: text,
        session_id: selected ?? undefined,
        agent: agent || undefined,
        workflow: workflow || undefined,
      });
      if (!selected) {
        setSelected(result.session_id);
      }
      // complete 事件通常已经更新消息；若 WS 滞后，兜底从 API 返回补
      setMessages((prev) => {
        if (prev.some((m) => m.ts === result.message.ts && m.role === "assistant")) return prev;
        return [...prev, result.message];
      });
      refreshSessions();
    } catch (e) {
      toast.error(`发送失败：${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  }, [draft, sending, selected, agent, workflow, refreshSessions, toast]);

  const newChat = () => {
    setSelected(null);
    setMessages([]);
    setStreaming("");
    inputRef.current?.focus();
  };

  const deleteCurrent = async () => {
    if (!selected) return;
    if (!confirm("删除这个对话？")) return;
    try {
      await api.deleteSession(selected);
      setSelected(null);
      setMessages([]);
      refreshSessions();
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "280px 1fr",
      gap: 16,
      height: "calc(100vh - 120px)",
    }}>
      {/* 侧栏 */}
      <aside style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
          <button
            onClick={newChat}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "var(--accent)",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            + 新对话
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {sessions.length === 0 && (
            <div style={{ padding: 16, color: "var(--muted)", fontSize: 13 }}>
              暂无对话。点击「新对话」开始。
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => setSelected(s.id)}
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                background: selected === s.id ? "var(--accent-dim)" : "transparent",
              }}
            >
              <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title || s.id.slice(0, 8)}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {s.agent}{s.workflow ? ` · ${s.workflow}` : ""} · {s.message_count} 条
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* 对话区 */}
      <main style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* 顶部 agent / workflow 选择 */}
        <div style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          fontSize: 13,
        }}>
          <span style={{ color: "var(--text2)" }}>Agent：</span>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            disabled={!!selected}
            style={{ padding: "4px 8px", background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4 }}
          >
            <option value="">(默认)</option>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
          <span style={{ color: "var(--text2)", marginLeft: 12 }}>工作流：</span>
          <select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            disabled={!!selected}
            style={{ padding: "4px 8px", background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4 }}
          >
            <option value="">(无)</option>
            {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          {selected && (
            <button
              onClick={deleteCurrent}
              style={{ padding: "4px 10px", background: "transparent", color: "var(--red)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}
            >
              删除会话
            </button>
          )}
        </div>

        {/* 消息列表 */}
        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {messages.length === 0 && !streaming && (
            <div style={{ textAlign: "center", color: "var(--muted)", marginTop: 60 }}>
              发一条消息开始对话。
            </div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {streaming && (
            <MessageBubble
              message={{ role: "assistant", content: streaming, ts: "" }}
              streaming
            />
          )}
        </div>

        {/* 输入区 */}
        <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="输入消息（Ctrl/Cmd + Enter 发送）"
            rows={3}
            disabled={sending}
            style={{
              width: "100%",
              padding: 10,
              background: "var(--bg2)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              resize: "vertical",
              fontFamily: "var(--sans)",
              fontSize: 14,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              style={{
                padding: "8px 20px",
                background: sending || !draft.trim() ? "var(--bg3)" : "var(--accent)",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: sending || !draft.trim() ? "not-allowed" : "pointer",
                fontWeight: 500,
              }}
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 16,
    }}>
      <div style={{
        maxWidth: "75%",
        padding: "10px 14px",
        background: isUser ? "var(--accent)" : "var(--bg2)",
        color: isUser ? "white" : "var(--text)",
        borderRadius: 12,
        borderTopRightRadius: isUser ? 4 : 12,
        borderTopLeftRadius: isUser ? 12 : 4,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 14,
        lineHeight: 1.6,
      }}>
        {message.content}
        {streaming && <span style={{ opacity: 0.6 }}>▎</span>}
        {message.usage && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
            {message.usage.input_tokens}+{message.usage.output_tokens} tok · ${message.usage.total_cost_usd?.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  );
}
