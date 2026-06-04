import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Copy, FolderTree, FileText, Bot, History, Radio, Hand, Check, X, MessageCircleQuestion, Send, AlertTriangle, RotateCcw, Trash2, MousePointerClick } from "lucide-react";
import { api } from "@/hooks/useApi";
import { StatusBadge } from "@/components/StatusBadge";
import { LogTimeline } from "@/components/LogTimeline";
import { PhasePipeline, type PhasePipelineRunStatus } from "@/components/PhasePipeline";
import { PhaseDetailDrawer, type DrawerPhaseInfo, type PhaseRunStatus } from "@/components/PhaseDetailDrawer";
import { SandboxBrowser } from "@/components/SandboxBrowser";
import { PhaseLogsViewer } from "@/components/PhaseLogsViewer";
import { AgentCallsViewer } from "@/components/AgentCallsViewer";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { modShortcut } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { TaskProgressCard } from "@/components/TaskProgressCard";
import { TaskOutcomeCard } from "@/components/TaskOutcomeCard";
import { TaskPhaseTimeline } from "@/components/TaskPhaseTimeline";
import { useTaskPhaseEvents } from "@/hooks/useTaskPhaseEvents";
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
  const [drawerPhase, setDrawerPhase] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const liveLogRef = useRef<HTMLDivElement>(null);
  // 实时日志采用时间倒序（新在顶）；sticky = 保持停在顶部追最新
  const stickToTopRef = useRef(true);

  useEffect(() => {
    api.getTask(taskId).then(setTask).catch(() => {});
    api.getTaskLogs(taskId).then(setLogs).catch(() => {});
    stickToTopRef.current = true;
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

  const [phaseStats, setPhaseStats] = useState<Record<string, { count: number; p50_ms: number }> | undefined>(undefined);
  useEffect(() => {
    if (!task?.workflow) return;
    api.getWorkflowGraph(task.workflow).then(setGraph).catch(() => {});
    api.getWorkflow(task.workflow).then(setWorkflowDetail).catch(() => {});
    // 拉同 workflow 历史 phase 耗时 P50 — 给"还要多久"参考
    api.getWorkflowPhaseStats(task.workflow).then(setPhaseStats).catch(() => setPhaseStats(undefined));
  }, [task?.workflow]);

  const { events: phaseEvents, refresh: refreshPhaseEvents } = useTaskPhaseEvents(taskId);
  const workflowPhasesList = useMemo<string[]>(() => {
    const list = (workflowDetail?.phases as Array<{ name?: string }> | undefined) ?? [];
    return list.map((p) => p?.name ?? "").filter(Boolean);
  }, [workflowDetail]);

  useEffect(() => {
    if (!task?.status) return;
    refreshPhaseEvents().catch(() => {});
  }, [task?.status, refreshPhaseEvents]);

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
    if (!el || !stickToTopRef.current) return;
    el.scrollTop = 0;
  }, [liveLogs]);

  const onLogScroll = () => {
    const el = liveLogRef.current;
    if (!el) return;
    const atTop = el.scrollTop < 16;
    stickToTopRef.current = atTop;
  };

  const doCancel = async () => {
    try {
      await api.cancelTask(taskId);
      toast.success(`任务 ${taskId} 已请求取消`);
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setConfirmCancel(false);
    }
  };

  const doDelete = async () => {
    try {
      const res = await api.deleteTask(taskId);
      const extra = res.deleted.length > 1 ? `（连带子任务 ${res.deleted.length - 1} 个）` : "";
      toast.success(`任务 ${taskId} 已删除${extra}`);
      setConfirmDelete(false);
      onBack();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
      setConfirmDelete(false);
    }
  };

  const copyWorkspace = async () => {
    if (!task?.workspace) return;
    try {
      await navigator.clipboard.writeText(task.workspace);
      toast.success("已复制 workspace 路径");
    } catch (e: unknown) {
      toast.error("复制失败", (e as Error)?.message ?? "可能是浏览器拒绝了 clipboard 权限");
    }
  };

  // ⚠️ Hooks 必须在条件 return 之前调用，否则违反 hooks 顺序规则（React error #310）
  // 从 transition 日志推导每个 phase 的运行状态，喂给 PhasePipeline 显示角标。
  //
  // 关键：runner 没有 `<phase>_complete` 这种中间 to_status，phase 完成的
  // 信号是「to_status 跳出 running_<phase>」(下一个 phase 的 pending_X)。
  // 所以处理 running_X / pending_X / awaiting_X 切换时，先把当前还在
  // running 的其他 phase 全部标 done — 否则 design 一直留在 running，
  // 导致 design + review + develop 多个 phase 同时显示 spinner 角标，
  // 看上去全在 loading 状态（用户实际反馈的截图问题）。
  const phaseRunStatuses = useMemo<Record<string, PhasePipelineRunStatus>>(() => {
    const m: Record<string, PhasePipelineRunStatus> = {};
    if (!task) return m;

    const markPriorRunningDone = (currentPhase: string) => {
      for (const k of Object.keys(m)) {
        if (m[k] === "running" && k !== currentPhase) m[k] = "done";
      }
    };

    // logs 顺序：API 默认按 desc 返回；按时间正序处理
    const ordered = [...(logs as Array<{ to_status?: string }>)].reverse();
    for (const l of ordered) {
      const to = l?.to_status;
      if (!to) continue;
      if (to.startsWith("running_")) {
        const p = to.slice("running_".length);
        markPriorRunningDone(p);
        m[p] = "running";
      } else if (to.startsWith("pending_")) {
        const p = to.slice("pending_".length);
        markPriorRunningDone(p);
        if (!m[p] || m[p] === "idle") m[p] = "pending";
      } else if (to.startsWith("awaiting_")) {
        const p = to.slice("awaiting_".length);
        markPriorRunningDone(p);
        m[p] = "awaiting";
      } else if (to.startsWith("failed_")) {
        const p = to.slice("failed_".length);
        markPriorRunningDone(p);
        m[p] = "failed";
      } else if (to.endsWith("_complete")) {
        // 兼容老 transition（个别工作流可能 emit _complete）
        m[to.slice(0, -"_complete".length)] = "done";
      }
      // 其它 to_status（如 review_rejected）不直接映射 phase 状态，
      // 由后面的 pending_/running_ 切换接管
    }

    // 当前状态覆盖（防 log 滞后）
    const cur = task.status as string;
    if (cur.startsWith("running_")) {
      const p = cur.slice("running_".length);
      markPriorRunningDone(p);
      m[p] = "running";
    } else if (cur.startsWith("failed_")) {
      m[cur.slice("failed_".length)] = "failed";
    } else if (cur.startsWith("awaiting_")) {
      m[cur.slice("awaiting_".length)] = "awaiting";
    } else if (cur === "done") {
      // 终态：所有还在 running 的标 done
      for (const k of Object.keys(m)) {
        if (m[k] === "running") m[k] = "done";
      }
    } else if (cur === "cancelled" || cur === "canceled" || cur === "failed") {
      // 已取消 / 失败：把残留 running 清成 idle（之前是 running 现在不再跑了，
      // 既不算 done 也不算 failed，恢复中性视觉避免误以为还在转圈）
      for (const k of Object.keys(m)) {
        if (m[k] === "running") m[k] = "idle";
      }
    }
    return m;
  }, [logs, task]);

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

  // 从 workflowDetail.phases 中按名字找原始 phase 定义（含 parallel 子阶段）
  const findPhaseDef = (name: string): DrawerPhaseInfo | null => {
    const phases = (workflowDetail?.phases as any[] | undefined) ?? [];
    for (const p of phases) {
      if (p?.parallel) {
        for (const sub of (p.parallel.phases as any[] | undefined) ?? []) {
          if (sub?.name === name) return toDrawerPhase(sub);
        }
      } else if (p?.name === name) {
        return toDrawerPhase(p);
      }
    }
    return null;
  };

  const drawerPhaseDef = drawerPhase ? findPhaseDef(drawerPhase) : null;
  const drawerStatus = drawerPhase
    ? (phaseRunStatuses[drawerPhase] ?? "idle")
    : "idle";
  const drawerStartedAt = drawerPhase
    ? findPhaseStartTime(logs as Array<{ to_status?: string; created_at?: string }>, drawerPhase)
    : null;
  const drawerElapsedMs = drawerStartedAt && drawerStatus === "running"
    ? Date.now() - new Date(drawerStartedAt).getTime()
    : undefined;
  const drawerErrorMessage = drawerStatus === "failed"
    ? (([...(logs ?? [])].reverse() as Array<{ note?: string }>).find((l) => l?.note)?.note ?? undefined)
    : undefined;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
      {/* Header — task.id 是主标识（大字 mono），eyebrow 缩到 bp-label，状态推到行尾跟操作组一起 */}
      <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft className="h-4 w-4" />
          返回
        </Button>
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[10px] text-muted-foreground">
            TASK
          </span>
          <h2 className="truncate font-mono text-xl font-bold text-foreground sm:text-2xl">
            {task.id}
          </h2>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatusBadge status={task.status} />
        </div>
        {canCancel && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const r = await api.restartTask(taskId);
                  toast.success(`已重启 · 从 ${r.phase} 阶段重新执行`);
                } catch (e: unknown) {
                  toast.error("重启失败", (e as Error)?.message ?? String(e));
                }
              }}
              title="把任务从当前阶段重新执行（绕过状态机；用于 dangling / 卡死 救援）"
            >
              <RotateCcw className="h-4 w-4" />
              重新执行
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmCancel(true)}
            >
              取消任务
            </Button>
          </div>
        )}
      </div>

      {isTerminal(task.status, graph?.terminalStates) && (
        <TaskOutcomeCard
          taskId={task.id}
          reloadKey={task.status}
          requirementId={(task as { requirement_id?: string }).requirement_id ?? null}
          workflow={task.workflow}
          taskStatus={task.status}
        />
      )}

      {/* 来源需求卡片（task.requirement_id 存在时显示） */}
      {task.requirement_id && (
        <Card className="mb-3 border-l-4 border-l-accent/60 px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-mono text-[10px] text-muted-foreground">
                来自需求
              </span>
              <Link
                to={`/requirements/${task.requirement_id}`}
                className="ml-2 font-mono text-sm text-accent hover:underline"
              >
                {task.requirement_id}
              </Link>
            </div>
            <Link
              to={`/requirements/${task.requirement_id}`}
              className="font-mono text-[10px] text-accent hover:underline"
            >
              看完整需求 →
            </Link>
          </div>
        </Card>
      )}

      {/* 任务状态摘要（当前阶段 / 耗时 / 失败原因） */}
      <TaskProgressCard taskId={taskId} showDetailLink={false} showActions={false} />

      <TaskPhaseTimeline workflowPhases={workflowPhasesList} events={phaseEvents} phaseStats={phaseStats} />

      {task.dangling && task.status?.startsWith("running_") && (
        <DanglingBanner taskId={taskId} toast={toast} />
      )}

      {awaitingPhase && (
        <GateBanner
          taskId={taskId}
          phase={awaitingPhase}
          phaseLabel={gatePhaseDef?.label}
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

      {/* 基本信息 — metadata block 风 */}
      <Card className="mb-4">
        <div className="border-b border-border px-4 py-2.5">
          <span className="bp-label">基本信息 · METADATA</span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          <Field label="ID">
            <code className="font-mono text-accent">{task.id}</code>
          </Field>
          <Field label="标题">{task.title}</Field>
          <Field label="工作流">
            {workflowDetail?.label ? (
              <span className="flex items-baseline gap-2 min-w-0">
                <span className="truncate">{workflowDetail.label}</span>
                <code className="font-mono text-[10px] text-muted-foreground truncate">
                  {task.workflow}
                </code>
              </span>
            ) : (
              <code className="font-mono">{task.workflow}</code>
            )}
          </Field>
          <Field label="状态">
            <StatusBadge status={task.status} />
          </Field>
          <Field label="创建时间">{new Date(task.created_at).toLocaleString()}</Field>
          <Field label="更新时间">{new Date(task.updated_at).toLocaleString()}</Field>
        </dl>
        {task.requirement && (
          <details className="mx-4 mb-4 border-t border-border pt-3 text-sm">
            <summary className="cursor-pointer select-none bp-label">
              需求详情（{task.requirement.length} 字符）
            </summary>
            <pre className="scrollbar-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/40 p-3 font-mono text-xs">
              {task.requirement}
            </pre>
          </details>
        )}
        {task.workspace && (
          <div className="mx-4 mb-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
            <span className="bp-label">Workspace</span>
            <code
              className="flex-1 cursor-pointer break-all border border-border bg-muted px-2 py-1 font-mono text-foreground"
              title="点击复制"
              onClick={copyWorkspace}
            >
              {task.workspace}
            </code>
            <Button size="icon" variant="ghost" onClick={copyWorkspace} aria-label="复制路径">
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Card>

      {/* 流水线（点击节点弹详情） */}
      {workflowDetail?.phases && (
        <Card className="mb-4">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="bp-label">流水线 · PIPELINE</span>
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
              <MousePointerClick className="h-3 w-3" />
              点击节点查看阶段状态
            </span>
          </div>
          <div className="p-4">
            <PhasePipeline
              phases={workflowDetail.phases}
              highlight={hoveredPhase}
              onHoverPhase={setHoveredPhase}
              currentState={task.status}
              phaseStatuses={phaseRunStatuses}
              onPhaseClick={setDrawerPhase}
            />
          </div>
        </Card>
      )}

      {/* Tabs */}
      <TaskDetailTabs
        taskId={taskId}
        taskStatus={task.status}
        logs={logs}
        liveLogs={liveLogs}
        liveLogRef={liveLogRef}
        stickToTopRef={stickToTopRef}
        onLogScroll={onLogScroll}
      />

      {/* 危险操作区 */}
      <Card className="mt-4 border border-destructive bg-destructive/8">
        <div className="border-b border-destructive/40 px-4 py-2.5">
          <span className="font-mono text-[10px] text-destructive font-semibold">
            ⚠ 危险操作 · DANGER ZONE
          </span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground leading-relaxed">
              彻底删除该任务的 DB 记录、manifest、阶段日志、agent 调用记录与 workspace 文件；此操作不可撤销。
              {canCancel && (
                <span className="ml-1 font-semibold text-foreground">
                  任务当前非终态，请先取消后再删除。
                </span>
              )}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={canCancel}
          >
            <Trash2 className="h-4 w-4" />
            删除任务
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        title="删除任务"
        danger
        confirmText="永久删除"
        cancelText="取消"
        message={
          <div className="space-y-2">
            <p>
              确认永久删除任务{" "}
              <code className="rounded bg-muted px-1 font-mono">{task.id}</code>？
            </p>
            <p className="text-xs text-muted-foreground">
              将清理：DB 记录、task-manifest、阶段日志、agent 调用、workspace 目录，以及所有子任务。操作不可撤销。
            </p>
          </div>
        }
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
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

      <PhaseDetailDrawer
        mode="status"
        open={!!drawerPhase}
        onOpenChange={(o) => { if (!o) setDrawerPhase(null); }}
        phase={drawerPhaseDef}
        runStatus={drawerStatus as PhaseRunStatus}
        elapsedMs={drawerElapsedMs}
        errorMessage={drawerErrorMessage}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  );
}

// 把 workflowDetail.phases 中的 raw phase 对象规整成 drawer 用的字段
function toDrawerPhase(p: Record<string, unknown>): DrawerPhaseInfo {
  return {
    name: String(p.name ?? ""),
    label: typeof p.label === "string" ? p.label : undefined,
    agent: typeof p.agent === "string" ? p.agent : undefined,
    timeout: typeof p.timeout === "number" ? p.timeout : undefined,
    reject: typeof p.reject === "string" ? p.reject : null,
    gate: p.gate === true,
    gate_message: typeof p.gate_message === "string" ? p.gate_message : undefined,
    max_rejections: typeof p.max_rejections === "number" ? p.max_rejections : undefined,
    jump_trigger: typeof p.jump_trigger === "string" ? p.jump_trigger : undefined,
    jump_target: typeof p.jump_target === "string" ? p.jump_target : undefined,
  };
}

// 找到某 phase 最近一次进入 running 的时间戳
function findPhaseStartTime(
  logs: Array<{ to_status?: string; created_at?: string }>,
  phase: string,
): string | null {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const l = logs[i];
    if (l?.to_status === `running_${phase}` && l.created_at) return l.created_at;
  }
  return null;
}

// ──────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────

type DetailTab = "workspace" | "phase-logs" | "agent-calls" | "transitions" | "live";

interface TaskDetailTabsProps {
  taskId: string;
  /** 当前任务状态，传给 PhaseLogsViewer 用来判定选中 phase 是否还在跑 */
  taskStatus?: string;
  logs: any[];
  liveLogs: string[];
  liveLogRef: React.RefObject<HTMLDivElement | null>;
  stickToTopRef: React.MutableRefObject<boolean>;
  onLogScroll: () => void;
}

function TaskDetailTabs({
  taskId,
  taskStatus,
  logs,
  liveLogs,
  liveLogRef,
  stickToTopRef,
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
    { key: "workspace", label: "工作区", icon: FolderTree },
    { key: "phase-logs", label: "阶段日志", icon: FileText },
    { key: "agent-calls", label: "Agent 调用", icon: Bot },
    { key: "transitions", label: "状态日志", icon: History, badge: logs.length || undefined },
    { key: "live", label: "实时日志", icon: Radio, badge: unreadLive || undefined },
  ];

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
      <TabsList className="scrollbar-thin mb-3 flex h-auto w-full justify-start overflow-x-auto">
        {triggers.map((t) => (
          <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <Badge variant="default" className="ml-1 px-1.5 py-0">
                {t.badge}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="workspace" className="mt-0">
        <SandboxBrowser taskId={taskId} />
      </TabsContent>

      <TabsContent value="phase-logs" className="mt-0">
        <PhaseLogsViewer taskId={taskId} taskStatus={taskStatus} />
      </TabsContent>

      <TabsContent value="agent-calls" className="mt-0">
        <AgentCallsViewer taskId={taskId} />
      </TabsContent>

      <TabsContent value="transitions" className="mt-0">
        <Card>
          <div className="border-b border-border px-4 py-2.5">
            <span className="bp-label">状态日志 · TRANSITIONS</span>
          </div>
          <div className="p-4">
            <LogTimeline logs={logs} />
          </div>
        </Card>
      </TabsContent>

      <TabsContent value="live" className="mt-0">
        <Card>
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="bp-label">实时日志 · LIVE STREAM</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {liveLogs.length === 0
                ? "暂无；运行中任务会推送到此"
                : stickToTopRef.current
                ? "自动跟随中（向下滚暂停）"
                : "手动暂停（滚回顶部恢复）"}
            </span>
          </div>
          <div className="p-4">
            <div
              ref={liveLogRef}
              onScroll={onLogScroll}
              className="scrollbar-thin max-h-80 overflow-auto border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
            >
              {liveLogs.length === 0 ? (
                <p className="text-muted-foreground">等待中…</p>
              ) : (
                liveLogs
                  .slice()
                  .reverse()
                  .map((line, i) => (
                    <div key={liveLogs.length - 1 - i} className="whitespace-pre text-foreground">
                      {line}
                    </div>
                  ))
              )}
            </div>
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
  const [busy, setBusy] = useState<"cancel" | "restart" | null>(null);

  const restart = async () => {
    setBusy("restart");
    try {
      const r = await api.restartTask(taskId);
      toast.success(`已重新执行 · 从 ${r.phase} 阶段重启`);
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelTask = async () => {
    setBusy("cancel");
    try {
      await api.cancelTask(taskId);
      toast.success("已取消该 dangling task");
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4 border border-destructive bg-destructive/8">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-destructive bg-destructive/15 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-destructive">
            ⚠ 这个任务已死（daemon 重启）
          </h3>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            任务在 <code className="border border-border bg-muted px-1 font-mono">ask_user</code> 等待回答时 daemon 重启了。
            agent 进程的等待 promise 在内存中丢失，即使你现在回答 agent 也收不到。
            可以选择：<strong className="text-foreground">重新执行</strong>当前阶段（沿用原 workspace 历史从头跑），或
            <strong className="text-foreground">取消任务</strong>新建一个。
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <Button
            size="sm"
            variant="outline"
            onClick={restart}
            disabled={!!busy}
          >
            <RotateCcw className="h-4 w-4" />
            {busy === "restart" ? "重启中…" : "重新执行"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={cancelTask}
            disabled={!!busy}
          >
            {busy === "cancel" ? "处理中…" : "取消任务"}
          </Button>
        </div>
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
    } catch (e: unknown) {
      toast.error("回答失败", (e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4 border border-info bg-info/8">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-info bg-info/15 text-info">
          <MessageCircleQuestion className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-bold text-info">
              Agent 在等你回答
            </h3>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{parsed.question}</p>
            {parsed.phase && (
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                来自阶段 <code className="border border-border bg-muted px-1">{parsed.phase}</code>
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
                placeholder={`在这里写你的回答…（${modShortcut("Enter")} 提交）`}
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
  phaseLabel,
  gateMessage,
  toast,
}: {
  taskId: string;
  phase: string;
  /** 来自工作流 yaml 的业务标签，如「设计评审」；缺省时只显示 phase name */
  phaseLabel?: string;
  gateMessage?: string;
  toast: ReturnType<typeof useToast>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"pass" | "reject" | "cancel" | null>(null);

  // 把 awaiting_<phase> / running_<phase> 这种 status 翻成中文
  // 业务标签优先；同时把原 trigger 名暴露在 ()里供懂行的反查
  const decisionLabelOf = (s: string): string => {
    if (s.startsWith("awaiting_")) return phaseLabel ? `等待${phaseLabel}` : `等待·${s.slice(9)}`;
    if (s.startsWith("running_")) return phaseLabel ? `运行${phaseLabel}` : `运行·${s.slice(8)}`;
    if (s.startsWith("pending_")) return phaseLabel ? `准备${phaseLabel}` : `准备·${s.slice(8)}`;
    if (s.startsWith("failed_")) return phaseLabel ? `${phaseLabel}失败` : `失败·${s.slice(7)}`;
    if (s === "done") return "完成";
    if (s === "cancelled") return "已取消";
    return s;
  };

  const decide = async (decision: "pass" | "reject" | "cancel") => {
    if (decision === "reject" && !note.trim()) {
      toast.warning("驳回需要填写理由");
      return;
    }
    setBusy(decision);
    try {
      const r = await api.decideTask(taskId, decision, note.trim() || undefined);
      const verb = decision === "pass" ? "通过" : decision === "reject" ? "驳回" : "取消";
      // 业务标签 + 内核 trigger 同时显示，让放松的自己读得顺、懂行的自己能反查
      toast.success(
        `已${verb} · ${decisionLabelOf(r.from)} → ${decisionLabelOf(r.to)} (${r.from} → ${r.to})`,
      );
      setNote("");
    } catch (e: unknown) {
      toast.error(`${decision} 失败`, (e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-4 border border-warning bg-warning/8">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-warning bg-warning/15 text-warning">
          <Hand className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <h3 className="text-sm font-bold text-warning">
              ✋ 等待你拍板{phaseLabel ? `：${phaseLabel}` : ""}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              阶段 {phaseLabel ? (
                <>
                  <span className="font-semibold text-foreground">{phaseLabel}</span>
                  <span className="ml-1 opacity-60">(</span>
                  <code className="border border-border bg-muted px-1 font-mono">{phase}</code>
                  <span className="opacity-60">)</span>
                </>
              ) : (
                <code className="border border-border bg-muted px-1 font-mono">{phase}</code>
              )} 已完成。
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
