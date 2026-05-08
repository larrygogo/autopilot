import React, { useEffect, useState, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare, CheckCircle2, Send } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type Repo, type RequirementSubPr, type Question, type Project } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  drafting: "outline",
  clarifying: "secondary",
  investigating: "secondary",
  awaiting_approval: "default",
  ready: "default",
  queued: "secondary",
  running: "default",
  awaiting_review: "secondary",
  fix_revision: "secondary",
  done: "default",
  cancelled: "outline",
  failed: "destructive",
};

const TERMINAL_STATUSES = new Set(["done", "cancelled", "failed"]);

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  github_review: "GitHub Review",
};

export function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

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
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const [data, repoList, sub, qs] = await Promise.all([
        api.getRequirement(id),
        api.listRepos(),
        api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
        api.listQuestions(id).catch(() => [] as Question[]),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      setSpecDraft(data.requirement.spec_md);
      setRepos(repoList);
      setSubPrs(sub);
      setQuestions(qs);
    } catch (e: unknown) {
      toast.error("加载失败", (e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  useEffect(() => {
    if (!req?.project_id) { setProject(null); return; }
    api.getProject(req.project_id).then(setProject).catch(() => setProject(null));
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
    if (!id) return;
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
      await api.transitionRequirement(id, "investigating");
      await refresh();
      toast.success("已驳回，需求返回调查阶段");
    } catch (e: unknown) {
      toast.error("驳回失败", (e as Error)?.message ?? String(e));
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

  async function submitReply(qid: string) {
    if (!id) return;
    const text = (replyDrafts[qid] ?? "").trim();
    if (!text) return;
    setReplyingId(qid);
    try {
      await api.addQuestionReply(id, qid, { author_role: "user", text });
      setReplyDrafts((d) => ({ ...d, [qid]: "" }));
      await refresh();
      toast.success("回复已提交");
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
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/requirements")}
          className="-ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </Button>
      </div>

      {/* Meta 区 */}
      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">{req.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {project && (
                <>
                  <Link
                    to={`/projects/${project.id}`}
                    className="text-xs text-primary hover:underline font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {project.name}
                  </Link>
                  <span className="text-muted-foreground">·</span>
                </>
              )}
              {repoAlias && (
                <>
                  <span className="text-muted-foreground font-mono text-xs">{repoAlias}</span>
                  <span className="text-muted-foreground">·</span>
                </>
              )}
              <Badge
                variant={STATUS_VARIANT[req.status] ?? "outline"}
                className="text-[11px] font-normal"
              >
                {STATUS_LABEL[req.status] ?? req.status}
              </Badge>
              {req.pr_url && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <a
                    href={req.pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    PR #{req.pr_number}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {req.task_id && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <Link
                    to={`/tasks/${req.task_id}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-mono"
                  >
                    任务 {req.task_id.slice(0, 8)}…
                  </Link>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>创建于 {new Date(req.created_at).toLocaleString()}</span>
              <span className="mx-1">·</span>
              <span>更新于 {new Date(req.updated_at).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* 关联子模块 PR */}
      {subPrs.length > 0 && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 text-sm font-semibold">
            关联子模块 PR <span className="text-muted-foreground font-normal">（{subPrs.length}）</span>
          </h2>
          <ul className="space-y-2">
            {subPrs.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono font-medium text-muted-foreground">
                  {p.child_repo_id}
                </span>
                <span className="text-muted-foreground">·</span>
                <a
                  href={p.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                >
                  PR #{p.pr_number}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 评论线程（调查中 / 有问题时显示）*/}
      {questions.length > 0 && (
        <Card className="mb-6 p-5">
          <div className="mb-4 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Agent 提问</h2>
            {openQuestions.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {openQuestions.length} 待回复
              </Badge>
            )}
          </div>
          <div className="space-y-5">
            {questions.map((q) => (
              <div key={q.id} className={cn("rounded-lg border p-4", q.status === "resolved" && "opacity-60")}>
                {/* 问题文本 */}
                <div className="mb-3 flex items-start justify-between gap-2">
                  <p className="text-sm font-medium leading-relaxed">{q.agent_text}</p>
                  {q.status === "open" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                      onClick={() => resolveQ(q.id)}
                      disabled={resolvingId === q.id}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      {resolvingId === q.id ? "处理中…" : "标记已解决"}
                    </Button>
                  )}
                  {q.status === "resolved" && (
                    <Badge variant="outline" className="text-[10px] shrink-0">已解决</Badge>
                  )}
                </div>

                {/* 回复列表 */}
                {q.replies && q.replies.length > 0 && (
                  <div className="mb-3 space-y-2 border-l-2 border-muted pl-3">
                    {q.replies.map((reply) => (
                      <div key={reply.id} className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={reply.author_role === "user" ? "default" : "secondary"}
                            className="text-[10px] font-normal h-4 px-1.5"
                          >
                            {reply.author_role === "user" ? "你" : "Agent"}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(reply.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed text-foreground">{reply.text}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* 回复输入框（仅 open 状态） */}
                {q.status === "open" && (
                  <div className="flex items-end gap-2">
                    <Textarea
                      value={replyDrafts[q.id] ?? ""}
                      onChange={(e) =>
                        setReplyDrafts((d) => ({ ...d, [q.id]: e.target.value }))
                      }
                      placeholder="回复 Agent 的提问…"
                      className="min-h-[60px] flex-1 text-xs"
                      disabled={replyingId === q.id}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitReply(q.id);
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => void submitReply(q.id)}
                      disabled={replyingId === q.id || !(replyDrafts[q.id] ?? "").trim()}
                      className="shrink-0"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {replyingId === q.id ? "发送中…" : "回复"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {resolvedQuestions.length > 0 && openQuestions.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">所有问题已解决。</p>
          )}
        </Card>
      )}

      {/* 主体：左右两栏 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：需求规约 */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">需求规约</h2>
              {!editingSpec && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => {
                    setSpecDraft(req.spec_md);
                    setEditingSpec(true);
                  }}
                >
                  编辑
                </Button>
              )}
            </div>
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
              <pre className="scrollbar-thin max-h-[600px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                {req.spec_md || (
                  <span className="text-muted-foreground italic">暂无规约内容，点「编辑」添加。</span>
                )}
              </pre>
            )}
          </Card>
        </div>

        {/* 右：操作 + 反馈历史 */}
        <div className="space-y-4">
          {/* 操作按钮区 */}
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">操作</h2>
            <div className="space-y-3">
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
              {req.status === "awaiting_approval" && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Agent 调查完成，请审阅后决定：</p>
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
                    {actionBusy ? "处理中…" : "↩ 驳回，返回调查"}
                  </Button>
                </div>
              )}
              {req.status === "awaiting_review" && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">注入反馈（供 agent 参考）：</p>
                  <Textarea
                    value={feedbackBody}
                    onChange={(e) => setFeedbackBody(e.target.value)}
                    placeholder="填写审查意见或修改建议…"
                    className="min-h-[80px] text-xs"
                    disabled={submittingFeedback}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) inject();
                    }}
                  />
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={inject}
                    disabled={submittingFeedback || !feedbackBody.trim()}
                  >
                    {submittingFeedback ? "提交中…" : "提交反馈"}
                  </Button>
                </div>
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
            </div>
          </Card>

          {/* 反馈历史时间线 */}
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">反馈历史</h2>
              {feedbacks.length > 0 && (
                <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                  {feedbacks.length}
                </span>
              )}
            </div>
            {feedbacks.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无反馈记录。</p>
            ) : (
              <ol className="space-y-3">
                {feedbacks.map((fb) => (
                  <li key={fb.id} className="border-l-2 border-muted pl-3">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] font-normal h-4 px-1.5">
                        {SOURCE_LABEL[fb.source] ?? fb.source}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(fb.created_at).toLocaleString()}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground leading-relaxed">
                      {fb.body}
                    </pre>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
