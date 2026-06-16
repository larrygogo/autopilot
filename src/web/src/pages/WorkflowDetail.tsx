import React, { useEffect, useRef, useState } from "react";
import { DescList, DetailHeader, EmptyState, FormDialog, FormField, PageShell } from "@/components/pro";
import { AlertTriangle, Pencil, Trash2 } from "lucide-react";
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
// requires.git / sandbox.git / delivers 在表单里用稳定的 string 代码，
// 读 detail 时派生、提交时映射回 setWorkflowMeta 入参。
type ReqGitCode = "inherit" | "true" | "optional" | "false";
type SandboxGitCode = "on" | "off";
type DeliversCode = "auto" | "pr" | "artifacts";

function readReqGit(detail: WorkflowDetailData | null): ReqGitCode {
  const g = (detail?.requires as { git?: unknown } | undefined)?.git;
  if (g === true) return "true";
  if (g === false) return "false";
  if (g === "optional") return "optional";
  return "inherit";
}
function readSandboxGit(detail: WorkflowDetailData | null): SandboxGitCode {
  return (detail?.sandbox as { git?: unknown } | undefined)?.git === true ? "on" : "off";
}
function readDelivers(detail: WorkflowDetailData | null): DeliversCode {
  const d = detail?.delivers;
  return d === "pr" ? "pr" : d === "artifacts" ? "artifacts" : "auto";
}
// 只读展示用人话短标签
const REQ_GIT_TEXT: Record<ReqGitCode, string> = {
  inherit: "默认（自动判断）",
  true: "必须",
  optional: "可选",
  false: "不需要",
};
const DELIVERS_TEXT: Record<DeliversCode, string> = {
  auto: "自动推断",
  pr: "交付 PR",
  artifacts: "文件产物",
};

/**
 * 把声明层三件套拼成一句人话总结，让用户读结论而非自己跑因果链。
 * requires.git=inherit 时按后端口径（缺省派生自 sandbox.git）落到实际语义。
 */
