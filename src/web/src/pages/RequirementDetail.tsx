import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { PAGE_W } from "@/lib/layout";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare, CheckCircle2, Send, Wifi, WifiOff, Loader2, ChevronRight, Settings2, Pencil, History, Trash2, FileQuestion, Bot, UserRound } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type RequirementSubPr, type RequirementDelivery, type Question, type Project, type Workspace, type ProviderItem, type ClarifierRoundState, type RequirementStatusLog, type Attachment } from "@/hooks/useApi";
import { AttachmentUploader } from "@/components/AttachmentUploader";
import { RequirementWorkspacePicker } from "@/components/RequirementWorkspacePicker";
import { AttachmentList } from "@/components/AttachmentList";
import { TaskFileDiffsCard } from "@/components/TaskFileDiffsCard";
import { SandboxBrowser } from "@/components/SandboxBrowser";
import { useToast } from "@/components/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea, Input } from "@/components/ui/input";
import { TaskDetail } from "@/pages/TaskDetail";
import { RunSwitcher } from "@/components/RunSwitcher";
import { type RunLike } from "@/lib/run-label";
import { SkeletonRows, ErrorState } from "@/components/pro";
import { StepBar } from "@/components/StepBar";
import { stepPosition, resolveCurrentStep, canEditRequirementContent, STEPS, STEP_ORDER, type ReqStep } from "@/lib/requirement-steps";
import { NextStepCTA } from "@/components/NextStepCTA";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/Modal";
import { SpecRevisionsSheet } from "@/components/SpecRevisionsSheet";
import { MarkdownView } from "@/components/MarkdownView";
import { DeliveriesCard } from "@/components/DeliveriesCard";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const STATUS_LABEL: Record<string, string> = {
  drafting: "草稿",
  clarifying: "澄清中",
  investigating: "调查中",
  awaiting_approval: "待审批",
  ready: "已澄清",
  queued: "排队中",
  running: "执行中",
  awaiting_review: "待 PR review",
  fix_revision: "修复中",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "muted"
> = {
  drafting: "outline",
  clarifying: "info",
  investigating: "info",
  awaiting_approval: "warning",
  ready: "success",
  queued: "secondary",
  running: "info",
  awaiting_review: "warning",
  fix_revision: "warning",
  done: "success",
  cancelled: "muted",
  failed: "destructive",
};

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

const SOURCE_LABEL: Record<string, string> = {
  manual: "审查意见",
  github_review: "GitHub Review",
};

interface RenderQuestionDeps {
  replyDrafts: Record<string, string>;
  setReplyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  replyingId: string | null;
  submitReply: (qid: string) => Promise<void>;
}

function ClarifierOverrideDialog({
  open,
  onOpenChange,
  requirementId,
  currentProvider,
  currentModel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirementId: string;
  currentProvider: string | null;
  currentModel: string | null;
  onSaved: () => void;
}): React.ReactNode {
  const toast = useToast();
  const [mode, setMode] = useState<"inherit" | "override">(currentProvider || currentModel ? "override" : "inherit");
  const [provider, setProvider] = useState<string>(currentProvider ?? "");
  const [model, setModel] = useState<string>(currentModel ?? "");
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);

  // 每次打开时 sync state to props
  useEffect(() => {
    if (!open) return;
    setMode(currentProvider || currentModel ? "override" : "inherit");
    setProvider(currentProvider ?? "");
    setModel(currentModel ?? "");
    api.listProviders().then(setProviders).catch(() => {});
  }, [open, currentProvider, currentModel]);

  // provider 改变时拉 model 列表
  useEffect(() => {
    if (!provider) { setModels([]); return; }
    setLoadingModels(true);
    api.getProviderModels(provider)
      .then((r) => setModels(r.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
  }, [provider]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = mode === "inherit"
        ? { clarifier_provider: null, clarifier_model: null }
        : { clarifier_provider: provider || null, clarifier_model: model || null };
      await api.updateRequirement(requirementId, body);
      toast.success("已保存");
      onSaved();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>此需求的澄清模型</DialogTitle>
          <DialogDescription>
            仅作用于本需求。继承全局表示用提供商默认模型。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* mode toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("inherit")}
              className={cn(
                "flex-1 border px-3 py-2 font-mono text-xs ",
                mode === "inherit"
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/40",
              )}
            >
              继承全局默认
            </button>
            <button
              type="button"
              onClick={() => setMode("override")}
              className={cn(
                "flex-1 border px-3 py-2 font-mono text-xs ",
                mode === "override"
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/40",
              )}
            >
              为此需求 override
            </button>
          </div>

          {mode === "override" && (
            <>
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] ">供应商</Label>
                <Select value={provider} onValueChange={(v) => { setProvider(v); setModel(""); }}>
                  <SelectTrigger className="rounded-md">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] ">模型（可选）</Label>
                <Select value={model} onValueChange={setModel} disabled={!provider || loadingModels}>
                  <SelectTrigger className="rounded-md">
                    <SelectValue placeholder={
                      !provider ? "先选供应商" :
                      loadingModels ? "加载中…" :
                      models.length === 0 ? "无可用模型（走默认）" :
                      "选择模型"
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (<SelectItem key={m} value={m}>{m}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 渲染单个 question 的 chat 气泡块（AI 提问 + 用户回复 + 回复输入框）。
 * 抽成独立函数以便 active question 区和历史折叠区共用。
 */
function renderQuestion(q: Question, deps: RenderQuestionDeps): React.ReactNode {
  const { replyDrafts, setReplyDrafts, replyingId, submitReply } = deps;
  return (
    <div key={q.id} className="space-y-3">
      {/* AI 气泡 */}
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">AI</div>
        <div className="flex-1 space-y-2">
          <div className={cn(
            "rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-relaxed",
            q.status === "resolved" && "opacity-60"
          )}>
            {/* AI 提问是 markdown（粗体/表格/代码片段），渲染而非裸文本 */}
            <MarkdownView content={q.agent_text} />
          </div>
          {q.status === "open" && q.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setReplyDrafts(d => ({ ...d, [q.id]: s }))}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 用户回复气泡 */}
      {(q.replies ?? []).filter(r => r.author_role === "user").map((reply) => (
        <div key={reply.id} className="flex items-start justify-end gap-2.5">
          <div className={cn(
            "max-w-[80%] rounded-2xl rounded-tr-sm bg-accent/15 px-4 py-3 text-sm leading-relaxed text-foreground",
            q.status === "resolved" && "opacity-70"
          )}>
            {reply.text}
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-foreground">
            你
          </div>
        </div>
      ))}

      {/* 输入框（仅 open 状态） */}
      {q.status === "open" && (
        <div className="pl-8 space-y-2">
          <Textarea
            value={replyDrafts[q.id] ?? ""}
            onChange={(e) => setReplyDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
            placeholder="输入回复，或点击上方建议…"
            className="min-h-[72px] resize-none text-sm"
            disabled={replyingId === q.id}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitReply(q.id);
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void submitReply(q.id)}
              disabled={replyingId === q.id || !(replyDrafts[q.id] ?? "").trim()}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {replyingId === q.id ? "发送中…" : "发送"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<ClarifierRoundState["phase"], string> = {
  preparing: "准备 prompt",
  "cloning-repo": "克隆代码库",
  "calling-llm": "调用 LLM 中",
  parsing: "解析返回（重试中）",
  writing: "写入 spec / 问题",
  done: "完成",
  aborted: "已中止",
  errored: "出错",
};

const ACTIVE_PHASES = new Set<ClarifierRoundState["phase"]>([
  "preparing",
  "cloning-repo",
  "calling-llm",
  "parsing",
  "writing",
]);

function ClarifierProgressCard({
  round,
  elapsedSec,
  traceOpen,
  onToggleTrace,
}: {
  round: ClarifierRoundState;
  elapsedSec: number;
  traceOpen: boolean;
  onToggleTrace: () => void;
}): React.ReactNode {
  const attemptLabel = round.attempt === 0 ? "第 1 次" : "第 2 次（重试）";
  // clone 阶段还没碰 LLM —— 显示「初始化代码库」而不是误导性的「LLM 调用」
  const isCloning = round.phase === "cloning-repo";
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-muted-foreground">
            {isCloning ? "正在初始化代码库…" : "AI 正在思考…"}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
            {isCloning
              ? "正在拉取代码库供 AI 阅读（第一次会慢点，好了就开始提问）"
              : `${attemptLabel}调用 AI · ${PHASE_LABEL[round.phase]}`}
          </div>
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground shrink-0">
          已用 {elapsedSec}s
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleTrace}
        className="mt-3 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-accent"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", traceOpen && "rotate-90")} />
        技术细节
      </button>

      {traceOpen && (
        <div className="mt-3 space-y-3">
          {round.last_parse_error && (
            <div className="border border-border bg-card px-3 py-2 rounded-md">
              <p className="font-mono text-[10px] text-destructive mb-1">
                上次解析失败
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {round.last_parse_error}
              </pre>
            </div>
          )}
          {round.prompt && (
            <div>
              <p className="font-mono text-[10px] text-muted-foreground mb-1">
                本轮 Prompt
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground bg-muted/20 p-2 max-h-[400px] overflow-y-auto rounded-md border border-border">
                {round.prompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function RequirementDetail() {
  // RESTful 深链：/requirements/:id/:step/:runId（step/runId 可缺）。
  const { id, step: stepParam, runId: runParam } = useParams<{ id: string; step?: string; runId?: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const { subscribe, state: wsState } = useWebSocket();

  const [req, setReq] = useState<Requirement | null>(null);
  const [feedbacks, setFeedbacks] = useState<RequirementFeedback[]>([]);
  const [repos, setRepos] = useState<Workspace[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState("");
  const [savingSpec, setSavingSpec] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // 同步 lock：React setActionBusy 是异步的，连点 / 双击场景下第一次 click 后
  // React 还没 re-render 前 actionBusy 仍是 false，按钮 disabled 检查不能拦。
  // busyRef.current 是同步赋值的，能在第一次 click 同步拒掉第二次。
  // 每个 mutation 函数遵守模式：
  // if (busyRef.current) return; busyRef.current = true; setActionBusy(true);
  // try { ... } finally { busyRef.current = false; setActionBusy(false); }
  const busyRef = useRef(false);
  const [subPrs, setSubPrs] = useState<RequirementSubPr[]>([]);
  // 回复输入状态：qid → 文本
  const [projectCodebases, setProjectCodebases] = useState<Workspace[]>([]);
  const [clarifierDialogOpen, setClarifierDialogOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [retryingClarify, setRetryingClarify] = useState(false);
  const [round, setRound] = useState<ClarifierRoundState | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [statusLogs, setStatusLogs] = useState<RequirementStatusLog[]>([]);
  const [workflowOptions, setWorkflowOptions] = useState<{ name: string; label?: string; description: string; requires_git?: boolean }[]>([]);
  const [deliveries, setDeliveries] = useState<RequirementDelivery[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // v2 R6：需求的全部根 run（execution / fix 轮），按 seq 升序。多 run 时执行记录区出切换器。
  // undefined = 加载中（区分尚未拉取与确实为空），[] = 确实无 run（前置态）。
  const [runs, setRuns] = useState<RunLike[] | undefined>(undefined);
  const [runsError, setRunsError] = useState<string | null>(null);
  // 当前选中查看的 run（多 run 时切换器控制）；默认最新（= req.task_id）或 ?run= 深链。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 深链（RESTful 路径段）：每个阶段 / 每个 run 有独立可分享 URL。
  // 缺 step → 当前阶段（跟随最新）；缺 runId → 最新 run（见下 selectedRunId 解析）。
  const runQuery = runParam ?? null;
  const stepQuery = stepParam ?? null;

  const refresh = useCallback(async function refresh(opts: { silent?: boolean } = {}) {
    if (!id) return;
    if (!opts.silent) setLoading(true);
    try {
      const [data, repoList, sub, qs, rd, slogs, atts, dels] = await Promise.all([
        api.getRequirement(id),
        api.listWorkspaces(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
        api.listQuestions(id).catch(() => [] as Question[]),
        api.getClarifierRound(id).catch(() => null),
        api.listRequirementStatusLogs(id).catch(() => [] as RequirementStatusLog[]),
        api.listAttachments(id).catch(() => [] as Attachment[]),
        api.listRequirementDeliveries(id).catch(() => [] as RequirementDelivery[]),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      // 编辑中不要覆盖用户正在编辑的草稿
      setSpecDraft((prev) => editingSpec ? prev : data.requirement.spec_md);
      setRepos(repoList);
      setSubPrs(sub);
      setQuestions(qs);
      setRound(rd);
      setStatusLogs(slogs);
      setAttachments(atts);
      setDeliveries(dels);
      // 交付物文件由 DeliveriesCard 自己按轮按需拉（含历史轮），不在此预取
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      // 需求不存在（已删除 / 链接失效）：不弹 toast，由页面空态承接；其他错误（网络等）仍 toast
      if (!opts.silent && !/not.?found/i.test(msg)) {
        toast.error("加载失败", msg);
      }
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, [id, editingSpec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // v2 R6：拉取需求的全部根 run（execution / fix），按 seq 升序。
  // 有 task_id（已进入执行性状态）才拉；前置态（task_id 空）保持 runs=[] 不渲染执行记录卡。
  const loadRuns = useCallback(async (reqId: string) => {
    try {
      const list = await api.listTasksByRequirement(reqId);
      setRuns(list as RunLike[]);
      setRunsError(null);
    } catch (e: unknown) {
      setRunsError((e as Error)?.message ?? String(e));
    }
  }, []);

  // WebSocket 订阅：需求状态变化 / 问题更新时静默刷新
  // （不触发 loading 态，避免输入框被卸载导致 IME 输入中断）
  useEffect(() => {
    if (!id) return;
    return subscribe("requirement:*", (event: { type: string; payload?: { id?: string; req_id?: string; phase?: ClarifierRoundState["phase"] } & Partial<ClarifierRoundState> }) => {
      if (event.type === "requirement:clarifier-round-update") {
        const payload = event.payload as {
          req_id?: string;
          started_at?: number;
          phase?: ClarifierRoundState["phase"];
          attempt?: 0 | 1;
          prompt?: string | null;
          last_parse_error?: string | null;
        } | undefined;
        if (!payload || payload.req_id !== id) return;
        const phase = payload.phase;
        if (!phase || typeof payload.started_at !== "number") return; // defensive: 防 NaN / 缺字段
        if (phase === "done" || phase === "aborted" || phase === "errored") {
          setRound(null);
        } else {
          setRound({
            req_id: payload.req_id!,
            started_at: payload.started_at,
            phase,
            attempt: payload.attempt ?? 0,
            prompt: payload.prompt ?? null,
            last_parse_error: payload.last_parse_error ?? null,
          });
        }
        return;
      }
      const isForThis = event.payload?.id === id;
      if (!isForThis) return;
      if (
        event.type === "requirement:status-changed" ||
        event.type === "requirement:questions-updated" ||
        event.type === "requirement:question-resolved" ||
        event.type === "requirement:active-question-changed" ||
        event.type === "requirement:spec-revised" ||
        event.type === "requirement:clarifier-error"
      ) {
        void refresh({ silent: true });
      }
    });
  }, [id, subscribe, refresh]);

  // v2 R6：task:* 变化时重拉 run 列表（多 run 期间新 run 出现 / 状态推进要更新切换器）。
  // 仅在已有 task_id 时订阅；payload 不带 requirement_id 时也宽松重拉（成本低、列表小）。
  useEffect(() => {
    if (!req?.id || !req.task_id) return;
    const reqId = req.id;
    return subscribe("task:*", () => {
      void loadRuns(reqId);
    });
  }, [req?.id, req?.task_id, subscribe, loadRuns]);

  // 本地 1s tick 计时器：基于 round.started_at 推导已用秒数，
  // 避免依赖 WS 高频推送 elapsed 字段。
  useEffect(() => {
    if (!round) {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(Math.floor((Date.now() - round.started_at) / 1000));
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - round.started_at) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [round]);

  // WS 重连补拉 round（spec §5 边界）：
  // 断连期间可能丢 round-update 事件，连接恢复时主动 fetch 一次对齐。
  // 首次挂载时 wsState 通常是 "connecting"，不会立即触发；初次 round fetch 走 refresh() 路径。
  useEffect(() => {
    if (wsState !== "connected") return;
    if (!id) return;
    api.getClarifierRound(id).then(setRound).catch(() => undefined);
  }, [wsState, id]);

  useEffect(() => {
    if (!req?.project_id) { setProject(null); setProjectCodebases([]); return; }
    api.getProject(req.project_id).then(setProject).catch(() => setProject(null));
    api.listProjectWorkspaces(req.project_id).then(setProjectCodebases).catch(() => setProjectCodebases([]));
  }, [req?.project_id]);

  // 代码库反写后：静默重拉需求（workspace_ids）+ 项目代码库列表（自定义新建后出现新条目）
  const reloadWorkspaces = useCallback(() => {
    void refresh({ silent: true });
    if (req?.project_id) {
      api.listProjectWorkspaces(req.project_id).then(setProjectCodebases).catch(() => {});
    }
  }, [refresh, req?.project_id]);

  useEffect(() => {
    if (!req?.id) return;
    if (!req.task_id) { setRuns([]); setRunsError(null); return; }
    void loadRuns(req.id);
  }, [req?.id, req?.task_id, loadRuns]);

  // 选中 run：?run= 深链优先（仅当该 run 真存在于列表），否则默认最新（req.task_id）。
  // 多 run 期间新 run 出现 / task_id 变化时跟随到最新（除非用户已手动切到某历史轮且它仍在列表）。
  useEffect(() => {
    if (!runs || runs.length === 0) { setSelectedRunId(null); return; }
    const ids = new Set(runs.map((r) => r.id));
    setSelectedRunId((cur) => {
      if (cur && ids.has(cur)) return cur; // 用户当前选中仍有效，不打断
      if (runQuery && ids.has(runQuery)) return runQuery; // ?run= 深链选轮
      if (req?.task_id && ids.has(req.task_id)) return req.task_id; // 默认最新
      return runs[runs.length - 1]!.id; // 兜底：seq 最大的一条
    });
  }, [runs, runQuery, req?.task_id]);

  // 工作流选项（编辑期下拉用），一次性拉取
  useEffect(() => {
    api.listWorkflows()
      .then((ws) => setWorkflowOptions(ws.map((w) => ({ name: w.name, label: w.label, description: w.description ?? "", requires_git: w.requires_git }))))
      .catch(() => { /* 拉不到时下拉退化为只显示当前值 */ });
  }, []);

  // 选中阶段不再用本地 state —— 改由 ?step= 驱动（见下 activeStep）。缺 ?step 时 activeStep 自然
  // 等于 currentStep（随 status 推进自动跟随），有 ?step 时 pin 在该阶段，行为与旧 effect 等价且可分享。

  const repoAlias = useMemo(() => {
    if (!req) return "";
    if (!req.workspace_id) return "";
    return repos.find((r) => r.id === req.workspace_id)?.alias ?? req.workspace_id;
  }, [repos, req]);

  async function saveTitle() {
    if (!id) return;
    const next = titleDraft.trim();
    if (!next) {
      toast.error("标题不能为空");
      return;
    }
    if (req && next === req.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      await api.updateRequirement(id, { title: next });
      setEditingTitle(false);
      await refresh();
      toast.success("标题已更新");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingTitle(false);
    }
  }

  async function saveSpec() {
    if (!id) return;
    setSavingSpec(true);
    try {
      await api.updateRequirement(id, { spec_md: specDraft });
      setEditingSpec(false);
      await refresh();
      toast.success("已保存");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingSpec(false);
    }
  }

  async function changeWorkflow(name: string) {
    if (!id) return;
    setSavingWorkflow(true);
    try {
      await api.updateRequirement(id, { workflow: name });
      await refresh({ silent: true });
      toast.success(`工作流已切换为 ${name}`);
    } catch (e: unknown) {
      toast.error("切换失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function markReady() {
    if (!id) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      // 新 B 模式：走 finish-clarification endpoint（一并清 active_question_id + 进 awaiting_approval）
      // 而不是旧的 transitionRequirement(id, "ready") — 后者不清 active，会留下"已澄清"但 chat 还在的矛盾态。
      const res = await fetch(`/api/requirements/${encodeURIComponent(id)}/finish-clarification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      toast.success("已标记为「已澄清」");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function enqueue() {
    if (!id || !req) return;
    if (!req.workspace_id) {
      toast.error("请先选择代码库", "需要至少一个代码库才能入队执行，请在审批面板的「代码库」卡片中选择。");
      return;
    }
    // optimistic：UI 立刻反映 queued 状态，不等服务端响应
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "queued" });
    try {
      await api.enqueueRequirement(id);
      toast.success("已入队执行", { label: "看任务 →", onClick: () => navigate("/tasks") });
    } catch (e: unknown) {
      setReq(prev); // rollback
      toast.error("入队失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function approve() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "queued" });
    try {
      await api.enqueueRequirement(id);
      toast.success("已审批通过，任务进入队列", { label: "看任务 →", onClick: () => navigate("/tasks") });
    } catch (e: unknown) {
      setReq(prev);
      toast.error("审批失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function rejectApproval() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "drafting" });
    try {
      await api.transitionRequirement(id, "drafting");
      toast.success("已驳回，需求返回草稿");
    } catch (e: unknown) {
      setReq(prev);
      toast.error("驳回失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  /** drafting → clarifying：用户确认代码库后显式开始澄清（守卫在 RPC：代码库集合为空会被拒） */
  async function startClarify() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "clarifying");
      await refresh({ silent: true });
      toast.success("已开始澄清，AI 正在克隆代码库并调查");
    } catch (e: unknown) {
      toast.error("开始澄清失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function resumeClarify() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "clarifying" });
    try {
      await api.transitionRequirement(id, "clarifying");
      toast.success("已重新进入澄清，AI 正在思考下一个问题");
    } catch (e: unknown) {
      setReq(prev);
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function markDone() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "done" });
    try {
      await api.transitionRequirement(id, "done");
      toast.success("需求已标记完成");
    } catch (e: unknown) {
      setReq(prev);
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  // 「要求修改」已并入审查对话卡：发布带正文的审查意见即触发修复（空转 fix_revision 无意义，已删 requestFix）

  async function retryFromFailed() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "queued" });
    try {
      await api.enqueueRequirement(id);
      toast.success("已重新入队执行", { label: "看任务 →", onClick: () => navigate("/tasks") });
    } catch (e: unknown) {
      setReq(prev);
      toast.error("重试失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function recallToReady() {
    if (!id) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "ready");
      await refresh();
      toast.success("已撤回至「已澄清」");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function inject() {
    if (!id || !feedbackBody.trim()) return;
    // optimistic：立刻清空输入 + 假装成功；失败回滚 textarea 内容
    const prevBody = feedbackBody;
    setFeedbackBody("");
    setSubmittingFeedback(true);
    try {
      await api.injectFeedback(id, prevBody.trim());
      await refresh({ silent: true }); // 反馈历史 + 状态（awaiting_review→fix_revision）立即可见
      toast.success("反馈已提交");
    } catch (e: unknown) {
      setFeedbackBody(prevBody); // 失败把内容恢复让用户改后再试
      toast.error("提交失败", (e as Error)?.message ?? String(e));
    } finally {
      setSubmittingFeedback(false);
    }
  }

  async function cancel() {
    if (!id) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      await api.cancelRequirement(id);
      await refresh();
      toast.success("需求已取消");
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

  async function deleteReq() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      const res = await api.deleteRequirement(id);
      const extra = res.deletedTasks > 0 ? `（含 ${res.deletedTasks} 条执行记录）` : "";
      toast.success(`需求已删除${extra}`);
      navigate(req.project_id ? `/projects/${req.project_id}` : "/projects");
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
      busyRef.current = false;
      setActionBusy(false);
      throw e; // 让 ConfirmDialog 退出 busy 态，弹窗保持打开供重试
    }
  }

  async function submitReply(qid: string) {
    if (!id) return;
    const text = (replyDrafts[qid] ?? "").trim();
    if (!text) return;
    setReplyingId(qid);
    try {
      await api.addQuestionReply(id, qid, { author_role: "user", text });
      // 回复即视为解决，无需额外手动点击
      await api.resolveQuestion(id, qid);
      setReplyDrafts((d) => ({ ...d, [qid]: "" }));
      await refresh();
    } catch (e: unknown) {
      toast.error("回复失败", (e as Error)?.message ?? String(e));
    } finally {
      setReplyingId(null);
    }
  }

  async function resolveQ(qid: string) {
    if (!id) return;
    setResolvingId(qid);
    try {
      await api.resolveQuestion(id, qid);
      await refresh();
      toast.success("问题已标记为已解决");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      setResolvingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="mt-3 text-xs">加载需求…</p>
      </div>
    );
  }
  if (!req) {
    // 不存在（已删除 / 链接失效）：页面空态承接，不弹 toast
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card">
          <FileQuestion className="h-7 w-7 text-muted-foreground/60" />
        </div>
        <h2 className="mt-5 text-lg font-semibold">需求不存在</h2>
        <p className="mt-1.5 max-w-sm text-center text-sm text-muted-foreground">
          这条需求可能已被删除，或者链接已失效。
          {id && <span className="mt-1 block font-mono text-[11px] text-muted-foreground/70">{id}</span>}
        </p>
        <div className="mt-6 flex items-center gap-2">
          <Button size="sm" onClick={() => navigate("/tasks")}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回流水线
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/library")}>
            查看项目
          </Button>
        </div>
      </div>
    );
  }

  const currentStep = resolveCurrentStep(req.status, req.status_before_terminal);
  // ?step= 合法则 pin 到该阶段，否则跟随当前阶段（缺省 = 最新生命周期）。
  const activeStep: ReqStep =
    stepQuery && (STEP_ORDER as string[]).includes(stepQuery) ? (stepQuery as ReqStep) : currentStep;

  // 阶段 / run 深链写入（RESTful 路径）：选当前阶段 = 回到 /requirements/:id（「跟随最新」默认），
  // 其余 pin 到 /:id/:step；选 run = /:id/execute/:taskId。replace:true 不堆历史栈，URL 仍实时反映。
  const selectStep = (step: ReqStep) => {
    navigate(step === currentStep ? `/requirements/${id}` : `/requirements/${id}/${step}`, { replace: true });
  };
  const selectRun = (taskId: string) => {
    setSelectedRunId(taskId); // 立即反馈，URL 随后同步
    navigate(`/requirements/${id}/execute/${taskId}`, { replace: true });
  };

  const isTerminal = TERMINAL_STATUSES.has(req.status);
  const isAborted = req.status === "cancelled" || req.status === "failed";
  const openQuestions = questions.filter((q) => q.status === "open");
  const resolvedQuestions = questions.filter((q) => q.status === "resolved");
  // 需求级状态日志派生：审批通过 / 开始执行的时间点（migration 030 起记录，历史需求可能无记录）
  const approvalLog = [...statusLogs].reverse().find((l) => l.to_status === "queued");
  const startRunLog = [...statusLogs].reverse().find((l) => l.from_status === "queued" && l.to_status === "running");

  /** 滚到某个锚点（NextStepCTA 在 awaiting_review/fix_revision 时跳反馈区、有未答问题时跳问答区） */
  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── 可复用片段：spec 卡 / 子PR / 反馈历史 / 任务执行视图 ──

  const specCard = (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">需求内容</span>
          {req.spec_md && (req.status === "clarifying" || req.status === "drafting") && (
            <Badge variant="info">AI 整理</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRevisionsOpen(true)}
            className="gap-1.5 text-xs text-muted-foreground"
          >
            <History className="h-3.5 w-3.5" />
            修订历史
          </Button>
          {!editingSpec && canEditRequirementContent(req.status) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSpecDraft(req.spec_md);
                setEditingSpec(true);
              }}
            >
              编辑
            </Button>
          )}
          {!editingSpec && !canEditRequirementContent(req.status) && (
            <span
              className="font-mono text-[10px] text-muted-foreground"
              title="审批通过后需求内容就锁定了，按入队那一刻的版本执行。如果失败了，可以改完再重试。"
            >
              已冻结
            </span>
          )}
        </div>
      </div>
      <div className="p-5">
        {editingSpec ? (
          <div className="space-y-3">
            <Textarea
              value={specDraft}
              onChange={(e) => setSpecDraft(e.target.value)}
              className="min-h-[240px] font-mono text-xs"
              disabled={savingSpec}
              placeholder="在这里写需求的详细内容（支持 Markdown）…"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingSpec(false);
                  setSpecDraft(req.spec_md);
                }}
                disabled={savingSpec}
              >
                取消
              </Button>
              <Button size="sm" onClick={saveSpec} disabled={savingSpec}>
                {savingSpec ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="scrollbar-thin max-h-[600px] overflow-auto rounded-md border border-border bg-muted/30 p-4">
            {req.spec_md ? (
              <MarkdownView content={req.spec_md} />
            ) : (
              <span className="italic text-muted-foreground text-sm">还没有内容，点「编辑」添加。</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );

  const subPrCard = subPrs.length > 0 ? (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">交付 PR</span>
        <Badge variant="secondary">{subPrs.length}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {subPrs.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-4 py-2 font-mono text-xs">
            <span className="text-muted-foreground">
              {projectCodebases.find((cb) => cb.id === p.child_workspace_id)?.alias ?? p.child_workspace_id}
            </span>
            <a
              href={p.pr_url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
            >
              PR #{p.pr_number}
              <ExternalLink className="h-3 w-3" />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  ) : null;

  // artifacts 交付（v2 R5）：有交付物记录且无任何交付 PR（hasPr 优先——混合交付不支持，PR 赢）
  const hasAnyPr = !!req.pr_url || (req.pr_number ?? 0) > 0 || subPrs.length > 0;
  const isArtifactsDelivery = deliveries.length > 0 && !hasAnyPr;

  // 交付物验收卡：按类型展示（图片缩略图+预览 / md·文本内联 / html 隔离新标签 / 二进制下载）+ 多轮时间线。
  // 通过/驳回动作在「审查与修复」卡（验收通过按钮 / 驳回 = 发布审查意见），与 PR 验收同管道。
  const deliveriesCard = <DeliveriesCard reqId={req.id} deliveries={deliveries} />;

  // 审查与修复对话卡（验收步专属）：时间线（审查意见 / GitHub review / Agent 修复回应 +
  // 进行中的修复进度条目）+ 底部发布输入框 —— 每发一条意见，对应的「正在做什么 / 进度 /
  // 结果」都回到同一个时间线里，不再分散在执行页的多个卡片。
  // residue（上一次失败 run 沉淀的历史评审遗留）不属于当前 PR 的审查线程，整体不在验收卡显示
  // ——它只服务 scheduler 重跑上下文（后端直接读 comments），跟当前 PR 评审无关。
  const reviewThread = feedbacks.filter(
    (fb) => (fb.subtype ?? (fb.from_role === "agent" ? "fix" : "review")) !== "residue",
  );
  const reviewThreadCard = (
    <Card id="feedback-section">
      {/* 头部 = 验收决策条：标题 + PR 链接在左，「验收通过」主按钮在右（原独立决策条已并入） */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">审查与修复</span>
        {reviewThread.length > 0 && (
          <Badge variant="muted">{reviewThread.length}</Badge>
        )}
        {req.pr_url && (
          <a
            href={req.pr_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
          >
            PR #{req.pr_number}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {req.status === "awaiting_review" && (
          <Button
            variant="default"
            size="sm"
            className="ml-auto text-xs"
            onClick={() => void markDone()}
            disabled={actionBusy}
          >
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 验收通过 · 完成
          </Button>
        )}
      </div>
      <div className="p-5">
        {reviewThread.length === 0 && req.status !== "fix_revision" ? (
          <p className="font-mono text-xs text-muted-foreground">
            {isArtifactsDelivery
              ? "还没有审查记录。查看上方交付物后：通过点「验收通过」；不满意发布审查意见，Agent 会按意见重做产物并在此回应。"
              : "还没有审查记录。发布审查意见后 Agent 会按意见修复并在此回应；GitHub 上的 Request Changes 与 CI 失败也会自动进入这里。"}
          </p>
        ) : (
          <ol className="space-y-2.5">
            {/* 对话双方用底色 + 图标区分：用户/GitHub = 中性卡，Agent 回应 = accent 淡底卡。
                residue 已在 reviewThread 过滤掉，此处只剩当前 PR 的评审意见 / Agent 修复回应。 */}
            {reviewThread.map((fb) => {
              const isFix = (fb.subtype ?? (fb.from_role === "agent" ? "fix" : "review")) === "fix";
              return (
                <li
                  key={fb.id}
                  className={cn(
                    "rounded-md border p-3",
                    isFix ? "border-accent/25 bg-accent/5" : "border-border bg-muted/30",
                  )}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    {isFix
                      ? <Bot className="h-3.5 w-3.5 text-accent" />
                      : <UserRound className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className={cn("text-xs font-medium", isFix ? "text-accent" : "text-muted-foreground")}>
                      {isFix ? "Agent 修复" : (SOURCE_LABEL[fb.source] ?? fb.source)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {new Date(fb.created_at).toLocaleString()}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                    {fb.body}
                  </pre>
                </li>
              );
            })}
            {/* 进行中的修复 = 时间线的活跃条目。fix 是标准 run（v2 R3）：实时进度 / 日志 /
                agent 调用全在下方「执行记录」（task_id 已指向修复轮），此处只给状态 + 跳转 */}
            {req.status === "fix_revision" && (
              <li className="rounded-md border border-accent/25 bg-accent/5 p-3">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span className="text-xs font-medium text-accent">Agent 修复执行中</span>
                  {req.task_id && (
                    <a
                      href="#task-record"
                      className="ml-auto font-mono text-[11px] text-accent hover:underline"
                    >
                      查看执行 →
                    </a>
                  )}
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {isArtifactsDelivery
                    ? "按上方最新意见重做产物，完成后交付新的一轮并在这里回应总结"
                    : "按上方最新意见在交付分支上修改，完成后更新 PR 并在这里回应总结"}
                  {req.task_id ? "；实时进度与日志见下方「执行记录」" : ""}
                </p>
              </li>
            )}
          </ol>
        )}
      </div>
      {/* 发布入口：验收中 / 修复中都可追加意见（修复中追加 = 下一轮修复的输入）。
          status 即活跃性判据 —— done/cancelled 回看时自动无输入框 */}
      {(req.status === "awaiting_review" || req.status === "fix_revision") && (
        <div className="border-t border-border p-4">
          <Textarea
            value={feedbackBody}
            onChange={(e) => setFeedbackBody(e.target.value)}
            placeholder={req.status === "awaiting_review"
              ? "填写审查意见…（发布后 Agent 立即开始修复，进度和结果会回到这里）"
              : "补充意见…（当前修复完成后，新意见会触发下一轮修复）"}
            className="min-h-[72px] text-xs"
            disabled={submittingFeedback}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void inject();
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              onClick={() => void inject()}
              disabled={submittingFeedback || !feedbackBody.trim()}
            >
              {submittingFeedback ? "发布中…" : "发布审查意见"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );

  // 执行视图：展开常驻（带标题头），所有阶段一致呈现，不折叠。
  // v2 R6：一个需求重跑 / 修复会产生多个 run（task）。
  //  - 前置态（task_id 空）：不渲染执行记录卡（保持现状，不加空卡）
  //  - 单 run（runs<=1）：零噪音直接渲染 TaskDetail embedded，不加任何切换器外壳
  //  - 多 run（runs>=2）：卡头部插横向切换器，选中轮渲染 TaskDetail embedded
  // multiRun 视选中 run 而非固定 req.task_id（深链 / 历史轮可看）。
  const taskRecord = (() => {
    if (!req.task_id) return null; // empty：前置态，不渲染
    const multiRun = !!runs && runs.length >= 2;
    // 当前展示的 run id：多 run 用切换器选中态，否则用需求当前 run（task_id）
    const shownTaskId = multiRun ? (selectedRunId ?? req.task_id) : req.task_id;
    return (
      <Card id="task-record">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium">执行记录</span>
        </div>
        {/* loading：切换器位用骨架；多 run：切换器 */}
        {runs === undefined ? (
          <div className="px-4 pt-3">
            <SkeletonRows variant="row" count={1} />
          </div>
        ) : multiRun ? (
          <RunSwitcher runs={runs} activeTaskId={shownTaskId} onSelect={selectRun} />
        ) : null}
        <div className="p-5">
          {runsError ? (
            // error：runs 拉取失败 / 选中 run 异常。run 自身 failed ≠ 区 error（失败 run 正常进切换器）
            <ErrorState
              title="加载执行记录失败"
              detail={runsError}
              onRetry={() => { setRunsError(null); void loadRuns(req.id); }}
            />
          ) : (
            <TaskDetail key={shownTaskId} taskId={shownTaskId} embedded subscribe={subscribe} />
          )}
        </div>
      </Card>
    );
  })();

  // 澄清期 AI 状态行（出错 / 进度 / idle 三选一）
  const clarifierStatus = (
    <>
      {req.clarifier_error && req.status === "clarifying" && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="font-mono text-xs text-destructive font-medium">⚠ 澄清出错</div>
              <p className="text-sm text-muted-foreground break-words">{req.clarifier_error}</p>
              {/* 换模型入口：失败时也可达（不再卡在 questions>0），换个模型重试 */}
              <button
                type="button"
                onClick={() => setClarifierDialogOpen(true)}
                className="inline-flex items-center gap-1 pt-1 font-mono text-[10px] text-muted-foreground hover:text-accent"
                title="换个模型再重试澄清"
              >
                <Settings2 className="h-3 w-3" />
                澄清模型：{req.clarifier_model ?? req.clarifier_provider ?? "全局默认"} · 点击更换
              </button>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={retryingClarify}
              onClick={async () => {
                if (!id) return;
                setRetryingClarify(true);
                try {
                  const res = await fetch(`/api/requirements/${encodeURIComponent(id)}/retry-clarify`, { method: "POST" });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                  }
                  toast.success("已重新触发 AI 澄清");
                } catch (e: unknown) {
                  toast.error("重试失败", (e as Error)?.message ?? String(e));
                } finally {
                  setRetryingClarify(false);
                }
              }}
              className="shrink-0"
            >
              {retryingClarify ? "重试中…" : "↻ 重试"}
            </Button>
          </div>
        </Card>
      )}

      {!req.clarifier_error && req.status === "clarifying" && round && ACTIVE_PHASES.has(round.phase) && (
        <ClarifierProgressCard
          round={round}
          elapsedSec={elapsedSec}
          traceOpen={traceOpen}
          onToggleTrace={() => setTraceOpen((v) => !v)}
        />
      )}

      {!req.clarifier_error && req.status === "clarifying" && !round && questions.length === 0 && (
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
            <span className="flex-1 font-mono text-xs text-muted-foreground">
              AI 正在分析需求，生成澄清问题…
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={retryingClarify}
              onClick={async () => {
                if (!id) return;
                setRetryingClarify(true);
                try {
                  const res = await fetch(`/api/requirements/${encodeURIComponent(id)}/retry-clarify`, { method: "POST" });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                  }
                  toast.success("已重新触发 AI 澄清");
                  void refresh({ silent: true });
                } catch (e: unknown) {
                  toast.error("重试失败", (e as Error)?.message ?? String(e));
                } finally {
                  setRetryingClarify(false);
                }
              }}
              className="shrink-0"
            >
              {retryingClarify ? "重试中…" : "↻ 重试"}
            </Button>
          </div>
        </Card>
      )}
    </>
  );

  // 附件区块：创建阶段 / 澄清阶段均可上传
  const attachmentSection = req ? (
    <section className="mt-6">
      <h3 className="mb-2 font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider">
        附件
      </h3>
      <div className="space-y-2">
        <AttachmentList
          requirementId={req.id}
          attachments={attachments}
          onDeleted={(attId) => setAttachments((prev) => prev.filter((a) => a.id !== attId))}
          readOnly={!canEditRequirementContent(req.status)}
        />
        {canEditRequirementContent(req.status) && (
          <AttachmentUploader
            requirementId={req.id}
            onUploaded={(newAtts) => setAttachments((prev) => [...prev, ...newAtts])}
          />
        )}
      </div>
    </section>
  ) : null;

  // 澄清对话 chat
  const chatCard = questions.length > 0 ? (
    <Card id="clarification-section">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">需求澄清</span>
        <button
          type="button"
          onClick={() => setClarifierDialogOpen(true)}
          className="ml-2 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-accent"
          title="为此需求配置 clarifier 模型"
        >
          <Settings2 className="h-3 w-3" />
          模型：{req.clarifier_model ?? req.clarifier_provider ?? "全局默认"}
        </button>
        {openQuestions.length > 0 && (
          <Badge variant="warning" className="ml-auto">{openQuestions.length} 待回复</Badge>
        )}
      </div>

      {openQuestions.length > 0 && (
        <div className="space-y-4 p-5">
          {openQuestions.map((q) => renderQuestion(q, { replyDrafts, setReplyDrafts, replyingId, submitReply }))}
        </div>
      )}

      {resolvedQuestions.length > 0 && (
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <span>历史问答 · {resolvedQuestions.length} 条</span>
          </summary>
          <div className="space-y-4 p-5 pt-3">
            {resolvedQuestions.map((q) => renderQuestion(q, { replyDrafts, setReplyDrafts, replyingId, submitReply }))}
          </div>
        </details>
      )}

      {req.status === "clarifying" && openQuestions.length === 0 && resolvedQuestions.length > 0 && (
        <div className="mx-5 mb-5 flex items-center gap-3 rounded-md border border-border bg-card/40 px-4 py-3">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
          <p className="font-mono text-xs text-muted-foreground">AI 正在思考下一个问题…</p>
        </div>
      )}

      {req.status === "drafting" && resolvedQuestions.length > 0 && (
        <div className="mx-5 mb-5 flex flex-col gap-3 rounded-md border border-border bg-card/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-xs text-muted-foreground">
            草稿状态。点击右侧让 AI 基于以上对话和当前 SPEC 继续澄清。
          </p>
          <Button size="sm" onClick={resumeClarify} disabled={actionBusy} className="shrink-0 self-start sm:self-auto">
            {actionBusy ? "处理中…" : "↻ 继续澄清"}
          </Button>
        </div>
      )}
    </Card>
  ) : null;

  return (
    <div className={PAGE_W}>
      {/* 顶部导航条 */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(req?.project_id ? `/projects/${req.project_id}` : "/projects")}
          className="-ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
          {req?.project_id ? "返回项目" : "项目列表"}
        </Button>
        <div className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          {wsState === "connected" ? (
            <><Wifi className="h-3 w-3 text-success" />实时</>
          ) : (
            <><WifiOff className="h-3 w-3" />离线</>
          )}
        </div>
      </div>

      {/* Hero：标题（可编辑）+ 状态徽章 + 链接 chips */}
      <header className="mb-5">
        {editingTitle ? (
          <div className="space-y-2">
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              disabled={savingTitle}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); saveTitle(); }
                if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(req.title); }
              }}
              className="h-auto break-words py-1.5 text-lg font-semibold leading-tight tracking-tight lg:text-2xl"
              placeholder="需求标题"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveTitle} disabled={savingTitle || !titleDraft.trim()}>
                {savingTitle ? "保存中…" : "保存"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setEditingTitle(false); setTitleDraft(req.title); }}
                disabled={savingTitle}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-3">
            <div className="flex min-w-0 items-start gap-2">
              {/* 与 PageHero 标题排版对齐（衬线 4xl hero 已废弃） */}
              <h1 className="break-words text-lg font-semibold leading-tight tracking-tight lg:text-2xl">
                {req.title}
              </h1>
              {canEditRequirementContent(req.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
                  title="编辑标题"
                  onClick={() => { setTitleDraft(req.title); setEditingTitle(true); }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="text-xs">编辑</span>
                </Button>
              )}
            </div>
            {/* 需求级操作：取消（非终态）/ 删除，常驻右上（原危险区折叠已移除） */}
            <div className="flex shrink-0 gap-2 lg:pt-1">
              {!isTerminal && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setCancelOpen(true)}
                  disabled={actionBusy}
                >
                  取消需求
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={actionBusy}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                删除需求
              </Button>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={STATUS_VARIANT[req.status] ?? "outline"}>
            {/* artifacts 交付（无 PR）：验收信号 = 本页人工通过/驳回，不是 PR review */}
            {req.status === "awaiting_review" && isArtifactsDelivery
              ? "待验收"
              : STATUS_LABEL[req.status] ?? req.status}
          </Badge>
          {project && (
            <Link
              to={`/projects/${project.id}`}
              className="font-mono text-[11px] text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {project.name}
            </Link>
          )}
          {req.pr_url && (
            <a
              href={req.pr_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
            >
              PR #{req.pr_number}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {/* 元信息：紧凑横排（原右侧栏 meta 卡内容；状态/项目已在上方 Badge 行不重复）。
            不再露 TASK id —— 用户视角「需求」就是这件工作本身，task 是内核执行概念 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>ID <code className="text-accent">{req.id}</code></span>
          {/* 代码库平铺：集合内全部库平级展示（主库概念已废除，workspace_id 只是缓存列） */}
          <span>
            代码库{" "}
            {(() => {
              const ids = (req.workspace_ids?.length ?? 0) > 0
                ? req.workspace_ids!
                : req.workspace_id ? [req.workspace_id] : [];
              if (ids.length === 0) return "未关联";
              return ids
                .map((wid) => projectCodebases.find((cb) => cb.id === wid)?.alias ?? wid)
                .join(" · ");
            })()}
          </span>
          {/* 工作流：审批通过后才在元信息展示（审批前尚未定案，选择器在「下一步」banner）。
              终态（failed/cancelled）按死亡前状态判断是否已过审批 */}
          {(() => {
            const PRE_APPROVAL = new Set(["drafting", "clarifying", "ready", "awaiting_approval"]);
            const effective = isAborted ? (req.status_before_terminal ?? req.status) : req.status;
            if (PRE_APPROVAL.has(effective)) return null;
            return (
              <span className="inline-flex items-center gap-1">
                工作流{" "}
                <code title={`内核名：${req.workflow ?? "dev"}（审批后随内容冻结）`}>
                  {workflowOptions.find((w) => w.name === (req.workflow ?? "dev"))?.label ?? req.workflow ?? "dev"}
                </code>
              </span>
            );
          })()}
          <span>创建 {new Date(req.created_at).toLocaleString()}</span>
          <span>更新 {new Date(req.updated_at).toLocaleString()}</span>
        </div>
      </header>

      {/* 步骤进度条：6 步可点击，默认当前步；窄屏非选中步只显示数字圈 + overflow 兜底 */}
      <div className="mb-5 overflow-x-auto rounded-lg border border-border bg-card/40 px-3 py-3 sm:px-4">
        <StepBar status={req.status} statusBeforeTerminal={req.status_before_terminal} selected={activeStep} onSelect={selectStep} />
      </div>

      {/* 下一步主 CTA banner；审批/入队/重试 = 决定执行方式的时刻，工作流选择内联在按钮旁 */}
      <NextStepCTA
        status={req.status}
        openQuestionCount={openQuestions.length}
        busy={actionBusy}
        extra={
          canEditRequirementContent(req.status) &&
          ["ready", "awaiting_approval", "failed"].includes(req.status) ? (
            <div
              className="flex items-center gap-2"
              title="该需求入队后用哪个工作流执行；审批后冻结"
            >
              <span className="shrink-0 text-xs text-muted-foreground">工作流</span>
              <Select
                value={req.workflow ?? "dev"}
                onValueChange={(v) => void changeWorkflow(v)}
                disabled={savingWorkflow || workflowOptions.length === 0}
              >
                <SelectTrigger className="h-10 w-auto min-w-[170px] gap-2 bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workflowOptions.length === 0 && (
                    <SelectItem value={req.workflow ?? "dev"}>{req.workflow ?? "dev"}</SelectItem>
                  )}
                  {workflowOptions.map((w) => (
                    // 业务标签（中文 label）为主，内核名括注（无 label 的工作流只显示 name）
                    <SelectItem key={w.name} value={w.name}>
                      {w.label ? `${w.label}（${w.name}）` : w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : undefined
        }
        onMarkReady={markReady}
        onEnqueue={enqueue}
        onApprove={approve}
        onRetry={() => void retryFromFailed()}
        onScrollToQuestions={() => scrollToSection("clarification-section")}
      />

      {/* 主体：单列（元信息已上移标题下、危险区沉底，不再有右侧栏） */}
      <div className="mt-6">
        {/* 主区：随选中步骤切换；过去步只读，未到达占位 */}
        <div className="space-y-4 min-w-0">
          {activeStep !== currentStep && (
            <button
              type="button"
              onClick={() => selectStep(currentStep)}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              ↩ 回到当前步骤（{STEPS.find((s) => s.key === currentStep)?.label}）
            </button>
          )}

          {/* 终态卡：显示在死亡步（✗ 所在步），失败/取消原因与该步上下文同屏 */}
          {isAborted && activeStep === currentStep && (
            <Card className="p-5">
              {req.status === "failed" && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-destructive">执行失败</p>
                  {req.status_reason && (
                    <div className="rounded-lg bg-destructive/8 p-2.5">
                      <p className="break-words text-xs leading-relaxed text-foreground/85">{req.status_reason}</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">可在上方「重新入队执行」重试，或退回草稿改需求。</p>
                </div>
              )}
              {req.status === "cancelled" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">需求已取消</span>
                    <span
                      className={
                        "rounded border px-1.5 py-0.5 font-mono text-[9px] "
                        + (req.status_reason && req.status_reason_source !== "user"
                          ? "border-warning/60 text-warning"
                          : "border-border text-muted-foreground")
                      }
                      title="内核状态：cancelled（trigger: cancel）"
                    >
                      {req.status_reason_source === "user" || !req.status_reason ? "手动取消" : "系统自动止损"}
                    </span>
                  </div>
                  {req.status_reason && (
                    <div className="rounded-lg bg-muted/50 p-2.5">
                      <p className="break-words text-xs leading-relaxed text-foreground/85">{req.status_reason}</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {req.task_id
                      ? "详细原因（驳回轨迹 / reviewer 原话）见下方执行记录。已取消的需求不可重启，如需继续请新建需求。"
                      : "已取消的需求不可重启，如需继续请新建需求。"}
                  </p>
                </div>
              )}
            </Card>
          )}

          {(() => {
            const pos = stepPosition(activeStep, currentStep);
            if (pos === "future") {
              const label = STEPS.find((s) => s.key === activeStep)?.label ?? "";
              const curLabel = STEPS.find((s) => s.key === currentStep)?.label ?? "";
              return (
                <Card className="p-6 text-center text-sm text-muted-foreground">
                  {isAborted
                    ? `需求已在「${curLabel}」步终止，未到达「${label}」。`
                    : `「${label}」尚未开始。完成前序步骤后会进入这一步。`}
                </Card>
              );
            }
            const readonly = pos === "past";

            if (activeStep === "clarify") {
              // drafting = 澄清未开始：先确认工作流 + 代码库（澄清 agent 在其浅 clone 中调查），再显式开始
              if (req.status === "drafting" && !readonly) {
                // 守卫与 RPC 同口径：代码库集合非空（workspace_id 只是缓存列）；
                // 所选工作流 requires.git 非 true（即 false——二态，optional 已废弃）时允许空集确认（v2 R5 无库闭环）
                const hasWorkspaces = (req.workspace_ids?.length ?? 0) > 0 || !!req.workspace_id;
                const wfDecl = workflowOptions.find((w) => w.name === (req.workflow ?? "dev"));
                const gitNotRequired = !!wfDecl && wfDecl.requires_git !== undefined && wfDecl.requires_git !== true;
                return (
                  <>
                    {/* 工作流先于代码库确认：requires.git 由所选工作流决定（业务标签 + 内核名叠加） */}
                    <Card className="p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="shrink-0 text-sm font-semibold">工作流</span>
                        <Select
                          value={req.workflow ?? "dev"}
                          onValueChange={(v) => void changeWorkflow(v)}
                          disabled={savingWorkflow || actionBusy || workflowOptions.length === 0}
                        >
                          <SelectTrigger className="h-9 w-auto min-w-[170px] gap-2 bg-background text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {workflowOptions.length === 0 && (
                              <SelectItem value={req.workflow ?? "dev"}>{req.workflow ?? "dev"}</SelectItem>
                            )}
                            {workflowOptions.map((w) => (
                              <SelectItem key={w.name} value={w.name}>
                                {w.label ? `${w.label}（${w.name}）` : w.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {gitNotRequired ? "此工作流不要求代码库" : "此工作流需要代码库"}
                        </span>
                      </div>
                    </Card>
                    <RequirementWorkspacePicker
                      requirement={req}
                      workspaces={projectCodebases}
                      disabled={actionBusy}
                      allowEmpty={gitNotRequired}
                      emptyHint={`工作流「${wfDecl?.label ?? wfDecl?.name ?? req.workflow ?? "dev"}」不要求代码库`}
                      onChanged={reloadWorkspaces}
                    />
                    <Button
                      className="w-full"
                      onClick={startClarify}
                      disabled={actionBusy || (!hasWorkspaces && !gitNotRequired)}
                      title={!hasWorkspaces && !gitNotRequired ? "请先选一个代码库，AI 澄清时要读它" : undefined}
                    >
                      {actionBusy
                        ? "处理中…"
                        : hasWorkspaces
                          ? "确认代码库，开始 AI 澄清 →"
                          : gitNotRequired
                            ? "确认无代码库，开始 AI 澄清 →"
                            : "确认代码库，开始 AI 澄清 →"}
                    </Button>
                    {specCard}
                    {attachmentSection}
                  </>
                );
              }
              return (
                <>
                  {/* 澄清进行中/回看：常驻展示已确认的代码库（冻结，只读） */}
                  <RequirementWorkspacePicker
                    requirement={req}
                    workspaces={projectCodebases}
                    readOnly
                    onChanged={reloadWorkspaces}
                  />
                  {clarifierStatus}
                  {chatCard}
                  {!readonly && (
                    <Button
                      variant="outline"
                      className="w-full"
                      size="sm"
                      onClick={markReady}
                      disabled={actionBusy}
                      title="跳过 AI 澄清流程，直接标记为已澄清"
                    >
                      {actionBusy ? "处理中…" : "跳过澄清，标为已澄清"}
                    </Button>
                  )}
                  {specCard}
                  {attachmentSection}
                </>
              );
            }

            if (activeStep === "approve") {
              return (
                <>
                  {req.schedule_error && (
                    <Card className="p-4">
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 text-destructive">⚠</span>
                        <div className="min-w-0 text-sm">
                          <p className="font-medium text-destructive">上次起任务失败，已退回</p>
                          <p className="mt-0.5 break-words text-muted-foreground">{req.schedule_error}</p>
                          <p className="mt-1 text-xs text-muted-foreground">修复后点上方「入队执行」可重试。</p>
                        </div>
                      </div>
                    </Card>
                  )}
                  {readonly ? (
                    /* 回看模式：审批步的特异信息是「何时、以何种方式通过审批」，spec 在侧栏 */
                    <Card className="p-5">
                      {approvalLog ? (
                        <div className="flex items-center gap-2 text-sm">
                          <CheckCircle2 className="h-4 w-4 text-success" />
                          <span className="font-medium">
                            {approvalLog.from_status === "awaiting_approval" ? "已通过人工审批" : "已直接入队（跳过人工审批）"}
                          </span>
                          <span
                            className="ml-auto font-mono text-[11px] text-muted-foreground"
                            title={`${approvalLog.from_status} → ${approvalLog.to_status}`}
                          >
                            {new Date(approvalLog.created_at).toLocaleString()}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          审批时间未记录（该需求的审批发生在状态日志上线之前）。
                        </p>
                      )}
                    </Card>
                  ) : (
                    <>
                      {/* 审批阶段：代码库在澄清前确认、开始澄清即冻结（中途换库会让澄清失效），只读展示 */}
                      <RequirementWorkspacePicker
                        requirement={req}
                        workspaces={projectCodebases}
                        readOnly
                        onChanged={reloadWorkspaces}
                      />
                      {specCard}
                      {attachmentSection}
                      {req.status === "awaiting_approval" && (
                        <Button
                          variant="outline"
                          className="w-full"
                          size="sm"
                          onClick={rejectApproval}
                          disabled={actionBusy}
                          title="审批通过的主按钮在上方"
                        >
                          {actionBusy ? "处理中…" : "↩ 驳回，返回草稿"}
                        </Button>
                      )}
                    </>
                  )}
                </>
              );
            }

            if (activeStep === "execute") {
              // 排队已并入执行步：还在排队时内容显示排队中（spec/附件/执行记录 + 撤回），
              // 调度起跑后自然切换为执行内容
              if (req.status === "queued") {
                return (
                  <>
                    <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                      排队中 · 等调度器起任务
                    </Card>
                    {specCard}
                    {attachmentSection}
                    {taskRecord}
                    <Button variant="outline" className="w-full" size="sm" onClick={recallToReady} disabled={actionBusy}>
                      {actionBusy ? "处理中…" : "撤回（返回已澄清）"}
                    </Button>
                  </>
                );
              }
              return (
                <>
                  {subPrCard}
                  {taskRecord}
                </>
              );
            }

            if (activeStep === "review") {
              return (
                <>
                  {/* 验收步：artifacts 交付时交付物卡置顶（文件列表 + 下载），通过/驳回在下方
                      「审查与修复」卡（与 PR 验收同管道）；PR 交付时审查与修复对话置顶
                      （头部即决策条：PR 链接 + 验收通过按钮），改动 diff 在下方供对照。
                      id=feedback-section 是 NextStepCTA 的滚动锚 */}
                  {isArtifactsDelivery && deliveriesCard}
                  {reviewThreadCard}
                  {isArtifactsDelivery ? null : req.task_id ? (
                    <TaskFileDiffsCard taskId={req.task_id} reloadKey={req.status} />
                  ) : (
                    <Card className="p-6 text-center text-sm text-muted-foreground">无关联执行，没有可验收的改动。</Card>
                  )}
                </>
              );
            }

            // activeStep === "done"：完成步 = 交付结果 + 产物文件（执行细节回执行步看）
            return (
              <>
                {req.status === "done" && (
                  <Card className="p-5">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="font-medium">需求已完成</span>
                      {req.pr_url && (
                        <a
                          href={req.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
                        >
                          PR #{req.pr_number}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </Card>
                )}
                {/* artifacts 交付：完成步常驻交付物卡（交付物随需求保留，沙盒清理不影响下载） */}
                {isArtifactsDelivery && deliveriesCard}
                {req.task_id && <SandboxBrowser taskId={req.task_id} taskStatus={undefined} />}
              </>
            );
          })()}
        </div>

      </div>


      {/* spec_md 修订历史 Sheet */}
      <SpecRevisionsSheet
        open={revisionsOpen}
        onOpenChange={setRevisionsOpen}
        requirementId={req.id}
      />

      {/* 当前需求的 clarifier 模型 dialog */}
      <ClarifierOverrideDialog
        open={clarifierDialogOpen}
        onOpenChange={setClarifierDialogOpen}
        requirementId={req.id}
        currentProvider={req.clarifier_provider}
        currentModel={req.clarifier_model}
        onSaved={() => void refresh({ silent: true })}
      />

      {/* 取消需求确认：取消 = 只保留需求本身，清空执行痕迹 */}
      <ConfirmDialog
        open={cancelOpen}
        title={`取消需求「${req.title}」？`}
        danger
        confirmText="确认取消"
        message={
          <div className="space-y-2">
            <p>
              取消后只留下<strong>需求本身</strong>（需求内容、评论、附件），
              执行记录和代码副本会被<strong className="text-destructive">清空</strong>。
            </p>
            {(req.status === "running" || req.status === "fix_revision") && (
              <p className="text-xs font-semibold text-foreground">
                任务正在执行中 —— 将先停止运行中的 agent 再清理。
              </p>
            )}
            <p className="text-xs text-muted-foreground">已取消的需求不可重新启动。</p>
          </div>
        }
        onConfirm={async () => {
          await cancel();
          setCancelOpen(false);
        }}
        onCancel={() => setCancelOpen(false)}
      />

      {/* 删除需求确认（需求 + 名下执行记录统一删除）*/}
      <ConfirmDialog
        open={deleteOpen}
        title={`删除需求「${req.title}」？`}
        danger
        confirmText="确认删除"
        message={
          <div className="space-y-2">
            <p>
              将<strong className="text-destructive">永久删除</strong>此需求及其全部执行记录
              （需求内容、评论、附件、运行日志、agent 调用、代码副本）。
            </p>
            {(req.status === "running" || req.status === "fix_revision") && (
              <p className="text-xs font-semibold text-foreground">
                任务正在执行中 —— 将先尝试停止运行中的 agent 再删除。
              </p>
            )}
            <p className="text-xs text-muted-foreground">此操作不可恢复。</p>
          </div>
        }
        onConfirm={deleteReq}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
