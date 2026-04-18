import React, { useEffect, useState } from "react";
import { Plus, ChevronRight, ChevronDown, Trash2, X } from "lucide-react";
import { api } from "@/hooks/useApi";
import { StateMachineGraph } from "@/components/StateMachineGraph";
import { NewWorkflowDialog } from "@/components/NewWorkflowDialog";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { PhaseEditor } from "@/components/PhaseEditor";
import { WorkflowAgentsEditor } from "@/components/WorkflowAgentsEditor";
import { PhasePipeline } from "@/components/PhasePipeline";
import { CodeViewer } from "@/components/CodeViewer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface WorkflowInfo {
  name: string;
  description: string;
}

interface WorkflowDetail {
  name: string;
  description?: string;
  agents?: Array<{ name: string; extends?: string; provider?: string; model?: string }>;
  phases?: unknown[];
  initial_state?: string;
  terminal_states?: string[];
  [key: string]: unknown;
}

interface Selected {
  name: string;
  detail: WorkflowDetail;
  graph: any;
}

interface Props {
  onJumpToAgent?: (name: string) => void;
}

export function Workflows({ onJumpToAgent }: Props = {}) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);
  const [tsSource, setTsSource] = useState<string | null>(null);
  const [tsOpen, setTsOpen] = useState(false);
  const [tsLoading, setTsLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    api
      .listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggle = async (name: string) => {
    if (selected?.name === name) {
      setSelected(null);
      setTsOpen(false);
      setTsSource(null);
      return;
    }
    setLoadingDetail(true);
    setTsOpen(false);
    setTsSource(null);
    try {
      const [detail, graph] = await Promise.all([
        api.getWorkflow(name),
        api.getWorkflowGraph(name),
      ]);
      setSelected({ name, detail, graph });
    } catch {
      /* ignore */
    } finally {
      setLoadingDetail(false);
    }
  };

  const loadTs = async () => {
    if (!selected) return;
    setTsLoading(true);
    try {
      const res = await api.getWorkflowTs(selected.name);
      setTsSource(res.content);
    } catch (e: any) {
      toast.error("加载 workflow.ts 失败", e?.message ?? String(e));
    } finally {
      setTsLoading(false);
    }
  };

  const toggleTs = async () => {
    if (!tsOpen) {
      if (tsSource === null) await loadTs();
      setTsOpen(true);
    } else {
      setTsOpen(false);
    }
  };

  const reloadSelected = async () => {
    if (!selected) return;
    try {
      const [detail, graph] = await Promise.all([
        api.getWorkflow(selected.name),
        api.getWorkflowGraph(selected.name),
      ]);
      setSelected({ name: selected.name, detail, graph });
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-5 py-8 text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
      {/* Header */}
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">工作流</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{workflows.length} 个</p>
        </div>
        <Button onClick={() => setNewOpen(true)} className="shrink-0">
          <Plus className="h-4 w-4" />
          新建工作流
        </Button>
      </div>

      {/* 列表 / 空态 */}
      {workflows.length === 0 ? (
        <EmptyState
          title="还没有工作流"
          hint={
            <>
              创建第一个工作流，或手动在{" "}
              <code className="rounded bg-muted px-1 font-mono text-foreground">
                AUTOPILOT_HOME/workflows/
              </code>{" "}
              下添加目录。
            </>
          }
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              创建第一个工作流
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((wf) => {
            const active = selected?.name === wf.name;
            return (
              <button
                key={wf.name}
                type="button"
                onClick={() => toggle(wf.name)}
                className={cn(
                  "group flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 text-left shadow-sm transition-colors",
                  active
                    ? "border-primary/40 ring-1 ring-primary/20"
                    : "hover:border-primary/30 hover:bg-accent/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate font-mono text-sm font-semibold text-primary">
                    {wf.name}
                  </h3>
                  {active ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  )}
                </div>
                {wf.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{wf.description}</p>
                )}
                <p className="mt-auto text-[11px] text-muted-foreground">
                  {active ? "点击收起" : "点击查看详情"}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {loadingDetail && (
        <p className="mt-4 text-sm text-muted-foreground">加载详情中…</p>
      )}

      {/* 详情 */}
      {selected && !loadingDetail && (
        <div className="mt-6 space-y-4">
          {/* Summary card */}
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="truncate font-mono text-base font-semibold text-primary">
                {selected.name}
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPendingDelete(selected.name)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSelected(null)}>
                  <X className="h-4 w-4" />
                  收起
                </Button>
              </div>
            </div>

            {selected.detail.description && (
              <p className="mb-3 text-sm text-muted-foreground">{selected.detail.description}</p>
            )}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <SummaryField label="初始状态">
                <code className="font-mono">{selected.detail.initial_state}</code>
              </SummaryField>
              <SummaryField label="终态数">
                {selected.detail.terminal_states?.length ?? 0}
              </SummaryField>
              <SummaryField label="阶段数">{selected.detail.phases?.length ?? 0}</SummaryField>
              <SummaryField label="智能体数">{selected.detail.agents?.length ?? 0}</SummaryField>
            </dl>
          </Card>

          {/* Agents editor */}
          <Card className="p-4">
            <WorkflowAgentsEditor
              workflowName={selected.name}
              initialAgents={(selected.detail.agents as any[]) ?? []}
              onJumpToAgent={onJumpToAgent}
              onSaved={reloadSelected}
            />
          </Card>

          {/* Pipeline */}
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">流水线</h3>
              <span className="text-xs text-muted-foreground">
                鼠标悬停以联动高亮编辑器与状态机图
              </span>
            </div>
            <PhasePipeline
              phases={(selected.detail.phases as any[]) ?? []}
              highlight={hoveredPhase}
              onHoverPhase={setHoveredPhase}
            />
          </Card>

          {/* Phase editor */}
          <Card className="p-4">
            <PhaseEditor
              workflowName={selected.name}
              initialPhases={(selected.detail.phases as any[]) ?? []}
              hoveredPhase={hoveredPhase}
              onHoverPhase={setHoveredPhase}
              onSaved={async () => {
                if (tsSource !== null) {
                  api
                    .getWorkflowTs(selected.name)
                    .then((r) => setTsSource(r.content))
                    .catch(() => {});
                }
                await reloadSelected();
              }}
            />
          </Card>

          {/* State machine */}
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">状态机</h3>
            <StateMachineGraph
              nodes={selected.graph.nodes}
              edges={selected.graph.edges}
              highlightPhase={hoveredPhase}
              onHoverPhase={setHoveredPhase}
            />
          </Card>

          {/* workflow.ts viewer */}
          <Card className="p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">workflow.ts 源码</h3>
              <Button variant="secondary" size="sm" onClick={toggleTs} disabled={tsLoading}>
                {tsLoading ? "加载中…" : tsOpen ? "收起" : "展开"}
              </Button>
            </div>
            {tsOpen && tsSource !== null && (
              <CodeViewer
                code={tsSource}
                highlightPhase={hoveredPhase}
                scrollToPhase={hoveredPhase}
              />
            )}
            {tsOpen && tsSource === null && !tsLoading && (
              <p className="text-sm text-muted-foreground">加载失败</p>
            )}
            {!tsOpen && (
              <p className="text-xs text-muted-foreground">
                展开查看{" "}
                <code className="rounded bg-muted px-1 font-mono">
                  AUTOPILOT_HOME/workflows/{selected.name}/workflow.ts
                </code>
                （只读）；hover 阶段会高亮对应 run_ 函数
              </p>
            )}
          </Card>
        </div>
      )}

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => refresh()}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除工作流"
        message={
          <div className="space-y-3">
            <p>
              确认删除工作流{" "}
              <code className="rounded bg-muted px-1 font-mono">{pendingDelete}</code>？
            </p>
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs text-destructive">
                ⚠ 将永久删除整个目录：
                <br />
                <code className="font-mono">
                  AUTOPILOT_HOME/workflows/{pendingDelete}/
                </code>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                包括 workflow.yaml、workflow.ts 及该目录内的所有文件。此操作不可恢复。
              </p>
            </div>
          </div>
        }
        confirmText="删除"
        danger
        onConfirm={async () => {
          if (!pendingDelete) return;
          const name = pendingDelete;
          try {
            await api.deleteWorkflow(name);
            toast.success(`工作流 ${name} 已删除`);
            setSelected(null);
            refresh();
          } catch (e: any) {
            toast.error("删除失败", e?.message ?? String(e));
          } finally {
            setPendingDelete(null);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function SummaryField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/50 px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}
