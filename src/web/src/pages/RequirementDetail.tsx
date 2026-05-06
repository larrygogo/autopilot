import React, { useEffect, useState, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Clock, MessageSquare } from "lucide-react";
import { api, type Requirement, type RequirementFeedback, type Repo } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";

const STATUS_LABEL: Record<string, string> = {
  drafting: "草稿",
  clarifying: "澄清中",
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
  const [loading, setLoading] = useState(true);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState("");
  const [savingSpec, setSavingSpec] = useState(false);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const [data, repoList] = await Promise.all([
        api.getRequirement(id),
        api.listRepos(),
      ]);
      setReq(data.requirement);
      setFeedbacks(data.feedbacks);
      setSpecDraft(data.requirement.spec_md);
      setRepos(repoList);
    } catch (e: unknown) {
      toast.error("加载失败", (e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const repoAlias = useMemo(() => {
    if (!req) return "";
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

  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!req) return <div className="p-6 text-sm text-muted-foreground">需求不存在</div>;

  const isTerminal = TERMINAL_STATUSES.has(req.status);

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
              <span className="text-muted-foreground font-mono text-xs">{repoAlias}</span>
              <span className="text-muted-foreground">·</span>
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
