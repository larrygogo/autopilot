import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  MessageSquare,
  Plus,
  Send,
  Menu,
  Trash2,
  Bot,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  api,
  type ChatMessage,
  type ChatSessionManifest,
  type AgentItem,
} from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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
    if (!selected) {
      setMessages([]);
      return;
    }
    api
      .getSession(selected)
      .then((s) => {
        setMessages(s.messages);
        if (s.agent) setAgent(s.agent);
        setWorkflow(s.workflow ?? "");
      })
      .catch(() => {});
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
    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      ts: new Date().toISOString(),
    };
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
        if (prev.some((m) => m.ts === result.message.ts && m.role === "assistant"))
          return prev;
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
  const currentTitle =
    currentSession?.title || (selected ? selected.slice(0, 8) : "新对话");
  const currentAgent = currentSession?.agent || agent || "默认";
  const currentWorkflow = currentSession?.workflow || workflow;

  const sidebar = (
    <SessionList
      sessions={sessions}
      selected={selected}
      onNew={newChat}
      onSelect={selectSession}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar md:flex md:flex-col">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          {sidebar}
        </SheetContent>
      </Sheet>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开会话列表"
          >
            <Menu className="h-4 w-4" />
          </Button>

          <h2 className="truncate text-sm font-semibold tracking-tight">
            {currentTitle}
          </h2>

          <div className="ml-2 hidden min-w-0 flex-wrap items-center gap-1.5 sm:flex">
            {selected ? (
              <>
                <Badge variant="default" className="gap-1">
                  <Bot className="h-3 w-3" />
                  {currentAgent}
                </Badge>
                {currentWorkflow && (
                  <Badge variant="muted" className="gap-1">
                    <WorkflowIcon className="h-3 w-3" />
                    {currentWorkflow}
                  </Badge>
                )}
              </>
            ) : (
              <>
                <Select value={agent || "__default__"} onValueChange={(v) => setAgent(v === "__default__" ? "" : v)}>
                  <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs">
                    <Bot className="h-3 w-3 opacity-60" />
                    <SelectValue placeholder="默认 agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">默认 agent</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={workflow || "__none__"} onValueChange={(v) => setWorkflow(v === "__none__" ? "" : v)}>
                  <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs">
                    <WorkflowIcon className="h-3 w-3 opacity-60" />
                    <SelectValue placeholder="不限工作流" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不限工作流</SelectItem>
                    {workflows.map((w) => (
                      <SelectItem key={w.name} value={w.name}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          {selected && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={deleteCurrent}
              aria-label="删除对话"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="scrollbar-thin flex-1 overflow-y-auto px-4 py-6 md:px-6"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {messages.length === 0 && !streaming ? (
              <EmptyChat />
            ) : (
              <>
                {messages.map((m, i) => (
                  <MessageItem key={i} message={m} />
                ))}
                {streaming && (
                  <MessageItem
                    message={{ role: "assistant", content: streaming, ts: "" }}
                    streaming
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Input */}
        <div className="shrink-0 border-t bg-background px-4 py-3 md:px-6">
          <div className="relative mx-auto max-w-3xl">
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                const isMod = e.metaKey || e.ctrlKey;
                if (isMod && e.key === "Enter") {
                  e.preventDefault();
                  send();
                  return;
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !isMod &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入消息，Enter 发送（Shift+Enter 换行，⌘/Ctrl+Enter 也可发送）"
              rows={1}
              disabled={sending}
              className="min-h-[52px] resize-none pr-14 text-sm leading-relaxed"
            />
            <Button
              type="button"
              size="icon"
              className="absolute bottom-2 right-2 h-8 w-8"
              onClick={send}
              disabled={sending || !draft.trim()}
              aria-label="发送"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            Enter 发送 · Shift+Enter 换行
          </p>
        </div>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────
// Session list
// ──────────────────────────────────────────────

function SessionList({
  sessions,
  selected,
  onNew,
  onSelect,
}: {
  sessions: ChatSessionManifest[];
  selected: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button size="sm" className="w-full gap-1.5" onClick={onNew}>
          <Plus className="h-4 w-4" />
          新对话
        </Button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-xs text-muted-foreground">
            <MessageSquare className="h-6 w-6 opacity-40" />
            <span>暂无对话</span>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const active = selected === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-md border-l-2 border-transparent px-2.5 py-2 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className="w-full truncate text-sm font-medium">
                      {s.title || s.id.slice(0, 8)}
                    </span>
                    <span className="w-full truncate text-[11px] text-muted-foreground">
                      {s.agent}
                      {s.workflow ? ` · ${s.workflow}` : ""} · {s.message_count} 条
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Message item
// ──────────────────────────────────────────────

function MessageItem({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {isUser ? (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
            你
          </>
        ) : (
          <>
            <Bot className="h-3 w-3 text-primary" />
            Agent
          </>
        )}
      </div>
      <div
        className={cn(
          "whitespace-pre-wrap break-words rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed",
          isUser
            ? "border-primary/20 bg-primary/10 text-foreground"
            : "border-border bg-card text-card-foreground",
        )}
      >
        {message.content}
        {streaming && (
          <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-primary align-middle" />
        )}
        {message.usage && (
          <div className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">
            {message.usage.input_tokens}+{message.usage.output_tokens} tok · $
            {message.usage.total_cost_usd?.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Empty state
// ──────────────────────────────────────────────

function EmptyChat() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MessageSquare className="h-6 w-6" />
      </div>
      <div className="text-sm font-medium">开始一段新对话</div>
      <p className="max-w-sm text-xs text-muted-foreground">
        发一条消息问问 autopilot 能做什么，或让 agent 帮你查看任务和工作流。
      </p>
    </div>
  );
}
