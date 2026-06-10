import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare, CheckCircle2, Send, Wifi, WifiOff, Loader2, ChevronRight, Settings2, Pencil, History, Trash2 } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type RequirementSubPr, type Question, type Project, type Workspace, type ProviderItem, type ClarifierRoundState } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea, Input } from "@/components/ui/input";
import { TaskDetail } from "@/pages/TaskDetail";
import { statusToStage } from "@/components/StageRail";
import { StepBar } from "@/components/StepBar";
import { statusToStep, stepPosition, STEPS, type ReqStep } from "@/lib/requirement-steps";
import { NextStepCTA } from "@/components/NextStepCTA";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/Modal";
import { SpecRevisionsSheet } from "@/components/SpecRevisionsSheet";
import { MarkdownView } from "@/components/MarkdownView";
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

function MetaRow({
  k,
  v,
  last,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[88px_1fr] gap-3 px-3.5 py-2",
        !last && "border-b border-border",
      )}
    >
      <div className="text-muted-foreground">{k}</div>
      <div className="text-foreground">{v}</div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
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
            仅作用于本需求。继承全局表示用 /settings?tab=clarifier 的默认。
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
            {q.agent_text}
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
  "calling-llm": "调用 LLM 中",
  parsing: "解析返回（重试中）",
  writing: "写入 spec / 问题",
  done: "完成",
  aborted: "已中止",
  errored: "出错",
};

