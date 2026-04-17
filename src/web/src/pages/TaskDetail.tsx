import React, { useEffect, useRef, useState } from "react";
import { api } from "../hooks/useApi";
import { Badge } from "../components/Badge";
import { LogTimeline } from "../components/LogTimeline";
import { StateMachineGraph } from "../components/StateMachineGraph";
import { PhasePipeline } from "../components/PhasePipeline";
import { WorkspaceBrowser } from "../components/WorkspaceBrowser";
import { PhaseLogsViewer } from "../components/PhaseLogsViewer";
import { AgentCallsViewer } from "../components/AgentCallsViewer";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toast";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

// 终态清单：与后端 workflow.terminal_states 对齐；至少包含通用的两个
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

  // 日志自动滚动：用户手动上滑时暂停；回到底部或新任务时恢复
  const liveLogRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    api.getTask(taskId).then(setTask).catch(() => {});
    api.getTaskLogs(taskId).then(setLogs).catch(() => {});
    stickToBottomRef.current = true;
    setLiveLogs([]);
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
    return () => { unsub1(); unsub2(); };
  }, [taskId, subscribe]);

  // 有新日志进来时，若用户仍粘在底部，滚到底
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

  if (!task) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  const canCancel = !isTerminal(task.status, graph?.terminalStates);

  return (
    <div className="container">
      <div className="page-hdr">
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <h2>任务: {task.id}</h2>
        {canCancel && (
          <button
            className="btn btn-danger"
            style={{ marginLeft: "auto" }}
            onClick={() => setConfirmCancel(true)}
          >
            取消任务
          </button>
        )}
      </div>

      <div className="card">
        <div className="task-info-grid">
          <div><span className="muted">ID：</span><span className="mono">{task.id}</span></div>
          <div><span className="muted">标题：</span>{task.title}</div>
          <div><span className="muted">工作流：</span>{task.workflow}</div>
          <div><span className="muted">状态：</span><Badge status={task.status} /></div>
          <div><span className="muted">创建时间：</span>{new Date(task.created_at).toLocaleString()}</div>
          <div><span className="muted">更新时间：</span>{new Date(task.updated_at).toLocaleString()}</div>
        </div>
        {task.workspace && (
          <div style={{ marginTop: "0.6rem", fontSize: "0.8rem" }}>
            <span className="muted">Workspace：</span>
            <code
              className="mono"
              style={{ cursor: "pointer", userSelect: "all", wordBreak: "break-all" }}
              title="点击复制路径"
              onClick={async () => {
                try { await navigator.clipboard.writeText(task.workspace); } catch { /* ignore */ }
              }}
            >
              {task.workspace}
            </code>
          </div>
        )}
      </div>

      {workflowDetail?.phases && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <h3>流水线</h3>
          <PhasePipeline
            phases={workflowDetail.phases}
            highlight={hoveredPhase}
            onHoverPhase={setHoveredPhase}
            currentState={task.status}
          />
        </div>
      )}

      {graph && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <h3>状态机</h3>
          <div className="graph-wrap">
            <StateMachineGraph
              nodes={graph.nodes}
              edges={graph.edges}
              currentState={task.status}
              highlightPhase={hoveredPhase}
              onHoverPhase={setHoveredPhase}
            />
          </div>
        </div>
      )}

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
        message={<span>确认取消任务 <code className="mono">{task.id}</code>？正在运行的阶段将被中止。</span>}
        confirmText="取消任务"
        cancelText="继续运行"
        danger
        onConfirm={doCancel}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────
// 下方细节合为 tabs 避免长页面
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

function TaskDetailTabs({ taskId, logs, liveLogs, liveLogRef, stickToBottomRef, onLogScroll }: TaskDetailTabsProps) {
  const [tab, setTab] = useState<DetailTab>("workspace");

  // 有新实时日志 → 若不在 live tab 则给徽章；当前 tab 则不累计
  const [unreadLive, setUnreadLive] = useState(0);
  const prevLiveLenRef = useRef(liveLogs.length);
  useEffect(() => {
    const grew = liveLogs.length - prevLiveLenRef.current;
    prevLiveLenRef.current = liveLogs.length;
    if (grew > 0 && tab !== "live") setUnreadLive((n) => n + grew);
    if (tab === "live") setUnreadLive(0);
  }, [liveLogs.length, tab]);

  const tabs: Array<{ key: DetailTab; label: string; badge?: string | number }> = [
    { key: "workspace", label: "Workspace 文件" },
    { key: "phase-logs", label: "阶段日志" },
    { key: "agent-calls", label: "Agent 调用" },
    { key: "transitions", label: "状态日志", badge: logs.length || undefined },
    { key: "live", label: "实时日志", badge: unreadLive || undefined },
  ];

  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div className="subtabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`subtab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge != null && t.badge !== 0 && (
              <span className="pill pill-accent" style={{ marginLeft: "0.4rem", fontSize: "0.68rem", padding: "0.05rem 0.4rem" }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "workspace" && <WorkspaceBrowser taskId={taskId} />}
      {tab === "phase-logs" && <PhaseLogsViewer taskId={taskId} />}
      {tab === "agent-calls" && <AgentCallsViewer taskId={taskId} />}
      {tab === "transitions" && (
        <div className="card">
          <LogTimeline logs={logs} />
        </div>
      )}
      {tab === "live" && (
        <div className="card">
          <div className="card-header" style={{ marginBottom: "0.4rem" }}>
            <h3>实时日志</h3>
            <span className="muted" style={{ fontSize: "0.74rem" }}>
              {liveLogs.length === 0
                ? "暂无；运行中任务会推送到此"
                : stickToBottomRef.current ? "自动跟随中（滚到顶暂停）" : "手动暂停（滚到底恢复）"}
            </span>
          </div>
          <div className="live-log" ref={liveLogRef} onScroll={onLogScroll}>
            {liveLogs.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
