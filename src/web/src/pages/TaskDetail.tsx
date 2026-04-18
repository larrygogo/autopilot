import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, FolderTree, FileText, Bot, History, Radio, Hand, Check, X, MessageCircleQuestion, Send, AlertTriangle } from "lucide-react";
import { api } from "@/hooks/useApi";
import { StatusBadge } from "@/components/StatusBadge";
import { LogTimeline } from "@/components/LogTimeline";
import { StateMachineGraph } from "@/components/StateMachineGraph";
import { PhasePipeline } from "@/components/PhasePipeline";
import { WorkspaceBrowser } from "@/components/WorkspaceBrowser";
import { PhaseLogsViewer } from "@/components/PhaseLogsViewer";
import { AgentCallsViewer } from "@/components/AgentCallsViewer";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

const TERMINAL_STATES = new Set(["done", "cancelled", "failed", "canceled"]);

function isTerminal(status: string, graphTerminals?: string[]): boolean {
  if (TERMINAL_STATES.has(status)) return true;
  if (graphTerminals?.includes(status)) return true;
  return false;
}

export function TaskDetail({ taskId, onBack, subscribe }: TaskDetailProps) {
  const toast = useToast();
  const [task, setTask] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [graph, setGraph] = useState<any>(null);
  const [workflowDetail, setWorkflowDetail] = useState<any>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const liveLogRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    api.getTask(taskId).then(setTask).catch(() => {});
    api.getTaskLogs(taskId).then(setLogs).catch(() => {});
    stickToBottomRef.current = true;
    setLiveLogs([]);

    // baseline：拉所有阶段日志的最近 50 行作为初始内容，避免实时日志一片空白
    (async () => {
      try {
        const phases = await api.getPhaseLogsList(taskId);
        const ordered = [...phases].sort((a, b) => a.mtime - b.mtime);
        const lines: string[] = [];
        for (const p of ordered) {
          try {
            const { content } = await api.getPhaseLog(taskId, p.phase, 50);
            for (const line of content.split("\n")) {
              if (line.trim()) lines.push(line);
            }
          } catch {
            /* ignore */
          }
        }
        if (lines.length) setLiveLogs(lines.slice(-300));
      } catch {
        /* ignore */
      }
    })();
  }, [taskId]);

  useEffect(() => {
    if (!task?.workflow) return;
    api.getWorkflowGraph(task.workflow).then(setGraph).catch(() => {});
    api.getWorkflow(task.workflow).then(setWorkflowDetail).catch(() => {});
  }, [task?.workflow]);

  useEffect(() => {
    const unsub1 = subscribe(`task:${taskId}`, () => {
      api.getTask(taskId).then(setTask).catch(() => {});
      api.getTaskLogs(taskId).then(setLogs).catch(() => {});
    });
    const unsub2 = subscribe(`log:${taskId}`, (event: any) => {
      if (event.type === "log:entry") {
        setLiveLogs((prev) => [...prev.slice(-500), event.payload.message]);
      }
    });
    return () => {
      unsub1();
      unsub2();
    };
  }, [taskId, subscribe]);

  useEffect(() => {
    const el = liveLogRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [liveLogs]);

  const onLogScroll = () => {
    const el = liveLogRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    stickToBottomRef.current = atBottom;
  };

  const doCancel = async () => {
    try {
      await api.cancelTask(taskId);
      toast.success(`任务 ${taskId} 已请求取消`);
    } catch (e: any) {
      toast.error("取消失败", e?.message ?? String(e));
    } finally {
      setConfirmCancel(false);
    }
  };

  const copyWorkspace = async () => {
    if (!task?.workspace) return;
    try {
      await navigator.clipboard.writeText(task.workspace);
      toast.success("已复制 workspace 路径");
    } catch {
      /* ignore */
    }
  };

  if (!task) {
    return (
      <div className="mx-auto w-full max-w-6xl px-5 py-8 text-sm text-muted-foreground">加载中…</div>
    );
  }

  const canCancel = !isTerminal(task.status, graph?.terminalStates);
  const awaitingPhase = task.status.startsWith("awaiting_") ? task.status.slice("awaiting_".length) : null;
  const gatePhaseDef = awaitingPhase
    ? (workflowDetail?.phases as any[] | undefined)?.find((p) => p?.name === awaitingPhase)
    : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft className="h-4 w-4" />
          返回
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-xl font-semibold tracking-tight">任务</h2>
          <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-primary">
            {task.id}
          </code>
          <StatusBadge status={task.status} />
        </div>
        {canCancel && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            onClick={() => setConfirmCancel(true)}
          >
            取消任务
          </Button>
        )}
      </div>

      {task.dangling && task.status?.startsWith("running_") && (
        <DanglingBanner taskId={taskId} toast={toast} />
      )}

      {awaitingPhase && (
        <GateBanner
          taskId={taskId}
          phase={awaitingPhase}
          gateMessage={gatePhaseDef?.gate_message}
          toast={toast}
        />
      )}

      {task.pending_question && !task.dangling && (
        <AskBanner
          taskId={taskId}
          rawQuestion={task.pending_question as string}
          toast={toast}
        />
      )}

      {/* 基本信息 */}
      <Card className="mb-4 p-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="ID">
            <code className="font-mono text-primary">{task.id}</code>
          </Field>
          <Field label="标题">{task.title}</Field>
          <Field label="工作流">
            <code className="font-mono">{task.workflow}</code>
          </Field>
          <Field label="状态">
            <StatusBadge status={task.status} />
          </Field>
          <Field label="创建时间">{new Date(task.created_at).toLocaleString()}</Field>
          <Field label="更新时间">{new Date(task.updated_at).toLocaleString()}</Field>
        </dl>
        {task.requirement && (
          <details className="mt-3 border-t pt-3 text-sm">
            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
              需求详情（{task.requirement.length} 字符）
            </summary>
            <pre className="scrollbar-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs">
              {task.requirement}
            </pre>
          </details>
        )}
        {task.workspace && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
            <span className="text-muted-foreground">Workspace：</span>
            <code
              className="flex-1 cursor-pointer break-all rounded bg-muted px-2 py-1 font-mono text-foreground"
              title="点击复制"
              onClick={copyWorkspace}
            >
              {task.workspace}
            </code>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={copyWorkspace} aria-label="复制路径">
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Card>

      {/* 流水线 */}
      {workflowDetail?.phases && (
        <Card className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">流水线</h3>
          <PhasePipeline
            phases={workflowDetail.phases}
            highlight={hoveredPhase}
            onHoverPhase={setHoveredPhase}
            currentState={task.status}
          />
        </Card>
      )}

      {/* 状态机 */}
      {graph && (
        <Card className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">状态机</h3>
          <StateMachineGraph
            nodes={graph.nodes}
            edges={graph.edges}
            currentState={task.status}
            highlightPhase={hoveredPhase}
            onHoverPhase={setHoveredPhase}
          />
        </Card>
      )}

      {/* Tabs */}
      <TaskDetailTabs
        taskId={taskId}
        logs={logs}
        liveLogs={liveLogs}
        liveLogRef={liveLogRef}
        stickToBottomRef={stickToBottomRef}
        onLogScroll={onLogScroll}
      />

      <ConfirmDialog
        open={confirmCancel}
        title="取消任务"
        message={
          <span>
            确认取消任务 <code className="rounded bg-muted px-1 font-mono">{task.id}</code>？正在运行的阶段将被中止。
          </span>
        }
        confirmText="取消任务"
        cancelText="继续运行"
        danger
        onConfirm={doCancel}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  );
}