const ACTIVE_PHASES = new Set<ClarifierRoundState["phase"]>([
  "preparing",
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
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-muted-foreground">
            AI 正在思考…
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
            {attemptLabel} LLM 调用 · 阶段：{PHASE_LABEL[round.phase]}
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
            <div className="border border-l-4 border-border border-l-destructive bg-card px-3 py-2 rounded-md">
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
  const { id } = useParams<{ id: string }>();
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
  const [selectedStep, setSelectedStep] = useState<ReqStep | null>(null);
  const prevStatusRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async function refresh(opts: { silent?: boolean } = {}) {
    if (!id) return;
    if (!opts.silent) setLoading(true);
    try {
      const [data, repoList, sub, qs, rd] = await Promise.all([
        api.getRequirement(id),
        api.listWorkspaces(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
        api.listQuestions(id).catch(() => [] as Question[]),
        api.getClarifierRound(id).catch(() => null),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      // 编辑中不要覆盖用户正在编辑的草稿
      setSpecDraft((prev) => editingSpec ? prev : data.requirement.spec_md);
      setRepos(repoList);
      setSubPrs(sub);
      setQuestions(qs);
      setRound(rd);
    } catch (e: unknown) {
      if (!opts.silent) toast.error("加载失败", (e as Error)?.message ?? String(e));
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, [id, editingSpec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  // 默认选中当前步；status 变化时，若用户没手动切走则跟随到新当前步，否则不打断。
  useEffect(() => {
    if (!req) return;
    const cur = statusToStep(req.status);
    const prev = prevStatusRef.current;
    prevStatusRef.current = req.status;
    if (prev === undefined) {
      setSelectedStep(cur); // 初次加载：默认当前步
      return;
    }
    if (prev !== req.status) {
      const prevStep = statusToStep(prev);
      setSelectedStep((sel) => (sel === null || sel === prevStep ? cur : sel));
    }
  }, [req?.status]);

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
      toast.success("规约已保存");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingSpec(false);
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
      toast.error("请先关联工作区", "需要绑定工作区才能入队执行，请在下方选择工作区。");
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

  async function requestFix() {
    if (!id || !req) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    const prev = req;
    setReq({ ...req, status: "fix_revision" });
    try {
      await api.transitionRequirement(id, "fix_revision");
      toast.success("已标记需要修改，Agent 将继续修复");
    } catch (e: unknown) {
      setReq(prev);
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setActionBusy(false);
    }
  }

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
    if (!confirm(`确认取消需求「${req?.title}」？`)) return;
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
      const extra = res.deletedTasks > 0 ? `（含 ${res.deletedTasks} 个任务）` : "";
      toast.success(`已删除此工作${extra}`);
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

  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!req) return <div className="p-6 text-sm text-muted-foreground">需求不存在</div>;

  const stage = statusToStage(req.status);
  const currentStep = statusToStep(req.status);
  const activeStep: ReqStep = selectedStep ?? currentStep;
  const isTerminal = TERMINAL_STATUSES.has(req.status);
  const openQuestions = questions.filter((q) => q.status === "open");
  const resolvedQuestions = questions.filter((q) => q.status === "resolved");
  // spec 在澄清/待发期是主角（频繁读写），其余阶段降为侧栏只读参照。
  const specInMain = stage === "clarify" || stage === "ready";

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
          <span className="text-sm font-medium">需求规约</span>
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
          {!editingSpec && (
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
              placeholder="在这里填写需求详细规约（支持 Markdown 格式）…"
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
              <span className="italic text-muted-foreground text-sm">暂无规约内容，点「编辑」添加。</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );

  const subPrCard = subPrs.length > 0 ? (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">关联子 PR</span>
        <Badge variant="secondary">{subPrs.length}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {subPrs.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-4 py-2 font-mono text-xs">
            <span className="text-muted-foreground">{p.child_workspace_id}</span>
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

  const feedbackCard = (feedbacks.length > 0 || req.status === "awaiting_review" || req.status === "fix_revision") ? (
    <Card id="feedback-section">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">反馈历史</span>
        {feedbacks.length > 0 && (
          <Badge variant="muted" className="ml-auto">{feedbacks.length}</Badge>
        )}
      </div>
      <div className="p-5">
        {feedbacks.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">等待 PR review 反馈…</p>
        ) : (
          <ol className="space-y-3">
            {feedbacks.map((fb) => (
              <li key={fb.id} className="border-l-2 border-accent/60 pl-3">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{SOURCE_LABEL[fb.source] ?? fb.source}</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {new Date(fb.created_at).toLocaleString()}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                  {fb.body}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  ) : null;

  // 执行视图：展开常驻（带标题头），所有阶段一致呈现，不折叠
  const taskRecord = req.task_id ? (
    <Card>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">执行记录</span>
        <span className="font-mono text-[10px] text-muted-foreground">TASK {req.task_id.slice(0, 8)}…</span>
      </div>
      <div className="p-5">
        <TaskDetail key={req.task_id ?? "none"} taskId={req.task_id} embedded subscribe={subscribe} />
      </div>
    </Card>
  ) : null;

  // 澄清期 AI 状态行（出错 / 进度 / idle 三选一）
  const clarifierStatus = (
    <>
      {req.clarifier_error && req.status === "clarifying" && (
        <Card className="p-5 border-l-4 border-l-destructive">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="font-mono text-xs text-destructive font-medium">⚠ 澄清出错</div>
              <p className="text-sm text-muted-foreground break-words">{req.clarifier_error}</p>
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
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
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
              className="h-auto break-words py-1.5 font-display text-2xl font-bold leading-tight sm:text-3xl"
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
          <div className="flex items-start gap-2">
            <h1 className="break-words font-display text-3xl font-bold leading-[1.1] sm:text-4xl">
              {req.title}
            </h1>
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
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={STATUS_VARIANT[req.status] ?? "outline"}>
            {STATUS_LABEL[req.status] ?? req.status}
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
          {req.task_id && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              TASK {req.task_id.slice(0, 8)}…
            </span>
          )}
        </div>
      </header>

      {/* 步骤进度条：6 步可点击，默认当前步 */}
      <div className="mb-5 rounded-lg border border-border bg-card/40 px-4 py-3">
        <StepBar status={req.status} selected={activeStep} onSelect={setSelectedStep} />
      </div>

      {/* 下一步主 CTA banner */}
      <NextStepCTA
        status={req.status}
        openQuestionCount={openQuestions.length}
        busy={actionBusy}
        onMarkReady={markReady}
        onEnqueue={enqueue}
        onApprove={approve}
        onRetry={() => void retryFromFailed()}
        onScrollToQuestions={() => scrollToSection("clarification-section")}
        onScrollToFeedback={() => scrollToSection("feedback-section")}
      />

      {/* 主体：主区（当前阶段内容）+ 侧栏（常驻锚点） */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 主区：随选中步骤切换；过去步只读，未到达占位 */}
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {activeStep !== currentStep && (
            <button
              type="button"
              onClick={() => setSelectedStep(currentStep)}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              ↩ 回到当前步骤（{STEPS.find((s) => s.key === currentStep)?.label}）
            </button>
          )}

          {(() => {
            const pos = stepPosition(activeStep, currentStep);
            if (pos === "future") {
              const label = STEPS.find((s) => s.key === activeStep)?.label ?? "";
              return (
                <Card className="p-6 text-center text-sm text-muted-foreground">
                  「{label}」尚未开始。完成前序步骤后会进入这一步。
                </Card>
              );
            }
            const readonly = pos === "past";

            if (activeStep === "clarify") {
              return (
                <>
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
                </>
              );
            }

            if (activeStep === "approve") {
              return (
                <>
                  {req.schedule_error && (
                    <Card className="border-l-4 border-l-destructive p-4">
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
                  {specCard}
                  {!readonly && req.status === "awaiting_approval" && (
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
              );
            }

            if (activeStep === "queue") {
              return (
                <>
                  {specCard}
                  {taskRecord}
                  {!readonly && req.status === "queued" && (
                    <Button variant="outline" className="w-full" size="sm" onClick={recallToReady} disabled={actionBusy}>
                      {actionBusy ? "处理中…" : "撤回（返回已澄清）"}
                    </Button>
                  )}
                </>
              );
            }

            if (activeStep === "execute") {
              return (
                <>
                  {subPrCard}
                  {taskRecord}
                  {!readonly && req.status === "fix_revision" && (
                    <Card className="p-5">
                      <p className="mb-2 text-xs text-muted-foreground">修复阶段反馈（注入后 Agent 会据此修改）：</p>
                      <Textarea
                        value={feedbackBody}
                        onChange={(e) => setFeedbackBody(e.target.value)}
                        placeholder="填写修改建议…"
                        className="min-h-[80px] text-xs"
                        disabled={submittingFeedback}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void inject();
                        }}
                      />
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void inject()}
                          disabled={submittingFeedback || !feedbackBody.trim()}
                        >
                          {submittingFeedback ? "提交中…" : "注入反馈"}
                        </Button>
                      </div>
                    </Card>
                  )}
                  {feedbackCard}
                </>
              );
            }

            if (activeStep === "review") {
              return (
                <>
                  {subPrCard}
                  {!readonly && (
                    <Card className="p-5">
                      <p className="mb-2 text-sm font-medium">PR 审查</p>
                      <Textarea
                        value={feedbackBody}
                        onChange={(e) => setFeedbackBody(e.target.value)}
                        placeholder="填写审查意见或修改建议…"
                        className="min-h-[80px] text-xs"
                        disabled={submittingFeedback}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void inject();
                        }}
                      />
                      <div className="mt-2 space-y-2">
                        <Button
                          variant="outline"
                          className="w-full"
                          size="sm"
                          onClick={() => void inject()}
                          disabled={submittingFeedback || !feedbackBody.trim()}
                        >
                          {submittingFeedback ? "提交中…" : "注入反馈"}
                        </Button>
                        <div className="flex gap-2">
                          <Button variant="default" className="flex-1 text-xs" size="sm" onClick={() => void markDone()} disabled={actionBusy}>
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> PR 已合并 · 完成
                          </Button>
                          <Button variant="outline" className="flex-1 text-xs" size="sm" onClick={() => void requestFix()} disabled={actionBusy}>
                            ↩ 要求修改
                          </Button>
                        </div>
                      </div>
                    </Card>
                  )}
                  {taskRecord}
                  {feedbackCard}
                </>
              );
            }

            // activeStep === "done"
            return (
              <>
                <Card className="p-5">
                  {req.status === "done" && (
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
                  )}
                  {req.status === "failed" && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-destructive">执行失败</p>
                      <p className="text-xs text-muted-foreground">可在上方「重新入队执行」重试，或退回草稿改规约。</p>
                    </div>
                  )}
                  {req.status === "cancelled" && <p className="text-sm text-muted-foreground">需求已取消。</p>}
                  {req.status !== "done" && req.status !== "failed" && req.status !== "cancelled" && (
                    <p className="text-sm text-muted-foreground">尚未结束。</p>
                  )}
                </Card>
                {subPrCard}
                {taskRecord}
                {feedbackCard}
              </>
            );
          })()}
        </div>

        {/* 侧栏：常驻锚点（元信息 + 非主区时的 spec + 危险区） */}
        <aside className="space-y-4 min-w-0">
          <div className="w-full rounded-lg border border-border bg-card/40 text-[13px]">
            <MetaRow k="ID" v={<code className="font-mono text-accent">{req.id}</code>} />
            {project && (
              <MetaRow k="项目" v={<code className="text-foreground">{project.name}</code>} />
            )}
            <MetaRow
              k="工作区"
              v={
                req.workspace_id
                  ? (projectCodebases.find((cb) => cb.id === req.workspace_id)?.alias ?? req.workspace_id)
                  : <span className="text-muted-foreground">未关联</span>
              }
            />
            <MetaRow k="状态" v={STATUS_LABEL[req.status] ?? req.status} />
            <MetaRow
              k="创建"
              v={<span className="font-mono text-[11px] text-muted-foreground">{new Date(req.created_at).toLocaleString()}</span>}
            />
            <MetaRow
              k="更新"
              v={<span className="font-mono text-[11px] text-muted-foreground">{new Date(req.updated_at).toLocaleString()}</span>}
              last
            />
          </div>

          {/* 非澄清/待发期，spec 降到侧栏只读参照 */}
          {!specInMain && specCard}

          {/* 危险区：破坏性操作收进折叠，避免误触与噪音 */}
          <details className="group rounded-lg border border-destructive/30 bg-destructive/5">
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground transition-colors hover:text-destructive [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              <span>危险区</span>
            </summary>
            <div className="space-y-2 border-t border-destructive/20 p-4">
              {!isTerminal && (
                <Button
                  variant="destructive"
                  className="w-full"
                  size="sm"
                  onClick={cancel}
                  disabled={actionBusy}
                >
                  取消需求
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                disabled={actionBusy}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                删除此工作
              </Button>
            </div>
          </details>
        </aside>
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

      {/* 删除此工作确认（需求 + 任务统一删除）*/}
      <ConfirmDialog
        open={deleteOpen}
        title={`删除此工作「${req.title}」？`}
        danger
        confirmText="确认删除"
        message={
          <div className="space-y-2">
            <p>
              将<strong className="text-destructive">永久删除</strong>此需求及其名下全部任务
              （DB 记录、阶段日志、agent 调用、workspace 文件、评论与反馈）。
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
