import React, { useEffect, useRef, useState } from "react";
import { DescList, DetailHeader, EmptyState, FormDialog, FormField, PageShell } from "@/components/pro";
import { Pencil, Trash2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { PhasePipelineEditor } from "@/components/PhasePipelineEditor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";

interface WorkflowDetailData {
  name: string;
  label?: string;
  description?: string;
  phases?: unknown[];
  initial_state?: string;
  terminal_states?: string[];
  source?: "db" | "file";
  derives_from?: string | null;
  [key: string]: unknown;
}

/**
 * /workflows/:name —— 单个工作流的独立详情/编辑页。
 * 从原 Workflows 单页里的内联展开抽出，改为真正的路由：可刷新保持、可收藏、
 * 可分享、浏览器前进后退可用。失败任务「去工作流修复」也跳到这里
 * （?phase=&fromTask= query 透传）。
 */
export function WorkflowDetail() {
  const { name = "" } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const [searchParams] = useSearchParams();
  const fromTaskId = searchParams.get("fromTask");
  const fromTaskPhase = searchParams.get("phase");

  const [detail, setDetail] = useState<WorkflowDetailData | null>(null);
  const [tsSource, setTsSource] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound">("loading");
  const [pendingDelete, setPendingDelete] = useState(false);
  const [retryingFromTask, setRetryingFromTask] = useState(false);
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const [metaLabel, setMetaLabel] = useState("");
  const [metaDesc, setMetaDesc] = useState("");

  const load = async () => {
    try {
      const [d, graph] = await Promise.all([
        api.getWorkflow(name),
        api.getWorkflowGraph(name),
      ]);
      void graph; // graph 预留给后续可视化；当前编辑器从 detail.phases 取
      setDetail(d as WorkflowDetailData);
      setState("ready");
      void loadTsSilently();
    } catch (e: unknown) {
      // 拿不到详情：要么名字不存在，要么 daemon 异常。统一落 notfound 卡片，
      // 顺带 toast 出错因，避免「白屏卡住」。
      setState("notfound");
      toast.error("加载工作流详情失败", (e as Error)?.message ?? String(e));
    }
  };

  const loadTsSilently = async () => {
    try {
      const res = await api.getWorkflowTs(name);
      setTsSource(res.content);
    } catch {
      setTsSource(null);
    }
  };

  useEffect(() => {
    setState("loading");
    setDetail(null);
    setTsSource(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // WS：daemon 重载工作流（修复孤儿 / discover 新增等）后自动刷新本页
  useEffect(() => {
    const unsub = subscribe("daemon", (event) => {
      if (event.type === "workflow:reloaded") void load();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, name]);

  // fromTask 修复流程：提示用户点对应 phase 节点
  const hintedRef = useRef(false);
  useEffect(() => {
    if (state === "ready" && fromTaskPhase && !hintedRef.current) {
      hintedRef.current = true;
      toast.info(`请点击「${fromTaskPhase}」节点编辑 prompt 或 ts`);
    }
  }, [state, fromTaskPhase, toast]);

  const openMetaEdit = () => {
    setMetaLabel(detail?.label ?? "");
    setMetaDesc(detail?.description ?? "");
    setMetaEditOpen(true);
  };


  const handleReturnAndRetry = async () => {
    if (!fromTaskId) return;
    setRetryingFromTask(true);
    try {
      await api.restartTask(fromTaskId);
      toast.success(`已重启任务 ${fromTaskId}，跳转查看`);
      navigate(`/tasks/${fromTaskId}`);
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
      setRetryingFromTask(false);
    }
  };

  return (
    <PageShell width="content" loading={state === "loading"}>
      {state === "notfound" && (
        <EmptyState
          size="page"
          title="找不到工作流"
          hint={<><code className="font-mono">{name}</code> 不存在或已被删除。</>}
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate("/workflows")}>
              返回列表
            </Button>
          }
        />
      )}

      {state === "ready" && detail && (
        <div className="space-y-4">
          {/* 业务标签（label）作主标题，内核名（name）经 identifier 槽 mono 叠加；
              无 label 时回退 mono name */}
          <DetailHeader
            back={{ to: "/workflows", label: "工作流" }}
            title={detail.label || <span className="font-mono">{detail.name}</span>}
            identifier={detail.label ? detail.name : undefined}
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={openMetaEdit} title="编辑显示名与描述">
                  <Pencil className="h-4 w-4" />
                  编辑
                </Button>
                {/* file 工作流同样可删（workflows.delete 对 file source 走 deleteWorkflowDir 删目录） */}
                <Button variant="destructive" size="sm" onClick={() => setPendingDelete(true)} title="删除">
                  <Trash2 className="h-4 w-4" />
                  删除
                </Button>
              </>
            }
          />

          {/* 从失败任务跳过来修复 prompt 的上下文 banner */}
          {fromTaskId && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
              <div className="flex-1 text-sm">
                <span className="font-bold text-accent">修复来自任务 {fromTaskId}</span>
                <span className="ml-2 text-muted-foreground">
                  {fromTaskPhase && (
                    <>
                      点击「<code className="font-mono text-foreground">{fromTaskPhase}</code>」节点编辑 prompt / ts → 保存
                    </>
                  )}
                  <span className="ml-1">→ 然后点右侧按钮回任务并重跑</span>
                </span>
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={handleReturnAndRetry}
                disabled={retryingFromTask}
                className="text-[11px]"
              >
                {retryingFromTask ? "重启中…" : `回任务 & 重跑 →`}
              </Button>
            </div>
          )}

          {/* Summary card */}
          <Card className="p-4">
            {detail.description && (
              <p className="mb-3 text-sm text-muted-foreground">{detail.description}</p>
            )}

            <DescList
              columns={4}
              items={[
                { label: "初始状态", value: detail.initial_state, mono: true },
                { label: "终态数", value: detail.terminal_states?.length ?? 0 },
                { label: "阶段数", value: detail.phases?.length ?? 0 },
              ]}
            />
          </Card>

          {/* 流水线 + 阶段编辑器：节点点击弹编辑 drawer */}
          <Card className="p-4">
            <PhasePipelineEditor
              workflowName={detail.name}
              initialPhases={(detail.phases as any[]) ?? []}
              tsSource={tsSource}
              onSaved={async () => {
                void loadTsSilently();
                await load();
              }}
            />
          </Card>
        </div>
      )}

      <FormDialog
        open={metaEditOpen}
        onOpenChange={setMetaEditOpen}
        title="编辑工作流信息"
        description={
          <>
            标识符 <code className="font-mono">{name}</code> 不可修改——它是目录名与历史任务、
            需求的引用键，改名等于新建工作流（可用导出 → 以新名导入实现）。
          </>
        }
        onSubmit={async () => {
          await api.setWorkflowMeta(name, {
            label: metaLabel.trim() || null,
            description: metaDesc.trim() || null,
          });
          toast.success("已保存");
          await load();
        }}
      >
        <FormField label="显示名" htmlFor="wf-meta-label" hint="留空则界面回退显示标识符">
          <Input
            id="wf-meta-label"
            value={metaLabel}
            onChange={(e) => setMetaLabel(e.target.value)}
            placeholder={name}
            maxLength={60}
          />
        </FormField>
        <FormField label="描述" htmlFor="wf-meta-desc">
          <Textarea
            id="wf-meta-desc"
            value={metaDesc}
            onChange={(e) => setMetaDesc(e.target.value)}
            placeholder="一句话说明这个工作流做什么、适用什么需求"
            rows={3}
          />
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete}
        title="删除工作流"
        message={
          <div className="space-y-3">
            <p>
              确认删除工作流{" "}
              <code className="rounded bg-muted px-1 font-mono">{name}</code>？
            </p>
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs text-destructive">
                ⚠ 将永久删除整个目录：
                <br />
                <code className="font-mono">AUTOPILOT_HOME/workflows/{name}/</code>
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
          try {
            await api.deleteWorkflow(name);
            toast.success(`工作流 ${name} 已删除`);
            navigate("/workflows");
          } catch (e: unknown) {
            toast.error("删除失败", (e as Error)?.message ?? String(e));
            throw e;
          } finally {
            setPendingDelete(false);
          }
        }}
        onCancel={() => setPendingDelete(false)}
      />
    </PageShell>
  );
}
