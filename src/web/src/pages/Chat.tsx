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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSessions();
    api.listAgents().then(setAgents).catch(() => {});
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, [refreshSessions]);

  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    api.getSession(selected).then((s) => {
      setMessages(s.messages);
      if (s.agent) setAgent(s.agent);
      setWorkflow(s.workflow ?? "");
    }).catch(() => {});
  }, [selected]); // eslint-disable-line

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [sidebarOpen]);

  // 输入框自适应高度
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [draft]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setStreaming("");
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
      if (!selected) setSelected(result.session_id);
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
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const selectSession = (id: string) => {
    setSelected(id);
    setSidebarOpen(false);
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

  const currentSession = sessions.find((s) => s.id === selected) ?? null;
  const currentTitle = currentSession?.title || (selected ? selected.slice(0, 8) : "新对话");
  const currentAgent = currentSession?.agent || agent || "(默认)";
  const currentWorkflow = currentSession?.workflow || workflow;

  return (
    <div className="chat-layout">
      {sidebarOpen && (
        <div className="chat-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      <aside className={`chat-sidebar ${sidebarOpen ? "chat-sidebar-open" : ""}`}>
        <div className="chat-sidebar-head">
          <button className="chat-new-btn" onClick={newChat}>+ 新对话</button>
          <button
            className="chat-sidebar-close mobile-only"
            onClick={() => setSidebarOpen(false)}
            aria-label="关闭"
          >✕</button>
        </div>
        <div className="chat-session-list">
          {sessions.length === 0 && (
            <div className="chat-empty">暂无对话</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => selectSession(s.id)}
              className={`chat-session-item ${selected === s.id ? "chat-session-active" : ""}`}
            >
              <div className="chat-session-title">{s.title || s.id.slice(0, 8)}</div>
              <div className="chat-session-meta">
                {s.agent}{s.workflow ? ` · ${s.workflow}` : ""} · {s.message_count} 条
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        <div className="chat-head">
          <button
            className="chat-sidebar-toggle mobile-only"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开会话列表"
          >☰</button>
          <div className="chat-head-title">
            <span className="chat-head-title-text">{currentTitle}</span>
          </div>
          <div className="chat-head-chips">
            {selected ? (
              <>
                <span className="chat-chip">⚙ {currentAgent}</span>
                {currentWorkflow && <span className="chat-chip chat-chip-muted">▸ {currentWorkflow}</span>}
              </>
            ) : (
              <>
                <select
                  className="chat-select"
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                >
                  <option value="">默认 agent</option>
                  {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
                <select
                  className="chat-select"
                  value={workflow}
                  onChange={(e) => setWorkflow(e.target.value)}
                >
                  <option value="">不限工作流</option>
                  {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
                </select>
              </>
            )}
          </div>
          {selected && (
            <button className="chat-delete-btn" onClick={deleteCurrent}>删除</button>
          )}
        </div>

        <div ref={scrollRef} className="chat-messages">
          <div className="chat-messages-inner">
            {messages.length === 0 && !streaming && (
              <div className="chat-empty-hint">发一条消息开始对话</div>
            )}
            {messages.map((m, i) => <MessageItem key={i} message={m} />)}
            {streaming && (
              <MessageItem
                message={{ role: "assistant", content: streaming, ts: "" }}
                streaming
              />
            )}
          </div>
        </div>

        <div className="chat-input-wrap">
          <div className="chat-input-inner">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
              rows={1}
              disabled={sending}
              className="chat-input"
            />
            <button
              className="chat-send-btn"
              onClick={send}
              disabled={sending || !draft.trim()}
              aria-label="发送"
            >
              <svg className="chat-send-icon" viewBox="0 0 16 16">
                <path d="M1.5 14.5 15 8 1.5 1.5 1.5 6.5 10 8 1.5 9.5z" />
              </svg>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageItem({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"}`}>
      <div className="chat-msg-role">{isUser ? "你" : "Agent"}</div>
      <div className="chat-bubble">
        {message.content}
        {streaming && <span className="chat-cursor" />}
        {message.usage && (
          <div className="chat-usage">
            {message.usage.input_tokens}+{message.usage.output_tokens} tok · ${message.usage.total_cost_usd?.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  );
}
