import React, { useEffect, useState } from "react";
import {
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Copy as CopyIcon,
  AlertCircle,
} from "lucide-react";
import { api, type AgentCallSummary, type AgentCallRecord } from "../hooks/useApi";
import { useToast } from "./Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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

  useEffect(() => {
    refresh();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId]);

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
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制");
    } catch {
      /* ignore */
    }
  };

  // 统计
  const total = calls.length;
  const totalInTokens = calls.reduce((a, c) => a + (c.usage?.input_tokens ?? 0), 0);
  const totalOutTokens = calls.reduce((a, c) => a + (c.usage?.output_tokens ?? 0), 0);
  const totalCost = calls.reduce((a, c) => a + (c.usage?.total_cost_usd ?? 0), 0);
  const totalErrors = calls.filter((c) => c.error).length;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Agent 调用</h3>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {loading && calls.length === 0 ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : calls.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          尚未记录 agent 调用。阶段函数里调用{" "}
          <code className="rounded bg-muted px-1 font-mono">agent.run()</code>{" "}
          后会自动记录 prompt / 响应 / token 用量。
        </p>
      ) : (
        <>
          {/* 统计条 */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              共 <strong className="font-semibold text-foreground">{total}</strong> 次调用
            </span>
            {totalErrors > 0 && (
              <span className="text-destructive">
                失败 <strong className="font-semibold">{totalErrors}</strong>
              </span>
            )}
            {totalInTokens > 0 && (
              <span className="text-muted-foreground">
                in{" "}
                <strong className="font-mono font-semibold text-foreground">
                  {fmtTokens(totalInTokens)}
                </strong>
              </span>
            )}
            {totalOutTokens > 0 && (
              <span className="text-muted-foreground">
                out{" "}
                <strong className="font-mono font-semibold text-foreground">
                  {fmtTokens(totalOutTokens)}
                </strong>
              </span>
            )}
            {totalCost > 0 && (
              <span className="text-muted-foreground">
                <strong className="font-mono font-semibold text-foreground">
                  {fmtUsd(totalCost)}
                </strong>
              </span>
            )}
          </div>

          {/* 调用列表 */}
          <div className="flex flex-col gap-2">
            {calls.map((c) => {
              const isOpen = expandedSeq === c.seq;
              return (
                <div
                  key={c.seq}
                  className={cn(
                    "rounded-md border bg-card text-sm transition-colors",
                    c.error && "border-destructive/40",
                    isOpen && "ring-1 ring-primary/20",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.seq)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent/40"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">#{c.seq}</span>
                      {c.phase && (
                        <Badge variant="info" className="font-mono text-[10px]">
                          {c.phase}
                        </Badge>
                      )}
                      <span className="font-mono text-xs text-primary">{c.agent}</span>
                      {c.model && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {c.model}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      {c.error && (
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <AlertCircle className="h-3 w-3" />
                          失败
                        </span>
                      )}
                      {c.elapsed_ms != null && <span>{fmtMs(c.elapsed_ms)}</span>}
                      {c.usage?.input_tokens != null && (
                        <span className="font-mono">in {fmtTokens(c.usage.input_tokens)}</span>
                      )}
                      {c.usage?.output_tokens != null && (
                        <span className="font-mono">out {fmtTokens(c.usage.output_tokens)}</span>
                      )}
                      {c.usage?.total_cost_usd != null && (
                        <span className="font-mono">{fmtUsd(c.usage.total_cost_usd)}</span>
                      )}
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </div>
                  </button>

                  <div className="border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span className="line-clamp-1">→ {c.prompt_preview || "(空 prompt)"}</span>
                  </div>

                  {isOpen && (
                    <div className="space-y-3 border-t p-3">
                      {!expanded ? (
                        <p className="text-xs text-muted-foreground">加载详情中…</p>
                      ) : expanded.seq === c.seq ? (
                        <>
                          {expanded.system_prompt && (
                            <AgentCallBlock
                              label="System prompt"
                              content={expanded.system_prompt}
                              onCopy={copy}
                            />
                          )}
                          {expanded.additional_system && (
                            <AgentCallBlock
                              label="Additional system"
                              content={expanded.additional_system}
                              onCopy={copy}
                            />
                          )}
                          <AgentCallBlock label="Prompt" content={expanded.prompt} onCopy={copy} />
                          {expanded.error ? (
                            <AgentCallBlock
                              label="Error"
                              content={expanded.error}
                              errorStyle
                              onCopy={copy}
                            />
                          ) : (
                            <AgentCallBlock
                              label="Response"
                              content={expanded.result_text ?? "(空)"}
                              onCopy={copy}
                            />
                          )}
                          <p className="text-[11px] text-muted-foreground">
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
    </Card>
  );
}

function AgentCallBlock({
  label,
  content,
  errorStyle,
  onCopy,
}: {
  label: string;
  content: string;
  errorStyle?: boolean;
  onCopy: (s: string) => void;
}) {
  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b bg-muted/30 px-2.5 py-1.5">
        <strong className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </strong>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => onCopy(content)}
        >
          <CopyIcon className="h-3 w-3" />
          复制
        </Button>
      </div>
      <pre
        className={cn(
          "scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed",
          errorStyle ? "text-destructive" : "text-foreground",
        )}
      >
        {content}
      </pre>
    </div>
  );
}
