import React, { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "@/hooks/useApi";
import { NewWorkflowDialog } from "@/components/NewWorkflowDialog";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NewWorkflowFromTemplate } from "@/components/NewWorkflowFromTemplate";
import { WorkflowCatalog } from "@/components/WorkflowCatalog";
import { WorkflowHealthBanner } from "@/components/WorkflowHealthBanner";
import { ConfirmDialog } from "@/components/Modal";
import { PageHero } from "@/components/PageHero";
import { useToast } from "@/components/Toast";
import { WorkflowAgentsEditor } from "@/components/WorkflowAgentsEditor";
import { PhasePipelineEditor } from "@/components/PhasePipelineEditor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface WorkflowInfo {
  name: string;
  label?: string;
  description: string;
  source?: "db" | "file";
  derives_from?: string | null;
}

interface WorkflowDetail {
  name: string;
  description?: string;
  agents?: Array<{ name: string; extends?: string; provider?: string; model?: string }>;
  phases?: unknown[];
  initial_state?: string;
  terminal_states?: string[];
  source?: "db" | "file";
  derives_from?: string | null;
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
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [tsSource, setTsSource] = useState<string | null>(null);

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

  // 接收 URL query：?wf=<name>&phase=<name>
  // 用于 TaskOutcomeCard 失败时「去工作流修复」跳过来自动定位
  const [searchParams] = useSearchParams();
  const autoSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const wf = searchParams.get("wf");
    if (!wf) return;
    // 等 listWorkflows 拉完且未自动选过这个 wf
    if (workflows.length === 0 || autoSelectedRef.current === wf) return;
    if (!workflows.some((w) => w.name === wf)) return;
    autoSelectedRef.current = wf;
    void toggle(wf);
    const phase = searchParams.get("phase");
    if (phase) {
      toast.info(`已选中工作流，请点击「${phase}」节点编辑 prompt 或 ts`);
    }
  }, [searchParams, workflows]);

  const toggle = async (name: string) => {
    if (selected?.name === name) {
      setSelected(null);
      setTsSource(null);
      return;
    }
    setLoadingDetail(true);
    setTsSource(null);
    try {
      const [detail, graph] = await Promise.all([
        api.getWorkflow(name),
        api.getWorkflowGraph(name),
      ]);
      setSelected({ name, detail, graph });
      // 后台预载 ts 给 drawer 用
      void loadTsSilently(name);
    } catch {
      /* ignore */
    } finally {
      setLoadingDetail(false);
    }
  };

  /**
   * 后台懒加载 workflow.ts 源码，仅给 drawer 抽取本阶段函数片段用。
   * 不再展示完整 ts viewer，所以静默失败：拿不到就 drawer 里显示 stub 提示。
   */
  const loadTsSilently = async (name: string) => {
    try {
      const res = await api.getWorkflowTs(name);
      setTsSource(res.content);
    } catch {
      setTsSource(null);
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
      <PageHero
        eyebrow="SHEET · WORKFLOWS · DEF"
        title="工作流"
        subtitle="编排定义 · 阶段图谱"
        description="管理所有可用的工作流；每个工作流都是 AUTOPILOT_HOME/workflows/ 下的独立目录。"
        meta={[
          { k: "总数", v: workflows.length },
        ]}
        actions={
          <Button onClick={() => setTemplatePickerOpen(true)}>
            <Plus className="h-4 w-4" />
            新建工作流
          </Button>
        }
      />

      {/* 工作流目录健康检查：孤儿 / 重名碰撞 → 顶部警告条 + 修复 dialog */}
      {!selected && <WorkflowHealthBanner onFixed={refresh} />}

      {/* 用例目录视图（业务视角，PR #71 加） */}
      {!selected && (
        <WorkflowCatalog
          workflows={workflows}
          onSelect={(name) => toggle(name)}
          onClone={(name) => {
            setCloneSource(name);
            setCloneName(`${name}-copy`);
          }}
          onNew={() => setTemplatePickerOpen(true)}
        />
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
              <h3 className="truncate font-mono text-base font-semibold text-accent">
                {selected.name}
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPendingDelete(selected.name)}
                  disabled={loadingDetail || (selected.detail.source ?? "file") === "file"}
                  title={
                    (selected.detail.source ?? "file") === "file"
                      ? "文件工作流只读，请改源目录"
                      : "删除"
                  }
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

          {/* 流水线 + 阶段编辑器合二为一：流水线节点点击弹编辑 drawer */}
          <Card className="p-4">
            <PhasePipelineEditor
              workflowName={selected.name}
              initialPhases={(selected.detail.phases as any[]) ?? []}
              tsSource={tsSource}
              workflowAgents={(selected.detail.agents as Array<{ name: string }> | undefined) ?? []}
              onSaved={async () => {
                // 同步刷新 drawer 里用的 ts 源码
                void loadTsSilently(selected.name);
                await reloadSelected();
              }}
            />
          </Card>
        </div>
      )}

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => refresh()}
      />

      <NewWorkflowFromTemplate
        open={templatePickerOpen}
        onCancel={() => setTemplatePickerOpen(false)}
        onCreated={(_name) => {
          setTemplatePickerOpen(false);
          refresh();
        }}
        onFromScratch={() => {
          setTemplatePickerOpen(false);
          setNewOpen(true);
        }}
        onFromAI={() => {
          setTemplatePickerOpen(false);
          navigate("/workflows/new-with-ai");
        }}
      />

      <Dialog
        open={cloneSource !== null}
        onOpenChange={(v) => { if (!v && !cloning) { setCloneSource(null); setCloneName(""); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>克隆工作流 {cloneSource ?? ""}</DialogTitle>
            <DialogDescription>
              拷贝 yaml + ts 到新工作流目录；新工作流可以独立编辑、不影响原版。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="clone-name" className="font-mono text-[10px] uppercase tracking-[0.18em]">新名字</Label>
            <Input
              id="clone-name"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder="my-dev"
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCloneSource(null); setCloneName(""); }} disabled={cloning}>
              取消
            </Button>
            <Button
              onClick={async () => {
                if (!cloneSource || !cloneName.trim()) return;
                if (!/^[\w.\-]+$/.test(cloneName.trim())) {
                  toast.error("名字只允许字母 / 数字 / . _ -", "");
                  return;
                }
                setCloning(true);
                try {
                  // 用专门的"克隆已有工作流"API，而非 from-template（后者只克隆 examples 模板）
                  await api.cloneWorkflow(cloneSource, cloneName.trim());
                  toast.success(`已克隆 ${cloneSource} → ${cloneName.trim()}`);
                  setCloneSource(null);
                  setCloneName("");
                  refresh();
                } catch (e: unknown) {
                  toast.error("克隆失败", (e as Error)?.message ?? String(e));
                } finally {
                  setCloning(false);
                }
              }}
              disabled={cloning || !cloneName.trim()}
            >
              {cloning ? "克隆中..." : "克隆"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除工作流"
        message={
          <div className="space-y-3">
            <p>
              确认删除工作流{" "}
              <code className="rounded bg-muted px-1 font-mono">{pendingDelete}</code>？
            </p>
            <div className="rounded-none border border-destructive/30 bg-destructive/5 px-3 py-2.5">
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
    <div className="flex flex-col items-center gap-3 rounded-none border border-dashed bg-card/50 px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}
