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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── 声明层（v2 R5）UI 代码 ↔ yaml 值映射 ──────────────────────────
// requires.git 在表单里用稳定的 string 代码（二态：需要 / 不需要），读 detail 时派生、提交时映射回 setMeta。
// sandbox.git（建 git 沙盒）与 delivers（产出形态）不再是用户输入——前者从 requires.git 派生（需要就一定 clone）、
// 后者从 phase 派生，编辑器只读展示。
type ReqGitCode = "true" | "false";
type DeliversCode = "auto" | "pr" | "artifacts";

// requires.git 二态：true=需要、false=不需要。requires.git 显式优先；未显式则派生自 sandbox.git
// （老工作流只写了 sandbox.git 的兼容路径，与后端 getWorkflowGitRequirement 一致）。
function readReqGit(detail: WorkflowDetailData | null): ReqGitCode {
  const g = (detail?.requires as { git?: unknown } | undefined)?.git;
  if (g === true) return "true";
  if (g === false) return "false";
  return (detail?.sandbox as { git?: unknown } | undefined)?.git === true ? "true" : "false";
}
function readDelivers(detail: WorkflowDetailData | null): DeliversCode {
  const d = detail?.delivers;
  return d === "pr" ? "pr" : d === "artifacts" ? "artifacts" : "auto";
}
// 只读展示用人话短标签
const REQ_GIT_TEXT: Record<ReqGitCode, string> = {
  true: "需要",
  false: "不需要",
};
const DELIVERS_TEXT: Record<DeliversCode, string> = {
  auto: "自动推断",
  pr: "交付 PR",
  artifacts: "文件产物",
};

/**
 * 把声明层拼成一句人话总结。需要代码库（二态）→ 一定克隆；产出形态从 phase 派生。
 */
function declarationSummary(detail: WorkflowDetailData | null): string {
  const reqGit = readReqGit(detail);
  const delivers = readDelivers(detail);
  const libPart = reqGit === "true" ? "需要代码库（会克隆下来）" : "不需要代码库";
  const deliverPart =
    delivers === "pr" ? "交付 PR" : delivers === "artifacts" ? "交付文件产物" : "按运行结果定交付";
  return `${libPart} · ${deliverPart}`;
}


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
  const [declEditOpen, setDeclEditOpen] = useState(false);
  const [metaLabel, setMetaLabel] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaReqGit, setMetaReqGit] = useState<ReqGitCode>("false");
  // 注：sandbox.git（建 git 沙盒）不再是开关——需要代码库就一定 clone，由 requires.git 派生。

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

  // 声明层编辑独立出「工作流信息」对话框：从 Summary 卡的声明区直接进，
  // 不再埋在「改显示名」里。三件套是最贴产品定位核心的开关，值得独立入口。
  const openDeclEdit = () => {
    setMetaReqGit(readReqGit(detail));
    setDeclEditOpen(true);
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

            {/* 声明层（v2 R5）：决定这个工作流如何约束需求的输入/产出。
                顶部一句人话总结让用户读结论；右侧独立编辑入口，不必进「改显示名」对话框 */}
            <div>
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">声明 · 这个工作流如何约束需求</div>
                  <p className="mt-0.5 text-sm text-foreground">{declarationSummary(detail)}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={openDeclEdit} title="编辑声明（需要代码库 / 交付形态）">
                  <Pencil className="h-4 w-4" />
                  编辑
                </Button>
              </div>
              <DescList
                columns={2}
                items={[
                  { label: "需要代码库", value: REQ_GIT_TEXT[readReqGit(detail)] },
                  { label: "此工作流交付", value: DELIVERS_TEXT[readDelivers(detail)] },
                ]}
              />
            </div>
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
          // 只更新 label/desc；requiresGit 传 undefined = 不动（sandbox.git / delivers 已不是 meta 字段）
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

      {/* 声明层编辑：独立对话框，从 Summary 卡声明区进入（不再埋在「改显示名」里） */}
      <FormDialog
        open={declEditOpen}
        onOpenChange={setDeclEditOpen}
        title="编辑声明"
        description={
          <>
            决定用此工作流的需求如何约束输入与产出（按需求生命周期：输入 → 执行 → 产出）。
            当前：<span className="font-medium text-foreground">{declarationSummary(detail)}</span>
          </>
        }
        onSubmit={async () => {
          // 只更新「需要代码库」（二态）。sandbox.git（建 git 沙盒）从 requires.git 派生、delivers 从 phase
          // 派生，均不再是用户输入。
          await api.setWorkflowMeta(name, {
            requiresGit: metaReqGit === "true",
          });
          toast.success("已保存");
          await load();
        }}
      >
        <FormField
          label="需要代码库"
          hint="需要 → 任务运行时一定把代码库克隆下来供各阶段改文件；不需要 → 不克隆、在空目录跑（纯文本 / 产物类）。run 终结仍以事实为准。"
        >
          <Select value={metaReqGit} onValueChange={(v) => setMetaReqGit(v as ReqGitCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">需要</SelectItem>
              <SelectItem value="false">不需要</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        {/* 产出形态 delivers 不再让用户选——它从工作流的 phase 自动派生（有 deliver:pr/artifacts 阶段
            → 对应形态）。当前派生值在「工作流信息」只读展示（此工作流交付）。 */}
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">此工作流交付：{DELIVERS_TEXT[readDelivers(detail)]}</span>
          <span className="ml-1">——从交付阶段自动判定（有 deliver:pr / deliver:artifacts 阶段），不用手选；run 终结以事实为准。</span>
        </div>
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
