import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare, CheckCircle2, Send, Wifi, WifiOff, Loader2, ChevronRight, Settings2 } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type RequirementSubPr, type Question, type Project, type Codebase, type ProviderItem, type ClarifierRoundState } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { TaskProgressCard } from "@/components/TaskProgressCard";
import { RequirementProgressBar } from "@/components/RequirementProgressBar";
import { NextStepCTA } from "@/components/NextStepCTA";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
        "grid grid-cols-[100px_1fr]",
        !last && "border-b border-dashed border-border",
      )}
    >
      <div className="border-r border-dashed border-border bg-muted/50 px-3 py-1.5 text-muted-foreground">
        {k}
      </div>
      <div className="px-3 py-1.5 text-foreground">{v}</div>
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
        <div className="bp-num-block h-7 w-7 text-[10px]">AI</div>
        <div className="flex-1 space-y-2">
          <div className={cn(
            "border border-border bg-muted/50 px-4 py-3 text-sm leading-relaxed",
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
                  className="border border-border bg-background px-3 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
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
            "max-w-[80%] border border-accent bg-accent/12 px-4 py-3 text-sm leading-relaxed text-foreground",
            q.status === "resolved" && "opacity-70"
          )}>
            {reply.text}
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-accent bg-accent text-[10px] font-mono font-bold text-accent-foreground">
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
    <Card className="mb-6 p-5">
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
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground bg-muted/20 p-2 max-h-[400px] overflow-y-auto rounded-md border border-dashed border-border">
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
  const [repos, setRepos] = useState<Codebase[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState("");
  const [savingSpec, setSavingSpec] = useState(false);
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
  const [projectCodebases, setProjectCodebases] = useState<Codebase[]>([]);
  const [codebaseDialogOpen, setCodebaseDialogOpen] = useState(false);
  const [clarifierDialogOpen, setClarifierDialogOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  // Radix Select 不允许 value=""（空串保留给清空 placeholder），用 sentinel 表示"未关联"
  const NONE_VALUE = "__none__";
  const [codebaseDraft, setCodebaseDraft] = useState<string>(NONE_VALUE);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [retryingClarify, setRetryingClarify] = useState(false);
  const [round, setRound] = useState<ClarifierRoundState | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const refresh = useCallback(async function refresh(opts: { silent?: boolean } = {}) {
    if (!id) return;
    if (!opts.silent) setLoading(true);
    try {
      const [data, repoList, sub, qs, rd] = await Promise.all([
        api.getRequirement(id),
        api.listCodebases(),
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
    api.listProjectCodebases(req.project_id).then(setProjectCodebases).catch(() => setProjectCodebases([]));
  }, [req?.project_id]);

  const repoAlias = useMemo(() => {
    if (!req) return "";
    if (!req.codebase_id) return "";
    return repos.find((r) => r.id === req.codebase_id)?.alias ?? req.codebase_id;
  }, [repos, req]);

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
    if (!req.codebase_id) {
      toast.error("请先关联代码库", "需要绑定代码库才能入队执行，请在下方选择代码库。");
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

  async function setCodebase(codebaseId: string | null) {
    if (!id || !req) return;
    const prev = req;
    setReq({ ...req, codebase_id: codebaseId });
    try {
      await api.updateRequirement(id, { codebase_id: codebaseId });
      toast.success(codebaseId ? "代码库已关联" : "已取消关联代码库");
    } catch (e: unknown) {
      setReq(prev);
      toast.error("关联失败", (e as Error)?.message ?? String(e));
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
    if (!confirm(`确认删除需求「${req.title}」？此操作不可恢复。`)) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      await api.deleteRequirement(id);
      toast.success("需求已删除");
      navigate(req.project_id ? `/projects/${req.project_id}` : "/projects");
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
      busyRef.current = false;
      setActionBusy(false);
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

  const isTerminal = TERMINAL_STATUSES.has(req.status);
  const openQuestions = questions.filter((q) => q.status === "open");
  const resolvedQuestions = questions.filter((q) => q.status === "resolved");

  /** 滚到某个锚点（NextStepCTA 在 awaiting_review/fix_revision 时跳反馈区、有未答问题时跳问答区） */
  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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

      {/* Hero 区：需求标题 + metadata block */}
      <header className="mb-6 grid gap-x-8 gap-y-4 border-b border-border pb-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
            <span className="h-px w-6 bg-foreground/40" aria-hidden="true" />
            <span>REQUIREMENT · {req.id}</span>
            <span className="h-px flex-1 bg-foreground/20" aria-hidden="true" />
          </div>
          <h1 className="break-words font-display text-3xl font-bold leading-[1.05] sm:text-4xl">
            {req.title}
          </h1>
          <RequirementProgressBar status={req.status} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
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
              <Link
                to={`/tasks/${req.task_id}`}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
              >
                TASK {req.task_id.slice(0, 8)}…
              </Link>
            )}
          </div>
          <div className="mt-3 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>CREATED {new Date(req.created_at).toLocaleString()}</span>
            <span className="mx-1">·</span>
            <span>UPDATED {new Date(req.updated_at).toLocaleString()}</span>
          </div>
        </div>

        {/* 右侧 metadata block */}
        <div className="flex flex-col gap-3 lg:items-end">
          <div className="w-full border border-border bg-card/40 font-mono text-[11px]">
            <MetaRow k="ID" v={<code className="text-accent">{req.id}</code>} />
            {project && (
              <MetaRow
                k="项目"
                v={<code className="text-foreground">{project.name}</code>}
              />
            )}
            <MetaRow
              k="代码库"
              v={
                <div className="flex items-center gap-2">
                  <span className="text-foreground">
                    {req.codebase_id
                      ? (projectCodebases.find(cb => cb.id === req.codebase_id)?.alias ?? req.codebase_id)
                      : <span className="text-muted-foreground">未关联</span>
                    }
                  </span>
                  {projectCodebases.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setCodebaseDraft(req.codebase_id ?? NONE_VALUE);
                        setCodebaseDialogOpen(true);
                      }}
                      className="text-[10px] text-accent hover:underline"
                    >
                      修改
                    </button>
                  )}
                </div>
              }
            />
            <MetaRow k="状态" v={STATUS_LABEL[req.status] ?? req.status} last />
          </div>
        </div>
      </header>

      {/* "下一步"主 CTA banner — 解决用户每次都得在右侧 ACTIONS 卡找下一个按钮的痛点。
          只在用户有可做的下一步动作时显示（queued / running / done / cancelled 不渲染，
          因为这些状态由 TaskProgressCard / 终态文案承担）。 */}
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

      {/* 关联子模块 PR */}
      {subPrs.length > 0 && (
        <Card className="mb-6">
          <div className="border-b border-dashed border-border px-4 py-2.5 flex items-center justify-between">
            <span className="bp-label">关联子 PR · SUB-MODULE PRS</span>
            <Badge variant="secondary">{subPrs.length}</Badge>
          </div>
          <ul className="divide-y divide-dashed divide-foreground/20">
            {subPrs.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2 font-mono text-xs">
                <span className="text-muted-foreground">{p.child_repo_id}</span>
                <span className="ml-auto" />
                <a
                  href={p.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  PR #{p.pr_number}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 任务进度卡片（关联了 task 之后显示） */}
      {req.task_id && <TaskProgressCard taskId={req.task_id} />}

      {/* clarifier 出错（任何阶段都可能发生）— 覆盖 spinner 优先显示 */}
      {req.clarifier_error && req.status === "clarifying" && (
        <Card className="mb-6 p-5 border-l-4 border-l-destructive">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="font-mono text-xs text-destructive font-medium">
                ⚠ 澄清出错
              </div>
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

      {/* AI 进度卡：clarifier 单轮正在跑（preparing / calling-llm / parsing / writing）。
          替换原静态 spinner，给用户实时反馈阶段 + 耗时 + 可折叠 prompt 全文。 */}
      {!req.clarifier_error && req.status === "clarifying" && round && ACTIVE_PHASES.has(round.phase) && (
        <ClarifierProgressCard
          round={round}
          elapsedSec={elapsedSec}
          traceOpen={traceOpen}
          onToggleTrace={() => setTraceOpen((v) => !v)}
        />
      )}

      {/* Idle 兜底（round=null 但仍 clarifying 且暂无问题、没出错时显示）。
          覆盖场景：daemon 刚重启 / WS 断连未补拉 / 本会话首次进入但还没收到 round-update 事件。
          [重试] 按钮兜底：daemon 重启 / WS 断连导致 clarifier-error 事件丢失时，
          用户能主动触发 retry-clarify 而不是干等 spinner。 */}
      {!req.clarifier_error && req.status === "clarifying" && !round && questions.length === 0 && (
        <Card className="mb-6 p-5">
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

      {/* 澄清对话（chat 气泡风格，方角蓝图）只在 drafting/clarifying 期显示。
          其他状态（ready / awaiting_approval / running / done 等）chat 区隐藏，
          PR-B 会重做：把历史问答折叠到 spec 区附近。*/}
      {questions.length > 0 && (req.status === "drafting" || req.status === "clarifying") && (
        <Card className="mb-6" id="clarification-section">
          <div className="flex items-center gap-2 border-b border-dashed border-border px-4 py-2.5">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="bp-label">需求澄清 · CLARIFICATION</span>
            <button
              type="button"
              onClick={() => setClarifierDialogOpen(true)}
              className="ml-2 font-mono text-[10px] text-muted-foreground hover:text-accent inline-flex items-center gap-1"
              title="为此需求配置 clarifier 模型"
            >
              <Settings2 className="h-3 w-3" />
              模型：{req.clarifier_model ?? req.clarifier_provider ?? "全局默认"}
            </button>
            {openQuestions.length > 0 && (
              <Badge variant="warning" className="ml-auto">{openQuestions.length} 待回复</Badge>
            )}
          </div>

          {/* 当前活跃问题（open）— 永远显示，含回复框 */}
          {openQuestions.length > 0 && (
            <div className="space-y-4 p-5">
              {openQuestions.map((q) => renderQuestion(q, {
                replyDrafts,
                setReplyDrafts,
                replyingId,
                submitReply,
              }))}
            </div>
          )}

          {/* 历史问答折叠区 — 默认折叠，点击展开 */}
          {resolvedQuestions.length > 0 && (
            <details className="group border-t border-dashed border-border">
              <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                <span>历史问答 · {resolvedQuestions.length} 条</span>
              </summary>
              <div className="space-y-4 p-5 pt-3">
                {resolvedQuestions.map((q) => renderQuestion(q, {
                  replyDrafts,
                  setReplyDrafts,
                  replyingId,
                  submitReply,
                }))}
              </div>
            </details>
          )}

          {/*
            AI 思考中 spinner：clarifying 期没有 open question 但已经有 resolved 时显示。
            注意不能用 active_question_id===null 判断 — resolveQuestion 后 active 字段
            仍指向已 resolved 的旧问题，要等 clarifier 跑完 setActiveQuestionId 才会切到
            新 qid 或被 finishClarification 清空。openQuestions.length===0 是更准的"等下一题"信号。
            AI 创建新 question 后 openQuestions=1，spinner 消失，显示新问题。
          */}
          {req.status === "clarifying" && openQuestions.length === 0 &&
           resolvedQuestions.length > 0 && (
            <div className="mx-5 mb-5 flex items-center gap-3 border border-dashed border-border bg-card/40 px-4 py-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
              <p className="font-mono text-xs text-muted-foreground">
                AI 正在思考下一个问题…
              </p>
            </div>
          )}

          {/*
            草稿状态 + 有历史问答：用户从审批驳回回来。drafting 不触发 clarifier，
            提示用户主动点 [继续澄清] 切到 clarifying，AI 才会基于历史提下一题。
          */}
          {req.status === "drafting" && resolvedQuestions.length > 0 && (
            <div className="mx-5 mb-5 flex flex-col gap-3 border border-dashed border-border bg-card/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="font-mono text-xs text-muted-foreground">
                草稿状态。点击右侧让 AI 基于以上对话和当前 SPEC 继续澄清。
              </p>
              <Button size="sm" onClick={resumeClarify} disabled={actionBusy} className="shrink-0 self-start sm:self-auto">
                {actionBusy ? "处理中…" : "↻ 继续澄清"}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* 主体：左右两栏 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：需求规约。min-w-0 防 grid 子项被内部长串撑大 */}
        <div className="lg:col-span-2 space-y-4 min-w-0">
          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-dashed border-border px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="bp-label">需求规约 · SPEC</span>
                {req.spec_md && (req.status === "clarifying" || req.status === "drafting") && (
                  <Badge variant="info">AI 整理</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRevisionsOpen(true)}
                  className="font-mono text-[10px] gap-1.5"
                >
                  📜 修订历史
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
                <div className="scrollbar-thin max-h-[600px] overflow-auto border border-border bg-muted/30 p-4">
                  {req.spec_md ? (
                    <MarkdownView content={req.spec_md} />
                  ) : (
                    <span className="italic text-muted-foreground text-sm">暂无规约内容，点「编辑」添加。</span>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* 右：操作 + 反馈历史 */}
        <div className="space-y-4 min-w-0">
          {/* 操作按钮区 */}
          <Card>
            <div className="border-b border-dashed border-border px-4 py-2.5">
              <span className="bp-label">操作 · ACTIONS</span>
            </div>
            <div className="space-y-3 p-5">
              {/* drafting/clarifying：主推由 NextStepCTA 给出（去回答问题 / 标为已澄清）；
                  这里保留 outline 入口让用户跳过 AI 提问直接收尾（备用路径） */}
              {(req.status === "drafting" || req.status === "clarifying") && (
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
              {/* ready 主按钮已删（NextStepCTA "入队执行" 独占） */}
              {req.status === "queued" && (
                <Button
                  variant="outline"
                  className="w-full"
                  size="sm"
                  onClick={recallToReady}
                  disabled={actionBusy}
                >
                  {actionBusy ? "处理中…" : "撤回（返回已澄清）"}
                </Button>
              )}
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
              {(req.status === "awaiting_review" || req.status === "fix_revision") && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {req.status === "awaiting_review" ? "PR 审查操作：" : "修复阶段反馈："}
                  </p>
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
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    onClick={() => void inject()}
                    disabled={submittingFeedback || !feedbackBody.trim()}
                  >
                    {submittingFeedback ? "提交中…" : "注入反馈"}
                  </Button>
                  {req.status === "awaiting_review" && (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1 text-xs"
                        size="sm"
                        onClick={() => void markDone()}
                        disabled={actionBusy}
                      >
                        ✓ PR 已合并
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1 text-xs"
                        size="sm"
                        onClick={() => void requestFix()}
                        disabled={actionBusy}
                      >
                        ↩ 要求修改
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {/* failed 主按钮已删（NextStepCTA "重新入队执行" 独占） */}
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
              {isTerminal && (
                <p className="text-xs text-muted-foreground text-center">需求已终止，无可用操作。</p>
              )}
              {/* 删除按钮：执行中禁用，其余状态均可用 */}
              <Button
                variant="outline"
                className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                size="sm"
                onClick={() => void deleteReq()}
                disabled={actionBusy || req.status === "running" || req.status === "fix_revision"}
                title={req.status === "running" || req.status === "fix_revision" ? "需求正在执行中，请先取消" : undefined}
              >
                删除需求
              </Button>
            </div>
          </Card>

          {/* 反馈历史时间线 — 仅在 PR review 阶段或已有反馈时显示 */}
          {(feedbacks.length > 0 ||
            req.status === "awaiting_review" ||
            req.status === "fix_revision") && (
            <Card id="feedback-section">
              <div className="flex items-center gap-2 border-b border-dashed border-border px-4 py-2.5">
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="bp-label">反馈历史 · FEEDBACK</span>
                {feedbacks.length > 0 && (
                  <Badge variant="muted" className="ml-auto">
                    {feedbacks.length}
                  </Badge>
                )}
              </div>
              <div className="p-5">
                {feedbacks.length === 0 ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    等待 PR review 反馈…
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {feedbacks.map((fb) => (
                      <li key={fb.id} className="border-l-2 border-accent/60 pl-3">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">
                            {SOURCE_LABEL[fb.source] ?? fb.source}
                          </Badge>
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
          )}
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

      {/* 修改代码库关联 dialog */}
      <Dialog open={codebaseDialogOpen} onOpenChange={setCodebaseDialogOpen}>
        <DialogContent className="rounded-md">
          <DialogHeader>
            <DialogTitle>修改代码库关联</DialogTitle>
            <DialogDescription>
              切换此需求关联的代码库。提交后不可立即撤销，请确认。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={codebaseDraft} onValueChange={setCodebaseDraft}>
              <SelectTrigger className="rounded-md">
                <SelectValue placeholder="选择代码库" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>— 未关联 —</SelectItem>
                {projectCodebases.map((cb) => (
                  <SelectItem key={cb.id} value={cb.id}>{cb.alias}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodebaseDialogOpen(false)}>取消</Button>
            <Button
              onClick={async () => {
                await setCodebase(codebaseDraft === NONE_VALUE ? null : codebaseDraft);
                setCodebaseDialogOpen(false);
              }}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