function declarationSummary(detail: WorkflowDetailData | null): string {
  const reqGit = readReqGit(detail);
  const sandbox = readSandboxGit(detail);
  const delivers = readDelivers(detail);
  const libPart =
    reqGit === "true"
      ? "必须挂代码库"
      : reqGit === "optional"
        ? "代码库可选"
        : reqGit === "false"
          ? "不需要代码库"
          : sandbox === "on"
            ? "必须挂代码库"
            : "不需要代码库"; // inherit 派生
  const clonePart = sandbox === "on" ? "会克隆代码" : "不克隆代码";
  const deliverPart =
    delivers === "pr" ? "交付 PR" : delivers === "artifacts" ? "交付文件产物" : "按运行结果定交付";
  return `${libPart} · ${clonePart} · ${deliverPart}`;
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
  const [metaReqGit, setMetaReqGit] = useState<ReqGitCode>("inherit");
  const [metaSandboxGit, setMetaSandboxGit] = useState<SandboxGitCode>("off");
  const [metaDelivers, setMetaDelivers] = useState<DeliversCode>("auto");
  // 冲突态（1:1 对齐后端 lint）：声明「必须有代码库」却不建 git 沙盒 → 任务在空目录跑
  const declConflict = metaReqGit === "true" && metaSandboxGit === "off";
  // 「跟随默认」时 requires.git 的派生值（对齐后端 getWorkflowGitRequirement：缺省 = sandbox.git）
  const inheritedReqGitText = metaSandboxGit === "on" ? "必须有代码库" : "不需要代码库";

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
    setMetaSandboxGit(readSandboxGit(detail));
    setMetaDelivers(readDelivers(detail));
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
                <Button variant="ghost" size="sm" onClick={openDeclEdit} title="编辑声明（需要代码库 / 建 git 沙盒 / 产出形态）">
                  <Pencil className="h-4 w-4" />
                  编辑
                </Button>
              </div>
              <DescList
                columns={3}
                items={[
                  {
                    label: "需要代码库",
                    value:
                      readReqGit(detail) === "inherit"
                        ? `默认 → ${readSandboxGit(detail) === "on" ? "必须" : "不需要"}`
                        : REQ_GIT_TEXT[readReqGit(detail)],
                  },
                  {
                    label: "建 git 沙盒",
                    value:
                      readReqGit(detail) === "true" && readSandboxGit(detail) === "off" ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span>否</span>
                          <span
                            className="inline-flex items-center text-warning"
                            title="与「需要代码库=必须」冲突：任务会在空目录里跑"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </span>
                        </span>
                      ) : readSandboxGit(detail) === "on" ? (
                        "是"
                      ) : (
                        "否"
                      ),
                  },
                  { label: "产出形态", value: DELIVERS_TEXT[readDelivers(detail)] },
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
          // 只更新 label/desc；声明三件套（requiresGit/sandboxGit/delivers）传 undefined = 不动
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
          // 只更新声明三件套；label/description 传 undefined = 不动
          await api.setWorkflowMeta(name, {
            requiresGit:
              metaReqGit === "inherit"
                ? null
                : metaReqGit === "true"
                  ? true
                  : metaReqGit === "false"
                    ? false
                    : "optional",
            sandboxGit: metaSandboxGit === "on" ? true : null,
            delivers: metaDelivers === "auto" ? null : metaDelivers,
          });
          toast.success("已保存");
          await load();
        }}
      >
        <FormField
          label="需要代码库"
          hint="决定用此工作流的需求能不能在「没挂代码库」时继续往下走"
        >
          <Select value={metaReqGit} onValueChange={(v) => setMetaReqGit(v as ReqGitCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">跟随默认（看是否建 git 沙盒）</SelectItem>
              <SelectItem value="true">必须有代码库</SelectItem>
              <SelectItem value="optional">可选</SelectItem>
              <SelectItem value="false">不需要代码库</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        {/* 「跟随默认」派生结果实时回显：直接回答「建沙盒是不是必须要库」 */}
        {metaReqGit === "inherit" && (
          <p className="-mt-1 text-xs text-muted-foreground">
            跟随默认 → 当前派生为{" "}
            <span className="font-medium text-foreground">{inheritedReqGitText}</span>
            （因为下方{metaSandboxGit === "on" ? "建" : "不建"} git 沙盒）
          </p>
        )}

        <FormField
          label="建 git 沙盒"
          hint="任务运行时把代码库克隆下来，让各阶段在里面改文件"
        >
          <Select value={metaSandboxGit} onValueChange={(v) => setMetaSandboxGit(v as SandboxGitCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">不建（默认，纯文本 / 产物类）</SelectItem>
              <SelectItem value="on">建（把代码库克隆到任务目录）</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        {/* 冲突提示：requires.git=true × sandbox.git=不建（warn 不阻断，对齐后端 lint） */}
        {declConflict && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              声明「必须有代码库」却不建 git 沙盒
            </div>
            <p className="mt-1 text-muted-foreground">
              任务会拿到空目录、没有代码可改。要么把「建 git 沙盒」改为「建」，
              要么把「需要代码库」降为「可选 / 不需要」。
            </p>
          </div>
        )}

        <FormField
          label="产出形态"
          hint={
            metaDelivers === "pr"
              ? "选「交付 PR」意味着：用此工作流的需求必须挂代码库（否则入队时「PR 无处可开」会被拦）"
              : "这个工作流最终交付什么；选「交付 PR」则需求必须挂代码库"
          }
        >
          <Select value={metaDelivers} onValueChange={(v) => setMetaDelivers(v as DeliversCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动推断（按运行结果定）</SelectItem>
              <SelectItem value="pr">交付 PR</SelectItem>
              <SelectItem value="artifacts">交付文件产物</SelectItem>
            </SelectContent>
          </Select>
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
