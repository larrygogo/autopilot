import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Inbox, Plus, RefreshCw, ExternalLink, Layers, X } from "lucide-react";
import { api, type Requirement, type Repo, type Project } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const STATUS_GROUPS = {
  drafts: ["drafting", "clarifying"],
  ready: ["ready"],
  running: ["queued", "running", "awaiting_review", "fix_revision"],
  done: ["done", "cancelled", "failed"],
} as const;

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

const TAB_LABEL: Record<keyof typeof STATUS_GROUPS, string> = {
  drafts: "草稿",
  ready: "已澄清",
  running: "执行中",
  done: "完成",
};

interface FormState {
  repo_id: string;
  title: string;
}

const EMPTY_FORM: FormState = { repo_id: "", title: "" };

export function Requirements() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<keyof typeof STATUS_GROUPS>("drafts");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const projectFilter = searchParams.get("project_id") ?? "";
  const { subscribe } = useWebSocket();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (pid?: string) => {
    const effectivePid = pid ?? projectFilter;
    setLoading(true);
    setLoadError(null);
    try {
      const [r, p, projs] = await Promise.all([
        api.listRequirements(effectivePid ? { project_id: effectivePid } : undefined),
        api.listRepos(),
        api.listProjects(),
      ]);
      setReqs(r);
      setRepos(p);
      setProjects(projs);
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      setLoadError(msg);
      toast.error("加载失败", msg);
    } finally {
      setLoading(false);
    }
  }, [projectFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [projectFilter]); // re-fetch when filter changes

  // WebSocket 订阅：需求状态变化时防抖刷新列表
  useEffect(() => {
    return subscribe("requirement:*", () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void refresh(); }, 300);
    });
  }, [subscribe, refresh]);

  const repoAliasMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of repos) m.set(r.id, r.alias);
    return m;
  }, [repos]);

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const activeProject = projectFilter ? projectMap.get(projectFilter) : undefined;

  function changeProjectFilter(pid: string) {
    if (pid) {
      setSearchParams({ project_id: pid });
    } else {
      setSearchParams({});
    }
  }

  const filtered = reqs.filter((r) =>
    (STATUS_GROUPS[tab] as readonly string[]).includes(r.status),
  );

  function startCreate() {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function closeDialog() {
    if (saving) return;
    setDialogOpen(false);
  }

  async function save() {
    if (!projectFilter && !form.repo_id) {
      toast.error("验证失败", "请选择仓库");
      return;
    }
    if (!form.title.trim()) {
      toast.error("验证失败", "需求标题不能为空");
      return;
    }
    setSaving(true);
    try {
      const body: Parameters<typeof api.createRequirement>[0] = {
        title: form.title.trim(),
      };
      if (projectFilter) body.project_id = projectFilter;
      if (form.repo_id) body.repo_id = form.repo_id;
      const r = await api.createRequirement(body);
      setDialogOpen(false);
      navigate(`/requirements/${r.id}`);
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function cancelReq(r: Requirement) {
    if (!confirm(`确认取消需求「${r.title}」？`)) return;
    setCancellingId(r.id);
    try {
      await api.cancelRequirement(r.id);
      toast.success(`已取消：${r.title}`);
      await refresh();
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    } finally {
      setCancellingId(null);
    }
  }

  const tabKeys = Object.keys(STATUS_GROUPS) as (keyof typeof STATUS_GROUPS)[];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">需求池</h2>
          <p className="text-sm text-muted-foreground">
            管理待开发需求，从草稿到执行全流程追踪。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            刷新
          </Button>
          <Button size="sm" onClick={startCreate}>
            <Plus className="h-4 w-4" />
            新建需求
          </Button>
        </div>
      </div>

      {/* 项目筛选栏 */}
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
        <select
          value={projectFilter}
          onChange={(e) => changeProjectFilter(e.target.value)}
          className={cn(
            "h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {activeProject && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => changeProjectFilter("")}
            title="清除筛选"
          >
            <X className="h-3.5 w-3.5" />
            清除
          </button>
        )}
        {activeProject && (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => navigate(`/projects/${activeProject.id}`)}
          >
            查看项目工作台
          </button>
        )}
      </div>

      {loadError && (
        <Card className="border-destructive/50 p-4">
          <p className="text-sm text-destructive">加载失败：{loadError}</p>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as keyof typeof STATUS_GROUPS)}>
        <TabsList>
          {tabKeys.map((key) => {
            const count = reqs.filter((r) =>
              (STATUS_GROUPS[key] as readonly string[]).includes(r.status),
            ).length;
            return (
              <TabsTrigger key={key} value={key}>
                {TAB_LABEL[key]}
                {count > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {tabKeys.map((key) => (
          <TabsContent key={key} value={key}>
            {!loading && filtered.length === 0 && key === tab && (
              <Card className="p-8 text-center">
                <Inbox className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {key === "drafts"
                    ? "暂无草稿需求，点「新建需求」开始。"
                    : `暂无${TAB_LABEL[key]}需求。`}
                </p>
              </Card>
            )}

            {filtered.length > 0 && key === tab && (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">标题</th>
                        {!projectFilter && (
                          <th className="px-4 py-2.5 font-medium">项目</th>
                        )}
                        <th className="px-4 py-2.5 font-medium">仓库</th>
                        <th className="px-4 py-2.5 font-medium">状态</th>
                        <th className="px-4 py-2.5 font-medium">PR</th>
                        <th className="px-4 py-2.5 font-medium">关联任务</th>
                        <th className="px-4 py-2.5 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((req, idx) => (
                        <tr
                          key={req.id}
                          className={cn(
                            "border-b last:border-0 transition-colors hover:bg-muted/30",
                            idx % 2 === 1 && "bg-muted/10",
                          )}
                        >
                          <td className="px-4 py-2.5 max-w-[240px]">
                            <span
                              className="block truncate font-medium"
                              title={req.title}
                            >
                              {req.title}
                            </span>
                          </td>
                          {!projectFilter && (
                            <td className="px-4 py-2.5">
                              {req.project_id ? (
                                <button
                                  type="button"
                                  className="text-xs text-primary hover:underline truncate max-w-[120px] block"
                                  title={projectMap.get(req.project_id)?.name}
                                  onClick={() => changeProjectFilter(req.project_id!)}
                                >
                                  {projectMap.get(req.project_id)?.name ?? req.project_id}
                                </button>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          )}
                          <td className="px-4 py-2.5">
                            <span className="font-mono text-xs text-muted-foreground">
                              {repoAliasMap.get(req.repo_id ?? "") ?? req.repo_id ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge
                              variant={STATUS_VARIANT[req.status] ?? "outline"}
                              className="text-[11px] font-normal"
                            >
                              {STATUS_LABEL[req.status] ?? req.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5">
                            {req.pr_url ? (
                              <a
                                href={req.pr_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                #{req.pr_number}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {req.task_id ? (
                              <button
                                type="button"
                                className="text-xs text-primary hover:underline font-mono"
                                onClick={() => navigate(`/tasks/${req.task_id}`)}
                              >
                                {req.task_id.slice(0, 8)}…
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => navigate(`/requirements/${req.id}`)}
                              >
                                查看
                              </Button>
                              {!["done", "cancelled", "failed"].includes(req.status) && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                  onClick={() => void cancelReq(req)}
                                  disabled={cancellingId === req.id}
                                >
                                  取消
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建需求</DialogTitle>
            <DialogDescription>
              {activeProject
                ? `在项目「${activeProject.name}」下创建需求，仓库可选填。`
                : "选择目标仓库并填写需求标题，创建后可继续补充详情。"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {activeProject && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                所属项目：<span className="font-medium text-foreground">{activeProject.name}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="req-repo">
                仓库{!activeProject && <span className="text-destructive"> *</span>}
                {activeProject && <span className="text-muted-foreground text-xs ml-1">（可选）</span>}
              </Label>
              {repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {activeProject
                    ? "暂无仓库，可不选仓库直接创建。"
                    : "暂无仓库，请先在「仓库」页面添加仓库。"}
                </p>
              ) : (
                <select
                  id="req-repo"
                  value={form.repo_id}
                  onChange={(e) => setForm((f) => ({ ...f, repo_id: e.target.value }))}
                  className={cn(
                    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  <option value="">{activeProject ? "不绑定仓库…" : "请选择仓库…"}</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.alias}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="req-title">
                需求标题 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="req-title"
                placeholder="例如：实现用户登录功能"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) void save();
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              取消
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saving || (!activeProject && repos.length === 0)}
            >
              {saving ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
