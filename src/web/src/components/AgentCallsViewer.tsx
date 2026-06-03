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
    } catch (e: unknown) {
      toast.error("加载失败", (e as Error)?.message ?? String(e));
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
    } catch (e: unknown) {
      toast.error("加载详情失败", (e as Error)?.message ?? String(e));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制");
    } catch (e: unknown) {
      // 之前 silent：用户点复制按钮 → 啥也没发生，不知道成没成功。
      // 浏览器权限被拒（非 HTTPS / 无 user-gesture）时常见，告诉用户原因。
      toast.error("复制失败", (e as Error)?.message ?? "可能是浏览器拒绝了 clipboard 权限");
    }
  };

  // 统计
  const total = calls.length;
  const totalInTokens = calls.reduce((a, c) => a + (c.usage?.input_tokens ?? 0), 0);
  const totalOutTokens = calls.reduce((a, c) => a + (c.usage?.output_tokens ?? 0), 0);
  const totalCost = calls.reduce((a, c) => a + (c.usage?.total_cost_usd ?? 0), 0);
  const totalErrors = calls.filter((c) => c.error).length;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="bp-label">Agent 调用 · AGENT CALLS</span>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="p-4">
        {loading && calls.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            加载中…
          </p>
        ) : calls.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            尚未记录 agent 调用。阶段函数里调用{" "}
            <code className="border border-border bg-muted px-1">
              agent.run()
            </code>{" "}
            后会自动记录 prompt / 响应 / token 用量。
          </p>
        ) : (
          <>
            {/* 统计条：metadata 风格 */}
            <div className="mb-3 grid grid-cols-2 gap-0 border border-border font-mono text-[11px] sm:grid-cols-5">
              <StatCell label="CALLS" value={total} />
              <StatCell
                label="ERRORS"
                value={totalErrors}
                tone={totalErrors > 0 ? "destructive" : "default"}
              />
              <StatCell label="IN" value={fmtTokens(totalInTokens) || "0"} />
              <StatCell label="OUT" value={fmtTokens(totalOutTokens) || "0"} />
              <StatCell label="COST" value={totalCost > 0 ? fmtUsd(totalCost) : "—"} last />
            </div>

            {/* 调用列表 */}
            <div className="flex flex-col gap-2">
              {calls.map((c) => {
                const isOpen = expandedSeq === c.seq;
                return (
                  <div
                    key={c.seq}
                    className={cn(
                      "border border-border bg-card text-sm transition-all rounded-lg",
                      c.error && "border-destructive",
                      isOpen && "border-accent bp-shadow",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.seq)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-secondary/50"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">#{c.seq}</span>
                        {c.phase && <Badge variant="info">{c.phase}</Badge>}
                        <span className="font-mono text-xs text-accent">{c.agent}</span>
                        {c.model && (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {c.model}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
                        {c.error && (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle className="h-3 w-3" />
                            失败
                          </span>
                        )}
                        {c.elapsed_ms != null && <span>{fmtMs(c.elapsed_ms)}</span>}
                        {c.usage?.input_tokens != null && (
                          <span>in {fmtTokens(c.usage.input_tokens)}</span>
                        )}
                        {c.usage?.output_tokens != null && (
                          <span>out {fmtTokens(c.usage.output_tokens)}</span>
                        )}
                        {c.usage?.total_cost_usd != null && (
                          <span>{fmtUsd(c.usage.total_cost_usd)}</span>
                        )}
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </div>
                    </button>

                    <div className="border-t border-border bg-muted/20 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                      <span className="line-clamp-1">→ {c.prompt_preview || "（空提示词）"}</span>
                    </div>

                    {isOpen && (
                      <div className="space-y-3 border-t border-border p-3">
                        {!expanded ? (
                          <p className="font-mono text-xs text-muted-foreground">
                            加载详情中…
                          </p>
                        ) : expanded.seq === c.seq ? (
                          <>
                            {expanded.system_prompt && (
                              <AgentCallBlock
                                label="系统提示词"
                                content={expanded.system_prompt}
                                onCopy={copy}
                              />
                            )}
                            {expanded.additional_system && (
                              <AgentCallBlock
                                label="追加系统提示词"
                                content={expanded.additional_system}
                                onCopy={copy}
                              />
                            )}
                            <AgentCallBlock label="提示词" content={expanded.prompt} onCopy={copy} />
                            {expanded.error ? (
                              <AgentCallBlock
                                label="错误"
                                content={expanded.error}
                                errorStyle
                                onCopy={copy}
                              />
                            ) : (
                              <AgentCallBlock
                                label="响应"
                                content={expanded.result_text ?? "(空)"}
                                onCopy={copy}
                              />
                            )}
                            <p className="font-mono text-[10px] text-muted-foreground">
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
    </Card>
  );
}

function StatCell({
  label,
  value,
  tone = "default",
  last,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "destructive";
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 px-3 py-2 border-r border-border last:border-r-0",
        last && "border-r-0",
      )}
    >
      <span className="font-mono text-[10px] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-lg font-bold leading-none tabular-nums",
          tone === "destructive" ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
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
    <div className="border border-border bg-card rounded-lg">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2.5 py-1.5">
        <strong className="font-mono text-[10px] font-semibold text-muted-foreground">
          {label}
        </strong>
        <Button
          variant="ghost"
          size="sm"
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
