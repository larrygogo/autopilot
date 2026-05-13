import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare, CheckCircle2, Send, Wifi, WifiOff, Loader2 } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type Repo, type RequirementSubPr, type Question, type Project, type Codebase } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { TaskProgressCard } from "@/components/TaskProgressCard";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

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
        !last && "border-b border-dashed border-foreground/25",
      )}
    >
      <div className="border-r border-dashed border-foreground/25 bg-muted/50 px-3 py-1.5 uppercase tracking-[0.18em] text-muted-foreground">
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

export function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const { subscribe, state: wsState } = useWebSocket();

  const [req, setReq] = useState<Requirement | null>(null);
  const [feedbacks, setFeedbacks] = useState<RequirementFeedback[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState("");
  const [savingSpec, setSavingSpec] = useState(false);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [subPrs, setSubPrs] = useState<RequirementSubPr[]>([]);
  // 回复输入状态：qid → 文本
  const [projectCodebases, setProjectCodebases] = useState<Codebase[]>([]);
  const [codebaseDialogOpen, setCodebaseDialogOpen] = useState(false);
  // Radix Select 不允许 value=""（空串保留给清空 placeholder），用 sentinel 表示"未关联"
  const NONE_VALUE = "__none__";
  const [codebaseDraft, setCodebaseDraft] = useState<string>(NONE_VALUE);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const refresh = useCallback(async function refresh(opts: { silent?: boolean } = {}) {
    if (!id) return;
    if (!opts.silent) setLoading(true);
    try {
      const [data, repoList, sub, qs] = await Promise.all([
        api.getRequirement(id),
        api.listRepos(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
        api.listQuestions(id).catch(() => [] as Question[]),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      // 编辑中不要覆盖用户正在编辑的草稿
      setSpecDraft((prev) => editingSpec ? prev : data.requirement.spec_md);
      setRepos(repoList);
      setSubPrs(sub);
      setQuestions(qs);
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
    return subscribe("requirement:*", (event: { type: string; payload?: { id?: string } }) => {
      const isForThis = event.payload?.id === id;
      if (!isForThis) return;
      if (
        event.type === "requirement:status-changed" ||
        event.type === "requirement:questions-updated" ||
        event.type === "requirement:question-resolved" ||
        event.type === "requirement:active-question-changed" ||
        event.type === "requirement:spec-revised"
      ) {
        void refresh({ silent: true });
      }
    });
  }, [id, subscribe, refresh]);

  useEffect(() => {
    if (!req?.project_id) { setProject(null); setProjectCodebases([]); return; }
    api.getProject(req.project_id).then(setProject).catch(() => setProject(null));
    api.listProjectCodebases(req.project_id).then(setProjectCodebases).catch(() => setProjectCodebases([]));
  }, [req?.project_id]);

  const repoAlias = useMemo(() => {
    if (!req) return "";
    if (!req.repo_id) return "";
    return repos.find((r) => r.id === req.repo_id)?.alias ?? req.repo_id;
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
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "ready");
      await refresh();
      toast.success("已标记为「已澄清」");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function enqueue() {
    if (!id || !req) return;
    if (!req.codebase_id) {
      toast.error("请先关联代码库", "需要绑定代码库才能入队执行，请在下方选择代码库。");
      return;
    }
    setActionBusy(true);
    try {
      await api.enqueueRequirement(id);
      await refresh();
      toast.success("已入队执行");
    } catch (e: unknown) {
      toast.error("入队失败", (e as Error)?.message ?? String(e));
    } finally {
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
    if (!id) return;
    setActionBusy(true);
    try {
      await api.enqueueRequirement(id);
      await refresh();
      toast.success("已审批通过，需求进入队列");
    } catch (e: unknown) {
      toast.error("审批失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function rejectApproval() {
    if (!id) return;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "drafting");
      await refresh();
      toast.success("已驳回，需求返回草稿");
    } catch (e: unknown) {
      toast.error("驳回失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function markDone() {
    if (!id) return;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "done");
      await refresh();
      toast.success("需求已标记完成");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function requestFix() {
    if (!id) return;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "fix_revision");
      await refresh();
      toast.success("已标记需要修改，Agent 将继续修复");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function retryFromFailed() {
    if (!id) return;
    setActionBusy(true);
    try {
      await api.enqueueRequirement(id);
      await refresh();
      toast.success("已重新入队执行");
    } catch (e: unknown) {
      toast.error("重试失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function recallToReady() {
    if (!id) return;
    setActionBusy(true);
    try {
      await api.transitionRequirement(id, "ready");
      await refresh();
      toast.success("已撤回至「已澄清」");
    } catch (e: unknown) {
      toast.error("操作失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function inject() {
    if (!id || !feedbackBody.trim()) return;
    setSubmittingFeedback(true);
    try {
      await api.injectFeedback(id, feedbackBody.trim());
      setFeedbackBody("");
      await refresh();
      toast.success("反馈已提交");
    } catch (e: unknown) {
      toast.error("提交失败", (e as Error)?.message ?? String(e));
    } finally {
      setSubmittingFeedback(false);
    }
  }

  async function cancel() {
    if (!id) return;
    if (!confirm(`确认取消需求「${req?.title}」？`)) return;
    setActionBusy(true);
    try {
      await api.cancelRequirement(id);
      await refresh();
      toast.success("需求已取消");
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteReq() {
    if (!id || !req) return;
    if (!confirm(`确认删除需求「${req.title}」？此操作不可恢复。`)) return;
    setActionBusy(true);
    try {
      await api.deleteRequirement(id);
      toast.success("需求已删除");
      navigate(req.project_id ? `/projects/${req.project_id}` : "/projects");
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
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
        <div className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {wsState === "connected" ? (
            <><Wifi className="h-3 w-3 text-success" />实时</>
          ) : (
            <><WifiOff className="h-3 w-3" />离线</>
          )}
        </div>
      </div>

      {/* Hero 区：需求标题 + metadata block */}
      <header className="mb-6 grid gap-x-8 gap-y-4 border-b-[1.5px] border-foreground/30 pb-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="h-px w-6 bg-foreground/40" aria-hidden="true" />
            <span>REQUIREMENT · {req.id}</span>
            <span className="h-px flex-1 bg-foreground/20" aria-hidden="true" />
          </div>
          <h1 className="break-words font-display text-3xl font-bold uppercase tracking-wider leading-[1.05] sm:text-4xl">
            {req.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={STATUS_VARIANT[req.status] ?? "outline"}>
              {STATUS_LABEL[req.status] ?? req.status}
            </Badge>
            {project && (
              <Link
                to={`/projects/${project.id}`}
                className="font-mono text-[11px] uppercase tracking-wider text-accent hover:underline"
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
                className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-accent hover:underline"
              >
                PR #{req.pr_number}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {req.task_id && (
              <Link
                to={`/tasks/${req.task_id}`}
                className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-accent hover:underline"
              >
                TASK {req.task_id.slice(0, 8)}…
              </Link>
            )}
          </div>
          <div className="mt-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>CREATED {new Date(req.created_at).toLocaleString()}</span>
            <span className="mx-1">·</span>
            <span>UPDATED {new Date(req.updated_at).toLocaleString()}</span>
          </div>
        </div>

        {/* 右侧 metadata block */}
        <div className="flex flex-col gap-3 lg:items-end">
          <div className="w-full border-[1.5px] border-foreground/30 bg-card/40 font-mono text-[11px]">
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
                      className="text-[10px] uppercase tracking-[0.18em] text-accent hover:underline"
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

      {/* 关联子模块 PR */}
      {subPrs.length > 0 && (
        <Card className="mb-6">
          <div className="border-b border-dashed border-foreground/25 px-4 py-2.5 flex items-center justify-between">
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

      {/* AI 正在生成澄清问题（clarifying 且暂无问题） */}
      {req.status === "clarifying" && questions.length === 0 && (
        <Card className="mb-6 p-5">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            AI 正在分析需求，生成澄清问题…
          </div>
        </Card>
      )}

      {/* 澄清对话（chat 气泡风格，方角蓝图）*/}
      {questions.length > 0 && (
        <Card className="mb-6">
          <div className="flex items-center gap-2 border-b border-dashed border-foreground/25 px-4 py-2.5">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="bp-label">需求澄清 · CLARIFICATION</span>
            {openQuestions.length > 0 && (
              <Badge variant="warning" className="ml-auto">{openQuestions.length} 待回复</Badge>
            )}
          </div>

          {/* 对话气泡流 */}
          <div className="space-y-4 p-5">
            {questions.map((q) => (
              <div key={q.id} className="space-y-3">
                {/* AI 气泡 */}
                <div className="flex items-start gap-2.5">
                  <div className="bp-num-block h-7 w-7 text-[10px]">AI</div>
                  <div className="flex-1 space-y-2">
                    <div className={cn(
                      "border-[1.5px] border-foreground/30 bg-muted/50 px-4 py-3 text-sm leading-relaxed",
                      q.status === "resolved" && "opacity-60"
                    )}>
                      {q.agent_text}
                    </div>
                    {/* 建议 chips */}
                    {q.status === "open" && q.suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {q.suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setReplyDrafts(d => ({ ...d, [q.id]: s }))}
                            className="border border-foreground/30 bg-background px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-accent hover:text-accent"
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
                      "max-w-[80%] border-[1.5px] border-accent bg-accent/12 px-4 py-3 text-sm leading-relaxed text-foreground",
                      q.status === "resolved" && "opacity-70"
                    )}>
                      {reply.text}
                    </div>
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center border-[1.5px] border-accent bg-accent text-[10px] font-mono font-bold text-accent-foreground">
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
            ))}
          </div>

          {/*
            AI 思考中 spinner：clarifying 期没有 open question 但已经有 resolved 时显示。
            注意不能用 active_question_id===null 判断 — resolveQuestion 后 active 字段
            仍指向已 resolved 的旧问题，要等 clarifier 跑完 setActiveQuestionId 才会切到
            新 qid 或被 finishClarification 清空。openQuestions.length===0 是更准的"等下一题"信号。
            AI 创建新 question 后 openQuestions=1，spinner 消失，显示新问题。
          */}
          {req.status === "clarifying" && openQuestions.length === 0 &&
           resolvedQuestions.length > 0 && (
            <div className="mx-5 mb-5 flex items-center gap-3 border-[1.5px] border-dashed border-foreground/30 bg-card/40 px-4 py-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                AI 正在思考下一个问题…
              </p>
            </div>
          )}
        </Card>
      )}

      {/* 主体：左右两栏 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：需求规约 */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-dashed border-foreground/25 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="bp-label">需求规约 · SPEC</span>
                {req.spec_md && (req.status === "clarifying" || req.status === "drafting") && (
                  <Badge variant="info">AI 整理</Badge>
                )}
              </div>
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
                <pre className="scrollbar-thin max-h-[600px] overflow-auto whitespace-pre-wrap break-words border border-foreground/20 bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                  {req.spec_md || (
                    <span className="italic text-muted-foreground">暂无规约内容，点「编辑」添加。</span>
                  )}
                </pre>
              )}
            </div>
          </Card>
        </div>

        {/* 右：操作 + 反馈历史 */}
        <div className="space-y-4">
          {/* 操作按钮区 */}
          <Card>
            <div className="border-b border-dashed border-foreground/25 px-4 py-2.5">
              <span className="bp-label">操作 · ACTIONS</span>
            </div>
            <div className="space-y-3 p-5">
              {(req.status === "drafting" || req.status === "clarifying") && (
                <Button
                  className="w-full"
                  size="sm"
                  onClick={markReady}
                  disabled={actionBusy}
                >
                  {actionBusy ? "处理中…" : "标记为已澄清"}
                </Button>
              )}
              {req.status === "ready" && (
                <Button
                  className="w-full"
                  size="sm"
                  onClick={enqueue}
                  disabled={actionBusy}
                >
                  {actionBusy ? "处理中…" : "入队执行"}
                </Button>
              )}
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
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">请审阅规约后决定：</p>
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={approve}
                    disabled={actionBusy}
                  >
                    {actionBusy ? "处理中…" : "✓ 审批通过，入队执行"}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    onClick={rejectApproval}
                    disabled={actionBusy}
                  >
                    {actionBusy ? "处理中…" : "↩ 驳回，返回草稿"}
                  </Button>
                </div>
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
              {req.status === "failed" && (
                <Button
                  className="w-full"
                  size="sm"
                  onClick={() => void retryFromFailed()}
                  disabled={actionBusy}
                >
                  {actionBusy ? "处理中…" : "重新入队执行"}
                </Button>
              )}
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
            <Card>
              <div className="flex items-center gap-2 border-b border-dashed border-foreground/25 px-4 py-2.5">
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
                  <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
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
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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

      {/* 修改代码库关联 dialog */}
      <Dialog open={codebaseDialogOpen} onOpenChange={setCodebaseDialogOpen}>
        <DialogContent className="rounded-none">
          <DialogHeader>
            <DialogTitle>修改代码库关联</DialogTitle>
            <DialogDescription>
              切换此需求关联的代码库。提交后不可立即撤销，请确认。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={codebaseDraft} onValueChange={setCodebaseDraft}>
              <SelectTrigger className="rounded-none">
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