// ──────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────

type DetailTab = "workspace" | "phase-logs" | "agent-calls" | "transitions" | "live";

interface TaskDetailTabsProps {
  taskId: string;
  logs: any[];
  liveLogs: string[];
  liveLogRef: React.RefObject<HTMLDivElement | null>;
  stickToBottomRef: React.MutableRefObject<boolean>;
  onLogScroll: () => void;
}

function TaskDetailTabs({
  taskId,
  logs,
  liveLogs,
  liveLogRef,
  stickToBottomRef,
  onLogScroll,
}: TaskDetailTabsProps) {
  const [tab, setTab] = useState<DetailTab>("workspace");

  const [unreadLive, setUnreadLive] = useState(0);
  const prevLiveLenRef = useRef(liveLogs.length);
  useEffect(() => {
    const grew = liveLogs.length - prevLiveLenRef.current;
    prevLiveLenRef.current = liveLogs.length;
    if (grew > 0 && tab !== "live") setUnreadLive((n) => n + grew);
    if (tab === "live") setUnreadLive(0);
  }, [liveLogs.length, tab]);

  const triggers: Array<{ key: DetailTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }> = [
    { key: "workspace", label: "Workspace", icon: FolderTree },
    { key: "phase-logs", label: "阶段日志", icon: FileText },
    { key: "agent-calls", label: "Agent 调用", icon: Bot },
    { key: "transitions", label: "状态日志", icon: History, badge: logs.length || undefined },
    { key: "live", label: "实时日志", icon: Radio, badge: unreadLive || undefined },
  ];

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
      <TabsList className="scrollbar-thin mb-3 flex h-auto w-full justify-start overflow-x-auto bg-transparent p-0 border-b rounded-none">
        {triggers.map((t) => (
          <TabsTrigger
            key={t.key}
            value={t.key}
            className="h-9 gap-1.5 rounded-none border-b-2 border-transparent bg-transparent px-3 text-sm text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <Badge variant="default" className="ml-1 h-4 px-1.5 text-[10px]">
                {t.badge}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="workspace" className="mt-0">
        <WorkspaceBrowser taskId={taskId} />
      </TabsContent>

      <TabsContent value="phase-logs" className="mt-0">
        <PhaseLogsViewer taskId={taskId} />
      </TabsContent>

      <TabsContent value="agent-calls" className="mt-0">
        <AgentCallsViewer taskId={taskId} />
      </TabsContent>

      <TabsContent value="transitions" className="mt-0">
        <Card className="p-4">
          <LogTimeline logs={logs} />
        </Card>
      </TabsContent>

      <TabsContent value="live" className="mt-0">
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">实时日志</h3>
            <span className="text-xs text-muted-foreground">
              {liveLogs.length === 0
                ? "暂无；运行中任务会推送到此"
                : stickToBottomRef.current
                ? "自动跟随中（滚到顶暂停）"
                : "手动暂停（滚到底恢复）"}
            </span>
          </div>
          <div
            ref={liveLogRef}
            onScroll={onLogScroll}
            className="scrollbar-thin max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
          >
            {liveLogs.length === 0 ? (
              <p className="text-muted-foreground">等待中…</p>
            ) : (
              liveLogs.map((line, i) => (
                <div key={i} className="whitespace-pre text-foreground">
                  {line}
                </div>
              ))
            )}
          </div>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

// ──────────────────────────────────────────────
// Dangling banner — daemon 重启后 agent 已死，task 仍卡在 running 状态
// ──────────────────────────────────────────────

function DanglingBanner({
  taskId,
  toast,
}: {
  taskId: string;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);

  const cancelTask = async () => {
    setBusy(true);
    try {
      await api.cancelTask(taskId);
      toast.success("已取消该 dangling task");
    } catch (e: any) {
      toast.error("取消失败", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4 border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-destructive">这个任务已死（daemon 重启）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            任务在 <code className="rounded bg-muted px-1 font-mono">ask_user</code> 等待回答时 daemon 重启了。
            agent 进程的等待 promise 在内存中丢失，即使你现在回答 agent 也收不到。
            <br />
            建议：取消该任务并重新创建。下次让 daemon 升级时尽量等所有 ask_user 答完。
          </p>
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="shrink-0"
          onClick={cancelTask}
          disabled={busy}
        >
          {busy ? "处理中…" : "取消任务"}
        </Button>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
// Ask banner — agent 调 ask_user 工具时显示，等用户回答
// ──────────────────────────────────────────────

function AskBanner({
  taskId,
  rawQuestion,
  toast,
}: {
  taskId: string;
  rawQuestion: string;
  toast: ReturnType<typeof useToast>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  let parsed: { question: string; options: string[] | null; phase?: string; asked_at?: string };
  try {
    parsed = JSON.parse(rawQuestion);
  } catch {
    parsed = { question: rawQuestion, options: null };
  }

  const submit = async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) {
      toast.warning("回答不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.answerTask(taskId, trimmed);
      toast.success("已回答");
      setText("");
    } catch (e: any) {
      toast.error("回答失败", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4 border-info/40 bg-info/5 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-info/15 text-info">
          <MessageCircleQuestion className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Agent 在等你回答</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{parsed.question}</p>
            {parsed.phase && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                来自阶段 <code className="rounded bg-muted px-1 font-mono">{parsed.phase}</code>
              </p>
            )}
          </div>

          {parsed.options && parsed.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {parsed.options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant="outline"
                  onClick={() => submit(opt)}
                  disabled={busy}
                  className="border-info/40 hover:bg-info/10 hover:text-foreground"
                >
                  {opt}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="在这里写你的回答…（⌘/Ctrl + Enter 提交）"
                className="min-h-[60px] flex-1 text-xs font-mono"
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(text);
                }}
              />
              <Button
                size="sm"
                onClick={() => submit(text)}
                disabled={busy || !text.trim()}
                className="self-end"
              >
                <Send className="h-4 w-4" />
                {busy ? "发送中…" : "发送"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
// Gate banner — awaiting_<phase> 时顶部出现，等待用户决断
// ──────────────────────────────────────────────

function GateBanner({
  taskId,
  phase,
  gateMessage,
  toast,
}: {
  taskId: string;
  phase: string;
  gateMessage?: string;
  toast: ReturnType<typeof useToast>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"pass" | "reject" | "cancel" | null>(null);

  const decide = async (decision: "pass" | "reject" | "cancel") => {
    if (decision === "reject" && !note.trim()) {
      toast.warning("驳回需要填写理由");
      return;
    }
    setBusy(decision);
    try {
      const r = await api.decideTask(taskId, decision, note.trim() || undefined);
      const verb = decision === "pass" ? "通过" : decision === "reject" ? "驳回" : "取消";
      toast.success(`已${verb} · ${r.from} → ${r.to}`);
      setNote("");
    } catch (e: any) {
      toast.error(`${decision} 失败`, e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4 border-warning/40 bg-warning/5 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <Hand className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h3 className="text-sm font-semibold">等待你的决断</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              阶段 <code className="rounded bg-muted px-1 font-mono">{phase}</code> 已完成。
              {gateMessage ? (
                <> {gateMessage}</>
              ) : (
                <> 切到 Workspace tab 查看 <code className="font-mono">agent-trace.md</code> 后再决断。</>
              )}
            </p>
          </div>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注 / 驳回理由（驳回必填，agent 重做时会读取）…"
            className="min-h-[72px] text-xs font-mono"
            disabled={!!busy}
          />
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
          <Button
            size="sm"
            onClick={() => decide("pass")}
            disabled={!!busy}
          >
            <Check className="h-4 w-4" />
            {busy === "pass" ? "处理中…" : "通过"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => decide("reject")}
            disabled={!!busy || !note.trim()}
            title={!note.trim() ? "驳回需要填写理由" : undefined}
          >
            <X className="h-4 w-4" />
            {busy === "reject" ? "处理中…" : "驳回"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
